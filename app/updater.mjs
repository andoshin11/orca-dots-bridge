import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, openSync, closeSync } from "node:fs";
import {
  access,
  constants,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { app, net, shell } from "electron";
import {
  appBundlePath,
  brewCandidates,
  brewUpgradeArgs,
  bundleInfoProblem,
  caskroomCandidates,
  expectedSha256,
  extractedAppPath,
  installerScript,
  installTargetProblem,
  isHomebrewManaged,
  isUpdateTempDir,
  latestReleaseUrl,
  maxAssetBytes,
  nextCheckDelay,
  offeredUpdate,
  parseRelease,
  parseUpdatePrefs,
  releaseArch,
  updateTempPrefix,
} from "./lib.mjs";

// In-app updates for an ad-hoc signed app (no Squirrel). Checks GitHub's latest
// release, then either runs `brew upgrade --cask` (Homebrew installs) or downloads the
// zip, verifies it against the release's SHA256SUMS, the bundle identifier, version and
// code signature, and hands the swap to a detached helper that runs after the app quits.
// Nothing here runs with elevated privileges. See docs/menu-bar-app.md (更新).

const run = promisify(execFile);
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );
const isExecutable = (path) =>
  access(path, constants.X_OK).then(
    () => true,
    () => false,
  );
const isWritable = (path) =>
  access(path, constants.W_OK).then(
    () => true,
    () => false,
  );

const requestHeaders = () => ({
  Accept: "application/vnd.github+json",
  "User-Agent": `Orca-Dots-Bridge/${app.getVersion()}`,
});

async function plistValue(plist, key) {
  const { stdout } = await run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist], {
    timeout: 10_000,
  });
  return stdout.trim();
}

const bundleInfo = async (bundle) => ({
  identifier: await plistValue(join(bundle, "Contents", "Info.plist"), "CFBundleIdentifier"),
  version: await plistValue(join(bundle, "Contents", "Info.plist"), "CFBundleShortVersionString"),
});

/** A short, readable reason for the window; never includes anything secret. */
const message = (error) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

class UpdateError extends Error {
  constructor(code, detail) {
    super(detail ?? code);
    this.code = code;
    this.detail = detail;
  }
}

