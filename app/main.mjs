import { execFile } from "node:child_process";
import {
  access,
  constants,
  cp,
  lstat,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  Tray,
} from "electron";
import {
  auditViewLimit,
  externalPages,
  formatAuditEntry,
  needsAgentRefresh,
  nodeCandidates,
  overallLevel,
  parseAuditLog,
  parseSetupRequest,
  referencedRuntimes,
  runtimeKeyFromClipboard,
  runtimesToPrune,
  stepLabels,
  trayTitle,
  tunnelIdPattern,
} from "./lib.mjs";
import { createUpdater } from "./updater.mjs";

// Menu bar shell around the bridge's `setup` command: it shows the doctor result,
// runs setup with what a person enters, and keeps an eye on the Tunnel.
// Key material never reaches the renderer; the runtime key goes from the
// clipboard straight into setup.

const run = promisify(execFile);
const appDir = dirname(fileURLToPath(import.meta.url));
const home = homedir();

const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * A release app carries the built bridge in its Resources. The bridge service keeps
 * running from launchd after the app quits and its LaunchAgent is kept free of paths
 * with spaces, so the bridge is copied to ~/.orca-dots-bridge/runtime/<version> and this
 * app's Electron binary is linked there to serve as Node (ELECTRON_RUN_AS_NODE).
 */
async function bundledRuntime() {
  const bundled = join(process.resourcesPath ?? "", "bridge");
  if (!app.isPackaged || !(await exists(join(bundled, "dist", "setup.mjs")))) return undefined;
  const root = join(home, ".orca-dots-bridge", "runtime");
  const target = join(root, app.getVersion());
  if (!(await exists(join(target, "dist", "setup.mjs")))) {
    const temp = `${target}.${process.pid}.tmp`;
    await rm(temp, { recursive: true, force: true });
    await cp(bundled, temp, { recursive: true });
    await rm(target, { recursive: true, force: true });
    await rename(temp, target);
  }
  // Re-point the link when the app has moved (e.g. into /Applications).
  const node = join(root, "node");
  if ((await readlink(node).catch(() => undefined)) !== process.execPath) {
    await unlink(node).catch(() => undefined);
    await symlink(process.execPath, node);
  }
  return { bridge: target, nodePath: node };
}

async function bridgeDir() {
  if (process.env.ORCA_DOTS_BRIDGE_DIR) return process.env.ORCA_DOTS_BRIDGE_DIR;
  // A packaged app records the checkout it was built from (see scripts/package.mjs).
  const recorded = await readFile(join(appDir, "bridge-location.json"), "utf8").catch(() => "");
  if (recorded) return JSON.parse(recorded).bridgeDir;
  return resolve(appDir, "..");
}

const isExecutable = (path) =>
  access(path, constants.X_OK).then(
    () => true,
    () => false,
  );

/** Electron's own execPath is not Node, so the bridge service needs a real Node binary. */
async function resolveNode() {
  const fromShell = await run("/bin/zsh", ["-lc", "command -v node"], { timeout: 5000 })
    .then(({ stdout }) => stdout.trim().split("\n").pop() ?? "")
    .catch(() => "");
  for (const candidate of [process.env.ORCA_DOTS_NODE, fromShell, ...nodeCandidates(home)]) {
    if (!candidate || !candidate.startsWith("/") || !(await isExecutable(candidate))) continue;
    const version = await run(candidate, ["--version"], { timeout: 5000 }).catch(() => undefined);
    if (version && Number(version.stdout.trim().replace(/^v/, "").split(".")[0]) >= 22)
      return candidate;
  }
  return undefined;
}

let setup;
let io;
let usesBundledRuntime = false;
let tray;
let window;
let busy = false;
let updater;
const state = {
  steps: [],
  settings: {},
  nextActions: [],
  checkedAt: undefined,
  tunnelReady: false,
};

function publicState() {
  return {
    ...state,
    level: overallLevel(state.steps),
    busy,
    packaged: app.isPackaged,
    openAtLogin: app.isPackaged ? app.getLoginItemSettings().openAtLogin : false,
    bridgeDir: io ? dirname(io.distDir) : undefined,
    nodePath: io?.nodePath,
    labels: stepLabels,
    update: updater?.state(),
  };
}

function notify() {
  const level = overallLevel(state.steps);
  tray?.setTitle(trayTitle(level, state.tunnelReady));
  tray?.setContextMenu(buildMenu(level));
  window?.webContents.send("state", publicState());
}

