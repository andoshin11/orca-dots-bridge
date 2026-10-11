import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  appBundlePath,
  bundleInfoProblem,
  compareVersions,
  expectedSha256,
  extractedAppPath,
  installerScript,
  installTargetProblem,
  isHomebrewManaged,
  isUpdateTempDir,
  nextCheckDelay,
  offeredUpdate,
  parseRelease,
  parseUpdatePrefs,
  parseVersion,
  referencedRuntimes,
  releaseArch,
  runtimesToPrune,
} from "../app/lib.mjs";

const download = (tag: string, name: string) =>
  `https://github.com/andoshin11/orca-dots-bridge/releases/download/${tag}/${name}`;

function releaseJson(tag = "v0.4.0", overrides: Record<string, unknown> = {}) {
  const version = tag.slice(1);
  const names = [
    `Orca-Dots-Bridge-${version}-mac-arm64.zip`,
    `Orca-Dots-Bridge-${version}-mac-x64.zip`,
    `orca-dots-bridge-${version}.tar.gz`,
    "SHA256SUMS",
  ];
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/andoshin11/orca-dots-bridge/releases/tag/${tag}`,
    assets: names.map((name) => ({
      name,
      browser_download_url: download(tag, name),
      size: 1000,
    })),
    ...overrides,
  };
}

describe("app update: versions", () => {
  test("only plain X.Y.Z versions are compared", () => {
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("1.2.3-beta.1")).toBeUndefined();
    expect(parseVersion("1.2")).toBeUndefined();
    expect(compareVersions("0.3.4", "0.3.10")).toBe(-1);
    expect(compareVersions("v1.0.0", "0.99.99")).toBe(1);
    expect(compareVersions("0.3.4", "v0.3.4")).toBe(0);
    expect(() => compareVersions("0.3.4", "latest")).toThrow("invalid_version");
  });

  test("the zip is picked for this Mac's arch", () => {
    expect(releaseArch("arm64")).toBe("arm64");
    expect(releaseArch("x64")).toBe("x64");
    expect(releaseArch("ia32")).toBeUndefined();
  });
});

describe("app update: release JSON", () => {
  test("a published release yields this arch's zip and SHA256SUMS", () => {
    const release = parseRelease(releaseJson(), "x64");
    expect(release).toEqual({
      version: "0.4.0",
      tag: "v0.4.0",
      notesUrl: "https://github.com/andoshin11/orca-dots-bridge/releases/tag/v0.4.0",
      zip: {
        name: "Orca-Dots-Bridge-0.4.0-mac-x64.zip",
        url: download("v0.4.0", "Orca-Dots-Bridge-0.4.0-mac-x64.zip"),
        size: 1000,
      },
      sums: { name: "SHA256SUMS", url: download("v0.4.0", "SHA256SUMS"), size: 1000 },
    });
  });

  test("drafts, pre-releases, odd tags and foreign URLs are ignored", () => {
    expect(parseRelease(releaseJson("v0.4.0", { draft: true }), "arm64")).toBeUndefined();
    expect(parseRelease(releaseJson("v0.4.0", { prerelease: true }), "arm64")).toBeUndefined();
    expect(parseRelease(releaseJson("v0.4.0-rc.1"), "arm64")).toBeUndefined();
    expect(parseRelease(releaseJson("0.4.0" as string), "arm64")).toBeUndefined();
    expect(parseRelease(null, "arm64")).toBeUndefined();
    expect(parseRelease(releaseJson(), "ia32")).toBeUndefined();
    const foreign = releaseJson();
    foreign.assets[0]!.browser_download_url = "https://example.com/evil.zip";
    expect(parseRelease(foreign, "arm64")).toBeUndefined();
    const noSums = releaseJson();
    noSums.assets = noSums.assets.filter((a) => a.name !== "SHA256SUMS");
    expect(parseRelease(noSums, "arm64")).toBeUndefined();
    const huge = releaseJson();
    huge.assets[0]!.size = 10 * 1024 * 1024 * 1024;
    expect(parseRelease(huge, "arm64")).toBeUndefined();
    // Release notes always open this repository's tag page.
    const elsewhere = releaseJson("v0.4.0", { html_url: "https://example.com" });
    expect(parseRelease(elsewhere, "arm64")?.notesUrl).toBe(
      "https://github.com/andoshin11/orca-dots-bridge/releases/tag/v0.4.0",
    );
  });

  test("only a newer, not skipped version is offered (a manual check ignores the skip)", () => {
    const release = parseRelease(releaseJson(), "arm64");
    expect(offeredUpdate(release, "0.3.4")).toBe(release);
    expect(offeredUpdate(release, "0.4.0")).toBeUndefined();
    expect(offeredUpdate(release, "0.5.0")).toBeUndefined();
    expect(offeredUpdate(release, "0.3.4", { skippedVersion: "0.4.0" })).toBeUndefined();
    expect(offeredUpdate(release, "0.3.4", { skippedVersion: "0.4.0", manual: true })).toBe(
      release,
    );
    expect(offeredUpdate(undefined, "0.3.4")).toBeUndefined();
  });
});

describe("app update: SHA256SUMS", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  test("the exact line for the file is used", () => {
    const sums = `${a}  orca-dots-bridge-0.4.0.tar.gz\n${b}  Orca-Dots-Bridge-0.4.0-mac-arm64.zip\n`;
    expect(expectedSha256(sums, "Orca-Dots-Bridge-0.4.0-mac-arm64.zip")).toBe(b);
    expect(
      expectedSha256(
        `${b} *Orca-Dots-Bridge-0.4.0-mac-arm64.zip\r\n`,
        "Orca-Dots-Bridge-0.4.0-mac-arm64.zip",
      ),
    ).toBe(b);
    expect(expectedSha256(sums, "Orca-Dots-Bridge-0.4.0-mac-x64.zip")).toBeUndefined();
  });

  test("near misses, uppercase hashes and duplicates are refused", () => {
    const name = "Orca-Dots-Bridge-0.4.0-mac-arm64.zip";
    expect(expectedSha256(`${a}  x${name}`, name)).toBeUndefined();
    expect(expectedSha256(`${a}  ${name}.sig`, name)).toBeUndefined();
    expect(expectedSha256(`${a.toUpperCase()}  ${name}`, name)).toBeUndefined();
    expect(expectedSha256(`${a.slice(1)}  ${name}`, name)).toBeUndefined();
    expect(expectedSha256(`${a}  ${name}\n${b}  ${name}`, name)).toBeUndefined();
    expect(expectedSha256(undefined, name)).toBeUndefined();
  });
});

describe("app update: where the app lives", () => {
  const app = "/Applications/Orca Dots Bridge.app";
  test("the bundle is found from Electron's executable", () => {
    expect(appBundlePath(`${app}/Contents/MacOS/Orca Dots Bridge`)).toBe(app);
    expect(appBundlePath("/usr/local/bin/electron")).toBeUndefined();
    expect(appBundlePath(undefined)).toBeUndefined();
  });

  test("Homebrew owns only /Applications/Orca Dots Bridge.app with a Caskroom entry", () => {
    expect(isHomebrewManaged(app, true)).toBe(true);
    expect(isHomebrewManaged(app, false)).toBe(false);
    expect(isHomebrewManaged("/Users/a/Applications/Orca Dots Bridge.app", true)).toBe(false);
    expect(isHomebrewManaged(undefined, true)).toBe(false);
  });

  test("only a plain, untranslocated Orca Dots Bridge.app is replaced in place", () => {
    expect(installTargetProblem(app)).toBeUndefined();
    expect(installTargetProblem("/Users/a/Applications/Orca Dots Bridge.app")).toBeUndefined();
    expect(
      installTargetProblem("/private/var/folders/x/AppTranslocation/ABC/d/Orca Dots Bridge.app"),
    ).toBe("translocated");
    expect(installTargetProblem("/Applications/Other.app")).toBe("unexpected_name");
    expect(installTargetProblem("/Applications/../tmp/Orca Dots Bridge.app")).toBe(
      "not_an_app_bundle",
    );
    expect(installTargetProblem("Orca Dots Bridge.app")).toBe("not_an_app_bundle");
    expect(installTargetProblem(undefined)).toBe("not_an_app_bundle");
  });

  test("the extracted bundle must be this app at the release version", () => {
    expect(extractedAppPath("/t/x", "arm64")).toBe(
      "/t/x/Orca Dots Bridge-darwin-arm64/Orca Dots Bridge.app",
    );
    const expected = { identifier: "dev.orca-dots-bridge.app", version: "0.4.0" };
    expect(bundleInfoProblem({ ...expected }, expected)).toBeUndefined();
    expect(bundleInfoProblem({ ...expected, identifier: "com.example" }, expected)).toBe(
      "identifier_mismatch",
    );
    expect(bundleInfoProblem({ ...expected, version: "0.3.9" }, expected)).toBe("version_mismatch");
    expect(bundleInfoProblem(undefined, expected)).toBe("identifier_mismatch");
  });

  test("only temporary folders this app created are removed later", () => {
    expect(
      isUpdateTempDir("/private/var/t/orca-dots-bridge-update-Ab12Cd", "/private/var/t/"),
    ).toBe(true);
    expect(
      isUpdateTempDir("/private/var/t/orca-dots-bridge-update-Ab12Cd/..", "/private/var/t"),
    ).toBe(false);
    expect(isUpdateTempDir("/private/var/t", "/private/var/t")).toBe(false);
    expect(isUpdateTempDir("/Users/a/orca-dots-bridge-update-Ab12Cd", "/private/var/t")).toBe(
      false,
    );
    expect(isUpdateTempDir(undefined, "/private/var/t")).toBe(false);
  });
});

describe("app update: preferences and timing", () => {
  test("broken or missing preferences fall back to checking automatically", () => {
    expect(parseUpdatePrefs(undefined)).toEqual({ autoCheck: true });
    expect(parseUpdatePrefs("not json")).toEqual({ autoCheck: true });
    expect(
      parseUpdatePrefs(
        JSON.stringify({
          autoCheck: false,
          lastCheckedAt: "2026-10-01T00:00:00.000Z",
          skippedVersion: "0.4.0",
          pendingInstall: { version: "0.4.0", tempDir: "/t/x" },
          extra: 1,
        }),
      ),
    ).toEqual({
      autoCheck: false,
      lastCheckedAt: "2026-10-01T00:00:00.000Z",
      skippedVersion: "0.4.0",
      pendingInstall: { version: "0.4.0", tempDir: "/t/x" },
    });
    expect(
      parseUpdatePrefs(JSON.stringify({ lastCheckedAt: "yesterday", skippedVersion: "latest" })),
    ).toEqual({ autoCheck: true });
  });

  test("the first check waits 30 s, then checks follow 6 hours after the last one", () => {
    const now = Date.parse("2026-10-11T12:00:00Z");
    const hours = (h: number) => new Date(now - h * 3600_000).toISOString();
    expect(nextCheckDelay(undefined, now)).toBe(30_000);
    expect(nextCheckDelay(hours(7), now)).toBe(30_000);
    expect(nextCheckDelay(hours(2), now)).toBe(4 * 3600_000);
    expect(nextCheckDelay(hours(-1), now)).toBe(30_000);
  });
});

describe("app update: old runtimes", () => {
  const plist = (version: string) =>
    `<string>/Users/a/.orca-dots-bridge/runtime/node</string>\n<string>/Users/a/.orca-dots-bridge/runtime/${version}/dist/bridge-service.mjs</string>`;

  test("runtime versions named in managed files are found", () => {
    expect([...referencedRuntimes([plist("0.3.2"), undefined, plist("0.3.4")])].sort()).toEqual([
      "0.3.2",
      "0.3.4",
    ]);
    expect(referencedRuntimes(["/Users/a/.orca-dots-bridge/runtime/node"]).size).toBe(0);
  });

  test("current, previous, referenced, newer and odd folders stay", () => {
    const names = [
      "0.2.0",
      "0.3.0",
      "0.3.10",
      "0.3.2",
      "0.3.3",
      "0.4.0",
      "0.5.0",
      "node",
      "0.3.4.123.tmp",
      "v0.1.0",
    ];
    expect(runtimesToPrune(names, "0.4.0", new Set(["0.3.0"]))).toEqual([
      "0.2.0",
      "0.3.2",
      "0.3.3",
    ]);
    expect(runtimesToPrune(["0.3.4"], "0.3.4", new Set())).toEqual([]);
    expect(runtimesToPrune(["0.3.3", "0.3.4"], "0.3.4", new Set())).toEqual([]);
    expect(runtimesToPrune(["0.1.0"], "dev", new Set())).toEqual([]);
  });
});

describe("app update: installer helper", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function fixture() {
    dir = await mkdtemp(join(tmpdir(), "orca-update-test-"));
    const target = join(dir, "Applications", "Orca Dots Bridge.app");
    const source = join(dir, "new", "Orca Dots Bridge.app");
    await mkdir(join(target, "Contents"), { recursive: true });
    await writeFile(join(target, "Contents", "version"), "old");
    await mkdir(join(source, "Contents"), { recursive: true });
    await writeFile(join(source, "Contents", "version"), "new");
    await mkdir(join(dir, "previous"));
    const script = join(dir, "install.sh");
    await writeFile(script, installerScript);
    // A process that has already exited stands in for the quitting app.
    const done = spawnSync("/usr/bin/true");
    return {
      target,
      source,
      script,
      backup: join(dir, "previous", "Orca Dots Bridge.app"),
      pid: String(done.pid),
    };
  }

  test("swaps the bundle and keeps the old one as a backup", async () => {
    const { target, source, script, backup, pid } = await fixture();
    const result = spawnSync("/bin/sh", [script, pid, target, source, backup, "0"]);
    expect(result.status).toBe(0);
    expect(await readFile(join(target, "Contents", "version"), "utf8")).toBe("new");
    expect(await readFile(join(backup, "Contents", "version"), "utf8")).toBe("old");
  });

  test("restores the old bundle when copying fails", async () => {
    const { target, source, script, backup, pid } = await fixture();
    // An unreadable file makes ditto fail part way through.
    await chmod(join(source, "Contents", "version"), 0o000);
    const result = spawnSync("/bin/sh", [script, pid, target, source, backup, "0"]);
    expect(result.status).toBe(1);
    expect(result.stderr.toString()).toContain("restoring the previous app");
    expect(await readFile(join(target, "Contents", "version"), "utf8")).toBe("old");
    await chmod(join(source, "Contents", "version"), 0o600);
  });

  test("refuses when the new bundle is missing", async () => {
    const { target, script, backup, pid } = await fixture();
    const result = spawnSync("/bin/sh", [script, pid, target, join(dir, "missing"), backup, "0"]);
    expect(result.status).toBe(1);
    expect(await readFile(join(target, "Contents", "version"), "utf8")).toBe("old");
  });

  test("refuses a target that is not Orca Dots Bridge.app", async () => {
    const { source, script, backup, pid } = await fixture();
    const other = join(dir, "Applications", "Other.app");
    await mkdir(other);
    const result = spawnSync("/bin/sh", [script, pid, other, source, backup, "0"]);
    expect(result.status).toBe(1);
    expect(result.stderr.toString()).toContain("unexpected target");
  });
});
