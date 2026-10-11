// Pure helpers for the menu bar app, kept free of Electron so they can be tested.

export const runtimeKeyPattern = /^sk-[A-Za-z0-9_-]{20,256}$/;
export const tunnelIdPattern = /^tunnel_[A-Za-z0-9]{8,64}$/;

const done = new Set(["ok", "created", "updated"]);

/** One level for the tray: any error wins, then anything a person still has to do. */
export function overallLevel(steps) {
  if (steps.some((s) => s.status === "error")) return "error";
  const tunnel = steps.find((s) => s.step === "tunnel");
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
  "trial-keys": "サービスの鍵",
  "service-authorization": "dot 認証ファイル",
  relay: "relay plugin 設定",
  "runtime-key": "runtime キー",
  "tunnel-client": "tunnel-client",
  profile: "Tunnel の profile",
  "legacy-service": "旧・通知サービス",
  service: "bridge サービス（自動起動）",
  "profile-doctor": "profile の検証",
  "legacy-status-tunnel": "旧・状態確認用 Tunnel",
  "tunnel-agent": "Tunnel（自動起動）",
  tunnel: "Tunnel",
  "legacy-notification-tunnel": "旧・通知用 Tunnel",
  "legacy-profiles": "旧 profile",
};

/**
 * Whether doctor found something setup with installAgent would fix on its own:
 * a LaunchAgent of the earlier two-Tunnel layout that is still loaded, or a service
 * LaunchAgent pointing at an earlier runtime.
 */
export function needsAgentRefresh(steps) {
  return steps.some(
    (s) =>
      (s.step.startsWith("legacy-") &&
        s.status === "action" &&
        s.detail.includes("still loaded")) ||
      (["service", "tunnel-agent"].includes(s.step) &&
        s.status === "action" &&
        s.detail.startsWith("outdated")),
  );
}

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
    // Rotating needs the clipboard key; a stored key is never replaced otherwise.
    replaceRuntimeKey: input.useClipboardKey === true && input.replaceRuntimeKey === true,
    installTunnelClient: input.installTunnelClient === true,
    installAgent: input.installAgent === true,
  };
  const tunnelId = typeof input.tunnelId === "string" ? input.tunnelId.trim() : "";
  if (tunnelId !== "") {
    if (!tunnelIdPattern.test(tunnelId)) throw new Error("invalid_tunnelId");
    request.tunnelId = tunnelId;
  }
  return request;
}

export const externalPages = ["tunnels", "apiKeys", "connectors"];

// ---- 操作の記録 (the bridge's audit.log) ----------------------------------
// The main process reads ~/.orca-dots-bridge/audit.log(.1); these helpers turn its JSON
// Lines into rows for the window. Only known fields of known shapes are kept.

export const auditViewLimit = 30;
export const auditToolLabels = {
  orca_send_instruction: "指示の送信",
  orca_answer: "質問・承認への回答",
  orca_create_workspace: "ワークスペースの作成",
  orca_start_task: "タスクの開始",
  orca_close_agent: "エージェントの終了",
  orca_remove_workspace: "ワークスペースの削除",
  orca_set_alias: "呼び名の登録",
  orca_remove_alias: "呼び名の削除",
  orca_settings_update: "設定の変更",
};
export const auditOutcomeLabels = { ok: "完了", refused: "拒否", error: "エラー" };
const auditSources = new Set(["chatgpt", "stdio"]);
const auditTargetOrder = [
  ["repo", ""],
  ["workspace", ""],
  ["alias", "呼び名 "],
  ["template", "型 "],
  ["issue", "Issue #"],
  ["pr", "PR #"],
  ["agent", ""],
  ["option", "選択肢 "],
  ["handle", ""],
];
const settingLabels = {
  sendEnabled: "指示の送信",
  closeEnabled: "エージェントの終了",
  createEnabled: "ワークスペースの作成",
  removeEnabled: "ワークスペースの削除",
  notificationsEnabled: "通知",
};

/** Printable text only (control characters become spaces), at most `max` characters. */
const shortText = (value, max) =>
  typeof value === "string"
    ? Array.from(value)
        .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c))
        .slice(0, max)
        .join("")
    : undefined;