async function doctor() {
  const { steps, settings } = await setup.runSetup(io, { mode: "doctor" });
  Object.assign(state, {
    steps,
    settings,
    nextActions: setup.nextActions(steps, settings),
    checkedAt: new Date().toISOString(),
    tunnelReady: steps.some((s) => s.step === "tunnel" && s.status === "ok"),
  });
}

async function exclusive(task) {
  if (busy) throw new Error("busy");
  busy = true;
  notify();
  try {
    return await task();
  } finally {
    busy = false;
    notify();
  }
}

/** Cheap readiness probe for the tray between full doctor runs. */
async function probeTunnel() {
  const base = (await readFile(setup.setupPaths(home).healthUrl, "utf8").catch(() => "")).trim();
  const code = base ? await io.probe(`${base.replace(/\/$/, "")}/readyz`).catch(() => 0) : 0;
  if (state.tunnelReady !== (code === 200)) {
    state.tunnelReady = code === 200;
    notify();
  }
}

async function runSetup(input) {
  const request = parseSetupRequest(input);
  return exclusive(async () => {
    const options = {
      mode: "setup",
      ...request,
      // A bundled runtime or an explicit ORCA_DOTS_NODE replaces a Node recorded in the service LaunchAgent.
      ...(process.env.ORCA_DOTS_NODE || usesBundledRuntime ? { nodePath: io.nodePath } : {}),
    };
    if (request.useClipboardKey) {
      const key = runtimeKeyFromClipboard(clipboard.readText());
      if (!key) return { error: "clipboard_has_no_runtime_key" };
      options.runtimeKey = key;
    }
    let steps;
    try {
      ({ steps } = await setup.runSetup(io, options));
    } finally {
      // Re-check even when setup stopped partway: it may already have moved the services,
      // and the window must not keep showing the state from before the run.
      await doctor().catch(() => undefined);
    }
    // Clear the clipboard only once the key is stored, and only if it still holds that key.
    if (
      runtimeKeyFromClipboard(clipboard.readText()) === options.runtimeKey &&
      options.runtimeKey &&
      steps.some((s) => s.step === "runtime-key" && ["ok", "created", "updated"].includes(s.status))
    )
      clipboard.clear();
    return { steps };
  });
}

async function restartAgent() {
  const uid = process.getuid?.() ?? -1;
  await exclusive(() =>
    run("/bin/launchctl", ["kickstart", "-k", `gui/${uid}/${setup.tunnelLabel}`]),
  );
  setTimeout(() => void probeTunnel(), 5000);
}

