// Pure helpers for the menu bar app, kept free of Electron so they can be tested.

export const runtimeKeyPattern = /^sk-[A-Za-z0-9_-]{20,256}$/;
export const tunnelIdPattern = /^tunnel_[A-Za-z0-9]{8,64}$/;

const done = new Set(["ok", "created", "updated"]);

/** One level for the tray: any error wins, then anything a person still has to do. */
export function overallLevel(steps) {
  if (steps.some((s) => s.status === "error")) return "error";
  const tunnel = steps.find((s) => s.step === "status-tunnel");
  if (steps.some((s) => s.status === "action") || !tunnel || !done.has(tunnel.status))
    return "action";
  return "ok";
}

export function trayTitle(level, tunnelReady) {
  if (level === "error") return "Orca ✕";
  if (!tunnelReady) return "Orca …";
  return level === "ok" ? "Orca ✓" : "Orca !";
}

export const stepLabels = {
  platform: "macOS",
  settings: "設定",
  orca: "Orca",
  "trial-keys": "通知用の鍵",
  "service-authorization": "dot 認証ファイル",
  relay: "relay plugin 設定",
  "runtime-key": "runtime キー",
  "tunnel-client": "tunnel-client",
  "status-profile": "状態確認用 profile",
  "notification-profile": "通知用 profile",
  "status-doctor": "profile の検証",
  "launch-agent": "自動起動（LaunchAgent）",
  "status-tunnel": "状態確認用 Tunnel",
};

/** Where a Node binary usually lives; GUI apps do not inherit the shell PATH. */
export function nodeCandidates(home) {
  return [
    `${home}/.nodebrew/current/bin/node`,
    `${home}/.volta/bin/node`,
    `${home}/.local/share/mise/shims/node`,
    `${home}/.asdf/shims/node`,
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
  ];
}

/** Accepts the clipboard text only when it is a runtime key, so nothing else is stored or cleared. */
export function runtimeKeyFromClipboard(text) {
  const key = (text ?? "").trim();
  return runtimeKeyPattern.test(key) ? key : undefined;
}

/** Validates what the renderer sends; it never receives or sends key material. */
export function parseSetupRequest(input) {
  if (typeof input !== "object" || input === null) throw new Error("invalid_request");
  const request = {
    useClipboardKey: input.useClipboardKey === true,
    installTunnelClient: input.installTunnelClient === true,
    installAgent: input.installAgent === true,
  };
  for (const key of ["statusTunnelId", "notificationTunnelId"]) {
    const value = typeof input[key] === "string" ? input[key].trim() : "";
    if (value === "") continue;
    if (!tunnelIdPattern.test(value)) throw new Error(`invalid_${key}`);
    request[key] = value;
  }
  return request;
}

export const externalPages = ["tunnels", "apiKeys", "connectors"];