export function createUpdater({ onChange, isBusy }) {
  const prefsPath = join(app.getPath("userData"), "update.json");
  let prefs = parseUpdatePrefs("");
  let timer;
  let ownIdentifier;
  const status = {
    checking: false,
    available: undefined,
    method: undefined,
    phase: undefined,
    error: undefined,
    detail: undefined,
    notice: undefined,
  };
  const appPath = appBundlePath(process.execPath);

  const savePrefs = async () => {
    await mkdir(dirname(prefsPath), { recursive: true });
    const temp = `${prefsPath}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(prefs, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, prefsPath);
  };

  const caskroomExists = async () => {
    for (const dir of caskroomCandidates) if (await exists(dir)) return true;
    return false;
  };

  async function detectMethod() {
    if (!app.isPackaged || !appPath) return undefined;
    return isHomebrewManaged(appPath, await caskroomExists()) ? "homebrew" : "manual";
  }

  function schedule() {
    clearTimeout(timer);
    timer = undefined;
    if (!app.isPackaged || !prefs.autoCheck) return;
    timer = setTimeout(() => void check(false), nextCheckDelay(prefs.lastCheckedAt, Date.now()));
  }

  async function init() {
    prefs = parseUpdatePrefs(await readFile(prefsPath, "utf8").catch(() => ""));
    status.method = await detectMethod();
    if (appPath)
      ownIdentifier = await bundleInfo(appPath).then(
        (i) => i.identifier,
        () => undefined,
      );
    // The helper reopens the app either way; the version tells whether the swap happened.
    if (prefs.pendingInstall) {
      const { version, tempDir } = prefs.pendingInstall;
      if (version === app.getVersion()) status.notice = "updated";
      else {
        status.error = "install_failed";
        status.detail = (await readFile(join(tempDir, "install.log"), "utf8").catch(() => ""))
          .trim()
          .slice(-1000);
      }
      if (isUpdateTempDir(tempDir, await realpath(tmpdir())))
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      delete prefs.pendingInstall;
      await savePrefs().catch(() => undefined);
    }
    schedule();
  }

  async function check(manual) {
    if (!app.isPackaged || status.checking || status.phase) return;
    status.checking = true;
    if (manual) Object.assign(status, { error: undefined, detail: undefined, notice: undefined });
    onChange();
    try {
      const response = await net.fetch(latestReleaseUrl, {
        headers: requestHeaders(),
        signal: AbortSignal.timeout(15_000),
      });
      // 404: no published release yet.
      const json = response.status === 404 ? undefined : response.ok ? await response.json() : null;
      if (json === null)
        throw new UpdateError(
          [403, 429].includes(response.status) ? "rate_limited" : "check_failed",
          `HTTP ${response.status}`,
        );
      prefs.lastCheckedAt = new Date().toISOString();
      await savePrefs().catch(() => undefined);
      status.available = offeredUpdate(parseRelease(json, process.arch), app.getVersion(), {
        skippedVersion: prefs.skippedVersion,
        manual,
      });
      if (manual && !status.available) status.notice = "up_to_date";
    } catch (error) {
      // Automatic checks stay quiet when offline or rate limited.
      if (manual)
        Object.assign(status, {
          error: error instanceof UpdateError ? error.code : "check_failed",
          detail: message(error),
        });
    } finally {
      status.checking = false;
      onChange();
      schedule();
    }
  }

  async function download(url, target, limit) {
    const response = await net.fetch(url, {
      headers: requestHeaders(),
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!response.ok || !response.body)
      throw new UpdateError("download_failed", `HTTP ${response.status}`);
    const hash = createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > limit) return callback(new UpdateError("download_too_large"));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(target));
    return hash.digest("hex");
  }

  async function loginPath(brew) {
    const loginShell = process.env.SHELL;
    let path = "";
    if (loginShell?.startsWith("/") && (await isExecutable(loginShell)))
      path = await run(loginShell, ["-l", "-c", "/usr/bin/printenv PATH"], { timeout: 10_000 })
        .then(({ stdout }) => stdout.trim().split("\n").pop() ?? "")
        .catch(() => "");
    const entries = [dirname(brew), ...(path || "/usr/bin:/bin:/usr/sbin:/sbin").split(":")];
    return [...new Set(entries.filter((p) => p.startsWith("/")))].join(":");
  }

  async function brewUpgrade() {
    let brew;
    for (const candidate of brewCandidates)
      if (await isExecutable(candidate)) {
        brew = candidate;
        break;
      }
    if (!brew) throw new UpdateError("brew_not_found");
    status.phase = "brew";
    onChange();
    const env = {
      ...process.env,
      PATH: await loginPath(brew),
      HOMEBREW_NO_ENV_HINTS: "1",
      // Refresh the tap first so the new cask version is seen.
      HOMEBREW_AUTO_UPDATE_SECS: "1",
    };
    let output = "";
    const code = await new Promise((resolve) => {
      const child = spawn(brew, brewUpgradeArgs, { env, stdio: ["ignore", "pipe", "pipe"] });
      const killer = setTimeout(() => child.kill("SIGTERM"), 15 * 60_000);
      const collect = (chunk) => {
        output = (output + chunk.toString()).slice(-16_000);
        status.detail = output.trim().split("\n").slice(-6).join("\n");
        onChange();
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.on("error", (error) => {
        output += `\n${message(error)}`;
      });
      child.on("close", (exitCode) => {
        clearTimeout(killer);
        resolve(exitCode);
      });
    });
    const tail = output.trim().split("\n").slice(-20).join("\n");
    if (code !== 0) throw new UpdateError("brew_failed", tail);
    // Homebrew replaced the bundle in /Applications; relaunching starts the new one.
    const installed = await bundleInfo(appPath).catch(() => undefined);
    if (!installed || installed.version === app.getVersion())
      throw new UpdateError("brew_no_change", tail);
    app.relaunch();
    app.exit(0);
  }

  async function manualInstall(release) {
    const problem = installTargetProblem(appPath);
    if (problem) throw new UpdateError(problem, appPath);
    if (!(await isWritable(dirname(appPath))) || !(await isWritable(appPath)))
      throw new UpdateError("not_writable", dirname(appPath));
    const arch = releaseArch(process.arch);
    if (!arch || !ownIdentifier) throw new UpdateError("unsupported");
    const tempDir = await mkdtemp(join(await realpath(tmpdir()), updateTempPrefix));
    try {
      status.phase = "download";
      onChange();
      const sumsPath = join(tempDir, "SHA256SUMS");
      await download(release.sums.url, sumsPath, 64 * 1024);
      const expected = expectedSha256(await readFile(sumsPath, "utf8"), release.zip.name);
      if (!expected) throw new UpdateError("checksum_missing", release.zip.name);
      const zip = join(tempDir, release.zip.name);
      const actual = await download(release.zip.url, zip, maxAssetBytes);
      if (actual !== expected) throw new UpdateError("checksum_mismatch", release.zip.name);

      status.phase = "verify";
      onChange();
      const extractDir = join(tempDir, "extracted");
      await mkdir(extractDir);
      await run("/usr/bin/ditto", ["-x", "-k", zip, extractDir], { timeout: 5 * 60_000 });
      const newApp = extractedAppPath(extractDir, arch);
      const stat = await lstat(newApp).catch(() => undefined);
      if (!stat?.isDirectory() || stat.isSymbolicLink() || (await realpath(newApp)) !== newApp)
        throw new UpdateError("bundle_invalid", newApp);
      const infoProblem = bundleInfoProblem(await bundleInfo(newApp).catch(() => undefined), {
        identifier: ownIdentifier,
        version: release.version,
      });
      if (infoProblem) throw new UpdateError(infoProblem);
      await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", newApp], {
        timeout: 5 * 60_000,
      }).catch((error) => {
        throw new UpdateError("signature_invalid", message(error));
      });
      await rm(zip, { force: true });

      if (isBusy()) throw new UpdateError("busy");
      status.phase = "install";
      onChange();
      const script = join(tempDir, "install.sh");
      await writeFile(script, installerScript, { mode: 0o700 });
      await mkdir(join(tempDir, "previous"));
      prefs.pendingInstall = { version: release.version, tempDir };
      await savePrefs();
      const log = openSync(join(tempDir, "install.log"), "a", 0o600);
      try {
        spawn(
          "/bin/sh",
          [
            script,
            String(process.pid),
            appPath,
            newApp,
            join(tempDir, "previous", "Orca Dots Bridge.app"),
            "1",
          ],
          { detached: true, stdio: ["ignore", log, log] },
        ).unref();
      } finally {
        closeSync(log);
      }
      app.quit();
    } catch (error) {
      delete prefs.pendingInstall;
      await savePrefs().catch(() => undefined);
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async function install() {
    const release = status.available;
    if (!release || status.phase || status.checking) return;
    Object.assign(status, { error: undefined, detail: undefined, notice: undefined });
    try {
      if (isBusy()) throw new UpdateError("busy");
      status.method = await detectMethod();
      if (status.method === "homebrew") await brewUpgrade();
      else if (status.method === "manual") await manualInstall(release);
      else throw new UpdateError("unsupported");
    } catch (error) {
      Object.assign(status, {
        error: error instanceof UpdateError ? error.code : "install_failed",
        detail: error instanceof UpdateError ? error.detail : message(error),
      });
    } finally {
      status.phase = undefined;
      onChange();
    }
  }

  return {
    init,
    check: () => check(true),
    install,
    async skip() {
      if (!status.available) return;
      prefs.skippedVersion = status.available.version;
      status.available = undefined;
      await savePrefs().catch(() => undefined);
      onChange();
    },
    async setAutoCheck(value) {
      prefs.autoCheck = value === true;
      await savePrefs().catch(() => undefined);
      schedule();
      onChange();
    },
    openNotes() {
      if (status.available) void shell.openExternal(status.available.notesUrl);
    },
    state: () => ({
      supported: app.isPackaged && Boolean(appPath),
      currentVersion: app.getVersion(),
      autoCheck: prefs.autoCheck,
      lastCheckedAt: prefs.lastCheckedAt,
      checking: status.checking,
      available: status.available
        ? { version: status.available.version, notesUrl: status.available.notesUrl }
        : undefined,
      method: status.method,
      phase: status.phase,
      error: status.error,
      detail: status.detail,
      notice: status.notice,
      brewCommand: `brew upgrade --cask ${brewUpgradeArgs.at(-1)}`,
    }),
  };
}