function openWindow() {
  if (window) return window.show();
  window = new BrowserWindow({
    width: 760,
    height: 820,
    title: "Orca → dot",
    webPreferences: {
      preload: join(appDir, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.on("closed", () => {
    window = undefined;
  });
  void window.loadFile(join(appDir, "index.html"));
}

function buildMenu(level) {
  const headline = {
    ok: state.tunnelReady ? "dot から状態を確認できます" : "Tunnel を起動中…",
    action: "セットアップが残っています",
    error: "エラーがあります",
  }[level];
  const line = (name) => {
    const step = state.steps.find((s) => s.step === name);
    return { label: `${stepLabels[name]}: ${step ? step.status : "—"}`, enabled: false };
  };
  const agentLoaded = state.steps.some((s) => s.step === "tunnel-agent" && s.status === "ok");
  const update = updater?.state();
  return Menu.buildFromTemplate([
    { label: headline, enabled: false },
    ...(update?.available
      ? [
          {
            label: `アップデートがあります（v${update.available.version}）`,
            submenu: [
              {
                label: update.method === "homebrew" ? "Homebrew で更新" : "ダウンロードして更新",
                enabled: !busy && !update.phase,
                // Errors are shown in the window.
                click: () =>
                  void updater.install().then(() => updater.state().error && openWindow()),
              },
              { label: "リリースノートを開く", click: () => updater.openNotes() },
              { label: "この版をスキップ", click: () => void updater.skip() },
              { label: "詳細…", click: openWindow },
            ],
          },
        ]
      : []),
    line("orca"),
    line("service"),
    line("tunnel"),
    line("tunnel-agent"),
    { type: "separator" },
    { label: "セットアップと詳細…", click: openWindow },
    {
      label: "状態を再確認",
      enabled: !busy,
      click: () => void exclusive(doctor).catch(() => undefined),
    },
    {
      label: "Tunnel を再起動",
      enabled: agentLoaded && !busy,
      click: () => void restartAgent().catch(() => undefined),
    },
    {
      label: "ChatGPT のプラグイン画面を開く",
      click: () => void shell.openExternal(setup.setupUrls.connectors),
    },
    { type: "separator" },
    ...(app.isPackaged
      ? [
          {
            label: "ログイン時に起動",
            type: "checkbox",
            checked: app.getLoginItemSettings().openAtLogin,
            click: (item) => {
              app.setLoginItemSettings({ openAtLogin: item.checked });
              notify();
            },
          },
          {
            label: update?.checking ? "アップデートを確認中…" : "アップデートを確認",
            enabled: !update?.checking && !update?.phase,
            // The result (newer version, up to date, or an error) is shown in the window.
            click: () => void updater.check().then(openWindow),
          },
          {
            label: "自動で更新を確認する",
            type: "checkbox",
            checked: update?.autoCheck ?? true,
            click: (item) => void updater.setAutoCheck(item.checked),
          },
        ]
      : []),
    { label: "終了", role: "quit" },
  ]);
}

/**
 * The end of one audit log file (the bridge's 操作の記録), never through a symlink and at
 * most ~1 MB; "" when it is missing or unreadable.
 */
async function readAuditFile(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return "";
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return "";
    const length = Math.min(info.size, 1100 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    const text = buffer.toString("utf8");
    return info.size > length ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return "";
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** The newest rows of ~/.orca-dots-bridge/audit.log (and its previous file). */
async function auditLog() {
  const path = join(home, ".orca-dots-bridge", "audit.log");
  const current = await readAuditFile(path);
  const texts = [current];
  if (parseAuditLog([current], auditViewLimit).length < auditViewLimit)
    texts.unshift(await readAuditFile(`${path}.1`));
  // Formatted here: the page only places these strings with textContent.
  return { rows: parseAuditLog(texts, auditViewLimit).map((entry) => formatAuditEntry(entry)) };
}

function registerIpc() {
  ipcMain.handle("audit-log", () => auditLog().catch(() => ({ rows: [], error: true })));
  ipcMain.handle("state", () => publicState());
  ipcMain.handle("doctor", async () => {
    try {
      await exclusive(doctor);
      return publicState();
    } catch (error) {
      return {
        ...publicState(),
        error: error instanceof Error && error.message === "busy" ? "busy" : "doctor_failed",
      };
    }
  });
  ipcMain.handle("setup", async (_event, input) => {
    try {
      return { ...(await runSetup(input)), state: publicState() };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "setup_failed",
        state: publicState(),
      };
    }
  });
  ipcMain.handle("open", (_event, page) => {
    if (externalPages.includes(page)) void shell.openExternal(setup.setupUrls[page]);
  });
  ipcMain.handle("copy", (_event, text) => {
    if (typeof text === "string" && tunnelIdPattern.test(text)) void clipboard.writeText(text);
  });
  ipcMain.handle("restart-agent", async () => {
    try {
      await restartAgent();
      return {};
    } catch (error) {
      return {
        error: error instanceof Error && error.message === "busy" ? "busy" : "restart_failed",
      };
    }
  });
  ipcMain.handle("update-check", async () => {
    await updater.check();
    return publicState();
  });
  ipcMain.handle("update-install", async () => {
    await updater.install();
    return publicState();
  });
  ipcMain.handle("update-skip", async () => {
    await updater.skip();
    return publicState();
  });
  ipcMain.handle("update-auto", async (_event, value) => {
    await updater.setAutoCheck(value === true);
    return publicState();
  });
  ipcMain.handle("update-notes", () => updater.openNotes());
  ipcMain.handle("login-item", (_event, openAtLogin) => {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: openAtLogin === true });
    return publicState();
  });
}

/**
 * Removes copies of the bridge left by earlier app versions. Only X.Y.Z folders older
 * than this app are candidates; the newest older one stays (one previous version), and
 * any version still named by a managed LaunchAgent or profile stays. If any of those
 * files cannot be read (other than not existing), nothing is removed.
 */
async function pruneRuntimes() {
  const root = join(home, ".orca-dots-bridge", "runtime");
  const paths = setup.setupPaths(home);
  const files = [
    paths.serviceAgent,
    paths.tunnelAgent,
    paths.profile,
    ...Object.values(paths.legacy),
  ];
  const texts = await Promise.all(
    files.map((file) =>
      readFile(file, "utf8").catch((error) => {
        if (error?.code === "ENOENT") return undefined;
        throw error;
      }),
    ),
  );
  const names = await readdir(root);
  for (const name of runtimesToPrune(names, app.getVersion(), referencedRuntimes(texts))) {
    const dir = join(root, name);
    const stat = await lstat(dir);
    if (stat.isDirectory() && !stat.isSymbolicLink())
      await rm(dir, { recursive: true, force: true });
  }
}

/**
 * macOS runs a downloaded app that was not moved with Finder from a temporary,
 * read-only copy (App Translocation). Linking the bridge service to that copy would
 * break it after the next restart, so ask for a proper install instead.
 */
const translocated = () => process.execPath.includes("/AppTranslocation/");

async function start() {
  if (app.isPackaged && translocated()) {
    dialog.showErrorBox(
      "アプリを「アプリケーション」へ移してください",
      "macOS がこのアプリを一時的な場所で実行しています。このままでは、bridge サービスと Tunnel の自動起動が Mac の再起動後に動かなくなります。\n\nFinder で「Orca Dots Bridge」を「アプリケーション」フォルダへドラッグして移し、そこから開き直してください。",
    );
    return app.quit();
  }
  const runtime = process.env.ORCA_DOTS_BRIDGE_DIR ? undefined : await bundledRuntime();
  const bridge = runtime?.bridge ?? (await bridgeDir());
  const setupModule = join(bridge, "dist", "setup.mjs");
  if (
    !(await access(setupModule).then(
      () => true,
      () => false,
    ))
  ) {
    dialog.showErrorBox(
      "bridge が見つかりません",
      `${setupModule} がありません。bridge のフォルダで npm ci --ignore-scripts と npm run build を実行してください。`,
    );
    return app.quit();
  }
  const nodePath = runtime?.nodePath ?? (await resolveNode());
  if (!nodePath) {
    dialog.showErrorBox(
      "Node.js が見つかりません",
      "Node.js 22 以上を入れるか、ORCA_DOTS_NODE に絶対パスを設定してください。",
    );
    return app.quit();
  }
  setup = await import(pathToFileURL(setupModule).href);
  if (typeof setup.systemSetupIo !== "function" || typeof setup.tunnelLabel !== "string") {
    dialog.showErrorBox(
      "bridge が古い可能性があります",
      `${setupModule} がこのアプリに対応していません。bridge のフォルダで npm run build を実行してください。`,
    );
    return app.quit();
  }
  // GUI apps start with a minimal PATH; add the usual install locations.
  const env = {
    ...process.env,
    PATH: `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin`,
  };
  io = setup.systemSetupIo({ distDir: join(bridge, "dist"), nodePath, env });
  usesBundledRuntime = Boolean(runtime);

  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle("Orca …");
  await exclusive(doctor).catch(() => undefined);
  // After an app update the service LaunchAgent still points at the previous runtime,
  // and an install from the earlier two-Tunnel layout still runs its old agents.
  // Fixing either needs no new input (the saved status Tunnel ID becomes the one
  // Tunnel ID), so do what "セットアップを実行" with automatic start would do.
  if (needsAgentRefresh(state.steps))
    await runSetup({ installAgent: true }).catch((error) => {
      console.error("automatic setup after update failed:", error);
    });
  // Once the services point at this version, older bridge copies can go.
  if (usesBundledRuntime) await pruneRuntimes().catch(() => undefined);
  updater = createUpdater({ onChange: notify, isBusy: () => busy });
  await updater.init().catch(() => undefined);
  registerIpc();
  notify();
  const update = updater.state();
  if (overallLevel(state.steps) !== "ok" || update.notice === "updated" || update.error)
    openWindow();
  setInterval(() => void probeTunnel(), 30_000);
  setInterval(
    () => void (busy ? undefined : exclusive(doctor).catch(() => undefined)),
    10 * 60_000,
  );
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", openWindow);
  // Opening the app again from Finder or Spotlight activates the running instance.
  app.on("activate", () => setup && openWindow());
  // Closing the window keeps the menu bar app running.
  app.on("window-all-closed", () => undefined);
  app.dock?.hide();
  void app
    .whenReady()
    .then(start)
    .catch((error) => {
      dialog.showErrorBox(
        "起動できませんでした",
        `${error instanceof Error ? error.message : String(error)}\n\nbridge のフォルダで npm run build を実行してから、もう一度起動してください。`,
      );
      app.quit();
    });
}