/** One validated entry from one line, or undefined. */
function auditEntry(line) {
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  if (!Object.hasOwn(auditToolLabels, raw.tool) || !Object.hasOwn(auditOutcomeLabels, raw.outcome))
    return undefined;
  if (!auditSources.has(raw.source) || typeof raw.time !== "string") return undefined;
  const target = {};
  if (typeof raw.target === "object" && raw.target !== null && !Array.isArray(raw.target))
    for (const [key, value] of Object.entries(raw.target).slice(0, 30)) {
      if (!/^[A-Za-z]{1,40}$/.test(key)) continue;
      if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
        target[key] = value;
      else if (typeof value === "string") target[key] = shortText(value, 300);
    }
  return {
    time: shortText(raw.time, 40),
    source: raw.source,
    tool: raw.tool,
    outcome: raw.outcome,
    errorCode:
      typeof raw.errorCode === "string" && /^[a-z_]{1,80}$/.test(raw.errorCode)
        ? raw.errorCode
        : undefined,
    target,
    summary: shortText(raw.summary, 200),
  };
}

/**
 * The newest `limit` entries, newest first, from the files' texts in order (older file
 * first). Malformed lines are skipped.
 */
export function parseAuditLog(texts, limit = auditViewLimit) {
  const entries = [];
  for (const text of texts)
    if (typeof text === "string")
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const entry = auditEntry(line);
        if (entry) entries.push(entry);
      }
  return entries.slice(-limit).reverse();
}

