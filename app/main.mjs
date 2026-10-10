import { execFile } from "node:child_process";
import { access, constants, readFile } from "node:fs/promises";
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
  externalPages,
  nodeCandidates,
  overallLevel,
  parseSetupRequest,
  runtimeKeyFromClipboard,
  stepLabels,
  trayTitle,
  tunnelIdPattern,
} from "./lib.mjs";

// Menu bar shell around the bridge's `setup` command: it shows the doctor result,
// runs setup with what a person enters, and keeps an eye on the status Tunnel.
// Key material never reaches the renderer; the runtime key goes from the
// clipboard straight into setup.

const run = promisify(execFile);
const appDir = dirname(fileURLToPath(import.meta.url));
const home = homedir();

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

/** Electron's own execPath is not Node, so the status Tunnel needs a real Node binary. */
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
let tray;
let window;
let busy = false;
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
    tunnelReady: steps.some((s) => s.step === "status-tunnel" && s.status === "ok"),
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
  const base = (
    await readFile(setup.setupPaths(home).statusHealthUrl, "utf8").catch(() => "")
  ).trim();
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
      ...(process.env.ORCA_DOTS_NODE ? { nodePath: io.nodePath } : {}),
    };
    if (request.useClipboardKey) {
      const key = runtimeKeyFromClipboard(clipboard.readText());
      if (!key) return { error: "clipboard_has_no_runtime_key" };
      options.runtimeKey = key;
    }
    const { steps } = await setup.runSetup(io, options);
    // Clear the clipboard only once the key is stored, and only if it still holds that key.
    if (
      runtimeKeyFromClipboard(clipboard.readText()) === options.runtimeKey &&
      options.runtimeKey &&
      steps.some((s) => s.step === "runtime-key" && ["ok", "created", "updated"].includes(s.status))
    )
      clipboard.clear();
    await doctor();
    return { steps };
  });
}

async function restartAgent() {
  const uid = process.getuid?.() ?? -1;
  await exclusive(() =>
    run("/bin/launchctl", ["kickstart", "-k", `gui/${uid}/${setup.launchAgentLabel}`]),
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
  const agentLoaded = state.steps.some((s) => s.step === "launch-agent" && s.status === "ok");
  return Menu.buildFromTemplate([
    { label: headline, enabled: false },
    line("orca"),
    line("status-tunnel"),
    line("launch-agent"),
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
        ]
      : []),
    { label: "終了", role: "quit" },
  ]);
}

function registerIpc() {
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
  ipcMain.handle("login-item", (_event, openAtLogin) => {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: openAtLogin === true });
    return publicState();
  });
}

async function start() {
  const bridge = await bridgeDir();
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
  const nodePath = await resolveNode();
  if (!nodePath) {
    dialog.showErrorBox(
      "Node.js が見つかりません",
      "Node.js 22 以上を入れるか、ORCA_DOTS_NODE に絶対パスを設定してください。",
    );
    return app.quit();
  }
  setup = await import(pathToFileURL(setupModule).href);
  if (typeof setup.systemSetupIo !== "function" || typeof setup.recordedNodePath !== "function") {
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

  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle("Orca …");
  await exclusive(doctor).catch(() => undefined);
  registerIpc();
  notify();
  if (overallLevel(state.steps) !== "ok") openWindow();
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