/** What one row of 操作の記録 shows; all strings, set with textContent. */
export function formatAuditEntry(entry, locale = "ja-JP") {
  const date = new Date(entry.time);
  const time = Number.isNaN(date.getTime())
    ? entry.time
    : date.toLocaleString(locale, {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
  const t = entry.target ?? {};
  let target;
  if (entry.tool === "orca_settings_update")
    target = Object.entries(t)
      .filter(([, v]) => typeof v === "boolean")
      .map(([k, v]) => `${settingLabels[k] ?? k}: ${v ? "オン" : "オフ"}`)
      .join("、");
  else {
    const parts = auditTargetOrder
      .filter(([key]) => t[key] !== undefined && t[key] !== "")
      .map(([key, prefix]) => `${prefix}${t[key]}`);
    if (t.allInWorkspace === true) parts.push("すべてのターミナル");
    if (!parts.length && typeof t.worktreeId === "string") parts.push(t.worktreeId);
    target = parts.join(" / ");
  }
  const outcome = auditOutcomeLabels[entry.outcome];
  return {
    time,
    tool: auditToolLabels[entry.tool],
    source: entry.source === "stdio" ? "stdio" : "ChatGPT",
    target,
    outcome: entry.errorCode ? `${outcome}（${entry.errorCode}）` : outcome,
    outcomeClass: entry.outcome,
    summary: entry.tool === "orca_settings_update" ? "" : (entry.summary ?? ""),
  };
}

// ---- In-app updates -------------------------------------------------------
// The app is signed ad hoc only, so Squirrel / electron-updater cannot be used.
// Authenticity rests on the GitHub release itself: the release JSON and assets come
// over HTTPS from github.com, and the zip must match the SHA256SUMS file of the same
// release. There is no separate signature; the bundle identifier and version checks
// stop a different app (or a different release) from being swapped in.

export const releaseRepo = "andoshin11/orca-dots-bridge";
export const latestReleaseUrl = `https://api.github.com/repos/${releaseRepo}/releases/latest`;
export const appBundleName = "Orca Dots Bridge.app";
export const caskToken = "andoshin11/tap/orca-dots-bridge";
export const brewUpgradeArgs = ["upgrade", "--cask", caskToken];
export const brewCandidates = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];
export const caskroomCandidates = [
  "/opt/homebrew/Caskroom/orca-dots-bridge",
  "/usr/local/Caskroom/orca-dots-bridge",
];
export const updateCheckInterval = 6 * 60 * 60_000;
export const firstCheckDelay = 30_000;
/** The release zip is about 100 MB; anything far larger is refused before download. */
export const maxAssetBytes = 500 * 1024 * 1024;

const versionPattern = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

/** A plain X.Y.Z version (an optional leading "v"), or undefined. Pre-release tags are not accepted. */
export function parseVersion(text) {
  const match = typeof text === "string" ? versionPattern.exec(text.trim()) : null;
  return match ? match.slice(1, 4).map(Number) : undefined;
}

/** -1, 0 or 1 like a sort comparator; throws on anything that is not X.Y.Z. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error("invalid_version");
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** The arch suffix of the release zip for Node's process.arch. */
export function releaseArch(arch) {
  return arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : undefined;
}

export const zipAssetName = (version, arch) => `Orca-Dots-Bridge-${version}-mac-${arch}.zip`;

/**
 * Reads the GitHub "latest release" JSON. Returns undefined for drafts, pre-releases,
 * tags that are not vX.Y.Z, and releases missing this arch's zip or SHA256SUMS. Asset
 * URLs must be the exact download URLs of this repository's tag.
 */
export function parseRelease(json, arch) {
  if (typeof json !== "object" || json === null) return undefined;
  if (json.draft !== false || json.prerelease !== false) return undefined;
  const tag = typeof json.tag_name === "string" ? json.tag_name : "";
  if (!/^v\d+\.\d+\.\d+$/.test(tag) || !parseVersion(tag)) return undefined;
  const version = tag.slice(1);
  const target = releaseArch(arch);
  if (!target || !Array.isArray(json.assets)) return undefined;
  const asset = (name) => {
    const found = json.assets.find((a) => a && a.name === name);
    const url = `https://github.com/${releaseRepo}/releases/download/${tag}/${name}`;
    if (!found || found.browser_download_url !== url) return undefined;
    if (typeof found.size === "number" && (found.size <= 0 || found.size > maxAssetBytes))
      return undefined;
    return { name, url, size: typeof found.size === "number" ? found.size : undefined };
  };
  const zip = asset(zipAssetName(version, target));
  const sums = asset("SHA256SUMS");
  if (!zip || !sums) return undefined;
  // Release notes always open on this repository's tag page, whatever html_url says.
  const notesUrl = `https://github.com/${releaseRepo}/releases/tag/${tag}`;
  return { version, tag, notesUrl, zip, sums };
}

/**
 * The release to offer, if it is newer than the running app. A skipped version is
 * hidden from automatic checks but still shown when the person checks by hand.
 */
export function offeredUpdate(release, currentVersion, { skippedVersion, manual = false } = {}) {
  if (!release || !parseVersion(currentVersion)) return undefined;
  if (compareVersions(release.version, currentVersion) <= 0) return undefined;
  if (!manual && skippedVersion === release.version) return undefined;
  return release;
}

/**
 * The SHA-256 for one file from a `shasum -a 256` listing: the line must be exactly
 * "<64 lowercase hex>  <name>" (or "*<name>" for binary mode). Undefined when absent
 * or listed more than once.
 */
export function expectedSha256(sums, name) {
  if (typeof sums !== "string") return undefined;
  const hashes = sums
    .split("\n")
    .map((line) => /^([0-9a-f]{64}) [ *](.+)$/.exec(line.replace(/\r$/, "")))
    .filter((m) => m && m[2] === name)
    .map((m) => m[1]);
  return hashes.length === 1 ? hashes[0] : undefined;
}

/** The .app bundle around Electron's executable, or undefined when not run from one. */
export function appBundlePath(execPath) {
  const match = /^(\/.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath ?? "");
  return match ? match[1] : undefined;
}

/**
 * Homebrew owns the install when the app sits at /Applications/Orca Dots Bridge.app
 * (where the cask puts it) and a Caskroom entry for the cask exists. The app then
 * leaves replacing itself to `brew upgrade`, so the Caskroom stays consistent.
 */
export function isHomebrewManaged(appPath, caskroomExists) {
  return appPath === `/Applications/${appBundleName}` && caskroomExists === true;
}

/**
 * Why the running bundle must not be replaced in place, or undefined when it may be.
 * Writability is checked separately (it needs the file system).
 */
export function installTargetProblem(appPath) {
  if (typeof appPath !== "string" || !appPath.startsWith("/")) return "not_an_app_bundle";
  if (appPath.includes("/AppTranslocation/")) return "translocated";
  const parts = appPath.split("/");
  if (parts.some((p, i) => i > 0 && (p === "" || p === "." || p === "..")))
    return "not_an_app_bundle";
  if (parts.at(-1) !== appBundleName) return "unexpected_name";
  return undefined;
}

/** Where `ditto -x -k` puts the bundle of a release zip. */
export const extractedAppPath = (extractDir, arch) =>
  `${extractDir}/Orca Dots Bridge-darwin-${arch}/${appBundleName}`;

/** Problems with an extracted bundle's Info.plist values, compared with the running app. */
export function bundleInfoProblem(info, expected) {
  if (!info?.identifier || info.identifier !== expected.identifier) return "identifier_mismatch";
  if (!info.version || info.version !== expected.version) return "version_mismatch";
  return undefined;
}

/** Runtime versions (~/.orca-dots-bridge/runtime/<X.Y.Z>/) named in LaunchAgents or profiles. */
export function referencedRuntimes(texts) {
  const found = new Set();
  for (const text of texts)
    for (const match of String(text ?? "").matchAll(
      /\/\.orca-dots-bridge\/runtime\/(\d+\.\d+\.\d+)(?=[/<"'\s]|$)/g,
    ))
      found.add(match[1]);
  return found;
}

/**
 * Which ~/.orca-dots-bridge/runtime/<version> directories can go: only names that are
 * plain X.Y.Z, older than the running app, not referenced by a managed file, and not the
 * newest of the older ones (kept as the one previous version). Newer versions (after a
 * downgrade) and anything else in the folder (node, temporary copies) are left alone.
 */
export function runtimesToPrune(names, currentVersion, referenced) {
  if (!parseVersion(currentVersion)) return [];
  const older = names
    .filter((n) => /^\d+\.\d+\.\d+$/.test(n) && parseVersion(n))
    .filter((n) => compareVersions(n, currentVersion) < 0)
    .sort(compareVersions);
  const previous = older.at(-1);
  return older.filter((n) => n !== previous && !referenced.has(n));
}

/** The small JSON the app keeps under Electron's userData (never in ~/.orca-dots-bridge). */
export function parseUpdatePrefs(text) {
  let raw;
  try {
    raw = JSON.parse(text ?? "");
  } catch {
    raw = {};
  }
  if (typeof raw !== "object" || raw === null) raw = {};
  const prefs = { autoCheck: raw.autoCheck !== false };
  if (typeof raw.lastCheckedAt === "string" && !Number.isNaN(Date.parse(raw.lastCheckedAt)))
    prefs.lastCheckedAt = raw.lastCheckedAt;
  if (parseVersion(raw.skippedVersion)) prefs.skippedVersion = raw.skippedVersion;
  const pending = raw.pendingInstall;
  if (
    pending &&
    typeof pending === "object" &&
    parseVersion(pending.version) &&
    typeof pending.tempDir === "string"
  )
    prefs.pendingInstall = { version: pending.version, tempDir: pending.tempDir };
  return prefs;
}

/** Delay before the next automatic check: 30 s after start at the earliest, then every 6 h. */
export function nextCheckDelay(lastCheckedAt, now) {
  const last = lastCheckedAt ? Date.parse(lastCheckedAt) : Number.NaN;
  if (Number.isNaN(last) || last > now) return firstCheckDelay;
  return Math.min(updateCheckInterval, Math.max(firstCheckDelay, last + updateCheckInterval - now));
}

export const updateTempPrefix = "orca-dots-bridge-update-";

/** Whether a recorded temporary folder is one this app created (so it may be removed). */
export function isUpdateTempDir(path, tmpRoot) {
  if (typeof path !== "string" || typeof tmpRoot !== "string") return false;
  const root = tmpRoot.replace(/\/+$/, "");
  const rest = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : "";
  return new RegExp(`^${updateTempPrefix}[A-Za-z0-9]{6,}$`).test(rest);
}

/**
 * The detached helper that swaps the bundle once the app has quit. Arguments:
 *   $1 pid of the app   $2 bundle to replace   $3 new bundle   $4 backup path   $5 "1" to open the app
 * It never asks for privileges. The old bundle is moved aside first and moved back
 * if copying the new one fails; either way the app at $2 is opened again.
 * Extended attributes are copied as they are: the downloaded zip has no quarantine
 * attribute, and the helper neither adds nor strips one.
 */
export const installerScript = `#!/bin/sh
pid="$1"; target="$2"; source="$3"; backup="$4"; relaunch="$5"
i=0
while /bin/kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 600 ]; then echo "app did not quit" >&2; exit 1; fi
  /bin/sleep 0.2
done
case "$target" in
  */"Orca Dots Bridge.app") ;;
  *) echo "unexpected target" >&2; exit 1 ;;
esac
if [ -e "$backup" ] || [ ! -d "$source" ] || [ -L "$target" ]; then
  echo "refusing to install" >&2
  exit 1
fi
status=0
if /bin/mv "$target" "$backup"; then
  if ! /usr/bin/ditto "$source" "$target"; then
    echo "copy failed; restoring the previous app" >&2
    /bin/rm -rf "$target"
    /bin/mv "$backup" "$target"
    status=1
  fi
else
  echo "could not move the current app aside" >&2
  status=1
fi
if [ "$relaunch" = "1" ]; then /usr/bin/open "$target"; fi
exit "$status"
`;
