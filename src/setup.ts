import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import {
  access,
  chmod,
  constants,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMacKeychain, type KeyAccount } from "./events/keychain.js";
import {
  KeySetupError,
  setupErrorCode,
  setupRelayKey,
  setupTrialKeys,
} from "./key-setup-shared.js";

// One command that brings this Mac to "dot can call orca_status through the
// Tunnel": keys, the relay plugin config, tunnel-client, Tunnel profiles and an
// optional LaunchAgent. Every step is idempotent and never replaces anything it
// did not create. Secrets are never printed or passed on argv.

/** tunnel-client release pinned by version and archive digest (docs were verified on 0.0.15). */
export const tunnelClientRelease = {
  version: "0.0.15",
  sha256: {
    arm64: "b2cae3aa9df45b4c2fe9b1d700ebacce39f9feb6a6b46b86e6499f9a51bf72ff",
    amd64: "9dcae1e2fb121287e73271edb7b853dda52aa86b7bfca1df91bc275371261bdb",
  },
} as const;

export const launchAgentLabel = "dev.orca-dots-bridge.status-tunnel";
const managedMarker = "# managed by orca-dots-bridge setup";
const tunnelIdPattern = /^tunnel_[A-Za-z0-9]{8,64}$/;
const runtimeKeyPattern = /^sk-[A-Za-z0-9_-]{20,256}$/;
export const setupUrls = {
  tunnels: "https://platform.openai.com/settings/organization/tunnels",
  apiKeys: "https://platform.openai.com/settings/organization/api-keys",
  connectors: "https://chatgpt.com/#settings/Connectors",
};

export function setupPaths(home: string) {
  const root = join(home, ".orca-dots-bridge");
  const tunnel = join(root, "tunnel");
  return {
    root,
    settings: join(root, "settings.json"),
    runtimeKey: join(tunnel, "control-plane-api-key"),
    serviceAuthorization: join(tunnel, "service-authorization"),
    statusProfile: join(tunnel, "profiles", "orca-status.yaml"),
    notificationProfile: join(tunnel, "profiles", "orca-notifications.yaml"),
    statusHealthUrl: join(tunnel, "orca-status-health.url"),
    notificationHealthUrl: join(tunnel, "orca-notifications-health.url"),
    tunnelClientDir: join(root, "tunnel-client", `v${tunnelClientRelease.version}`),
    relayConfig: join(home, ".config", "orca-agent-status-relay", "config.json"),
    launchAgent: join(home, "Library", "LaunchAgents", `${launchAgentLabel}.plist`),
  };
}
export type SetupPaths = ReturnType<typeof setupPaths>;

export type Settings = {
  statusTunnelId?: string;
  notificationTunnelId?: string;
  relayPort: number;
};
export type StepStatus = "ok" | "created" | "updated" | "skipped" | "action" | "error";
export type Step = { step: string; status: StepStatus; detail: string };
type ExecResult = { code: number; stdout: string };

export type SetupIo = {
  home: string;
  platform: string;
  arch: string;
  uid: number;
  env: Record<string, string | undefined>;
  nodePath: string;
  distDir: string;
  keys: {
    exists(account: KeyAccount): Promise<boolean>;
    read(account: KeyAccount): Promise<Buffer>;
    putNew(account: KeyAccount, key: Buffer): Promise<void>;
    remove(account: KeyAccount): Promise<void>;
  };
  exec(file: string, args: string[], env?: Record<string, string>): Promise<ExecResult>;
  download(url: string): Promise<Buffer>;
  probe(url: string): Promise<number>;
  sleep(ms: number): Promise<void>;
};

export type SetupOptions = {
  mode: "setup" | "doctor";
  statusTunnelId?: string;
  notificationTunnelId?: string;
  relayPort?: number;
  runtimeKey?: string;
  installTunnelClient?: boolean;
  installAgent?: boolean;
};

const yaml = (value: string) => JSON.stringify(value);
const xml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function plainPath(path: string) {
  // The MCP command is a single string that tunnel-client splits on spaces.
  if (/\s/.test(path)) throw new Error("path_with_whitespace_unsupported");
  return path;
}

/** The status-only bridge command, run with a clean environment so no key is inherited. */
export function statusMcpCommand(input: {
  home: string;
  nodePath: string;
  distDir: string;
  orcaBin: string;
}) {
  const orca = plainPath(input.orcaBin);
  return [
    "/usr/bin/env -i",
    `HOME=${plainPath(input.home)}`,
    `PATH=/usr/bin:/bin:${dirname(orca)}`,
    `ORCA_BIN=${orca}`,
    "ORCA_ENVIRONMENT=",
    "ORCA_PAIRING_CODE=",
    "ORCA_BRIDGE_STATUS_ONLY=1",
    plainPath(input.nodePath),
    plainPath(join(input.distDir, "mcp.mjs")),
  ].join(" ");
}

function profileHeader(tunnelId: string, runtimeKey: string, healthUrlFile: string) {
  return [
    managedMarker,
    "config_version: 1",
    "control_plane:",
    '  base_url: "https://api.openai.com"',
    `  tunnel_id: ${yaml(tunnelId)}`,
    `  api_key: ${yaml(`file:${runtimeKey}`)}`,
    "health:",
    '  listen_addr: "127.0.0.1:0"',
    `  url_file: ${yaml(healthUrlFile)}`,
    "admin_ui:",
    "  open_browser: false",
    "log:",
    "  level: info",
    "  format: json",
    "mcp:",
  ];
}

export function renderStatusProfile(paths: SetupPaths, tunnelId: string, command: string) {
  return [
    ...profileHeader(tunnelId, paths.runtimeKey, paths.statusHealthUrl),
    "  commands:",
    "    - channel: main",
    `      command: ${yaml(command)}`,
    "",
  ].join("\n");
}

export function renderNotificationProfile(paths: SetupPaths, tunnelId: string) {
  return [
    ...profileHeader(tunnelId, paths.runtimeKey, paths.notificationHealthUrl),
    "  server_urls:",
    "    - channel: main",
    '      url: "http://127.0.0.1:8787/mcp"',
    "  extra_headers:",
    `    Authorization: ${yaml(`file:${paths.serviceAuthorization}`)}`,
    "",
  ].join("\n");
}

export function renderLaunchAgent(input: { home: string; tunnelClient: string; profile: string }) {
  const args = [input.tunnelClient, "run", "--profile-file", input.profile];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- managed by orca-dots-bridge setup -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${launchAgentLabel}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${xml(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>HOME</key><string>${xml(input.home)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
`;
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
const executable = (path: string) =>
  access(path, constants.X_OK).then(
    () => true,
    () => false,
  );
const readText = (path: string) => readFile(path, "utf8").catch(() => undefined);

async function writeOwnerOnly(path: string, content: string, flag: "w" | "wx" = "wx") {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { mode: 0o600, flag });
}

async function findExecutable(name: string, env: SetupIo["env"], extra: string[]) {
  const dirs = [...(env.PATH ?? "").split(delimiter), ...extra].filter(Boolean);
  for (const dir of dirs) if (await executable(join(dir, name))) return join(dir, name);
  return undefined;
}

async function resolveOrca(io: SetupIo) {
  const configured = io.env.ORCA_BIN;
  if (configured)
    return configured.startsWith("/") && (await executable(configured)) ? configured : undefined;
  return findExecutable("orca", io.env, ["/opt/homebrew/bin", "/usr/local/bin"]);
}

async function resolveTunnelClient(io: SetupIo, paths: SetupPaths) {
  const managed = join(paths.tunnelClientDir, "tunnel-client");
  if (await executable(managed)) return managed;
  return findExecutable("tunnel-client", io.env, []);
}

async function loadSettings(paths: SetupPaths): Promise<Settings> {
  const text = await readText(paths.settings);
  if (!text) return { relayPort: 8788 };
  const parsed = JSON.parse(text) as Partial<Settings>;
  return {
    relayPort: typeof parsed.relayPort === "number" ? parsed.relayPort : 8788,
    ...(typeof parsed.statusTunnelId === "string" ? { statusTunnelId: parsed.statusTunnelId } : {}),
    ...(typeof parsed.notificationTunnelId === "string"
      ? { notificationTunnelId: parsed.notificationTunnelId }
      : {}),
  };
}

/** Writes a generated file, refusing to replace one this command did not generate. */
async function writeManaged(path: string, content: string, marker: string): Promise<StepStatus> {
  const current = await readText(path);
  if (current === content) return "ok";
  if (current !== undefined && !current.includes(marker)) throw new Error("unmanaged_file_exists");
  await writeOwnerOnly(path, content, "w");
  return current === undefined ? "created" : "updated";
}

async function installTunnelClient(io: SetupIo, paths: SetupPaths) {
  const arch = io.arch === "arm64" ? "arm64" : io.arch === "x64" ? "amd64" : undefined;
  if (!arch) throw new Error("unsupported_architecture");
  const v = tunnelClientRelease.version;
  const name = `tunnel-client-v${v}-darwin-${arch}.zip`;
  const archive = await io.download(
    `https://github.com/openai/tunnel-client/releases/download/v${v}/${name}`,
  );
  if (createHash("sha256").update(archive).digest("hex") !== tunnelClientRelease.sha256[arch])
    throw new Error("tunnel_client_digest_mismatch");
  const work = await mkdtemp(join(tmpdir(), "tunnel-client-"));
  try {
    // Extract next to the archive and move into place only when complete, so a
    // failed extraction never leaves a partial binary that later runs accept.
    const staged = join(work, "extracted");
    await writeFile(join(work, name), archive);
    const unzip = await io.exec("/usr/bin/ditto", ["-x", "-k", join(work, name), staged]);
    if (unzip.code !== 0 || !(await exists(join(staged, "tunnel-client"))))
      throw new Error("tunnel_client_extract_failed");
    for (const binary of ["tunnel-client", "cloudflared"])
      await chmod(join(staged, binary), 0o755).catch(() => undefined);
    await mkdir(dirname(paths.tunnelClientDir), { recursive: true, mode: 0o700 });
    await rm(paths.tunnelClientDir, { recursive: true, force: true });
    await rename(staged, paths.tunnelClientDir);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return join(paths.tunnelClientDir, "tunnel-client");
}

export async function runSetup(
  io: SetupIo,
  options: SetupOptions,
): Promise<{ steps: Step[]; settings: Settings }> {
  const write = options.mode === "setup";
  const paths = setupPaths(io.home);
  const steps: Step[] = [];
  const add = (step: string, status: StepStatus, detail: string) => {
    steps.push({ step, status, detail });
  };
  const attempt = async (step: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      const leftover =
        error instanceof KeySetupError && error.leftover.length > 0
          ? ` (check Keychain accounts: ${error.leftover.join(", ")})`
          : "";
      add(step, "error", `${setupErrorCode(error, `${step}_failed`)}${leftover}`);
    }
  };
  const ready = (name: string) =>
    steps.some((s) => s.step === name && ["ok", "created", "updated"].includes(s.status));
  const managedStep = async (step: string, path: string, content: string) => {
    const current = await readText(path);
    if (current !== undefined && current !== content && !current.includes(managedMarker))
      return add(step, "error", `unmanaged_file_exists (move ${path} away and rerun)`);
    if (!write)
      return add(
        step,
        current === content ? "ok" : "action",
        current === content ? path : current ? "outdated" : "missing",
      );
    add(step, await writeManaged(path, content, managedMarker), path);
  };
  if (io.platform !== "darwin") {
    add("platform", "error", "macos_required");
    return { steps, settings: { relayPort: 8788 } };
  }
  // Arguments and saved settings are checked before anything is created.
  let settings: Settings;
  try {
    settings = await loadSettings(paths);
  } catch {
    add("settings", "error", `settings_invalid (fix or delete ${paths.settings})`);
    return { steps, settings: { relayPort: 8788 } };
  }
  const relayPort = options.relayPort ?? settings.relayPort;
  const next: Settings = { ...settings, relayPort };
  if (!Number.isInteger(relayPort) || relayPort < 1024 || relayPort > 65535)
    add("settings", "error", "invalid_relay_port");
  for (const [key, value] of [
    ["statusTunnelId", options.statusTunnelId],
    ["notificationTunnelId", options.notificationTunnelId],
  ] as const) {
    if (value === undefined) continue;
    if (tunnelIdPattern.test(value)) next[key] = value;
    else add("settings", "error", `invalid_${key}`);
  }
  if (steps.length > 0) return { steps, settings };

  // Orca runtime on this Mac.
  const orcaBin = await resolveOrca(io);
  await attempt("orca", async () => {
    if (!orcaBin)
      return add(
        "orca",
        "error",
        "orca_cli_not_found (register the CLI in Orca settings or set ORCA_BIN)",
      );
    const result = await io.exec(orcaBin, ["status", "--json"], {
      ORCA_ENVIRONMENT: "",
      ORCA_PAIRING_CODE: "",
    });
    const parsed =
      result.code === 0
        ? (JSON.parse(result.stdout) as { result?: { runtime?: { reachable?: boolean } } })
        : undefined;
    if (parsed?.result?.runtime?.reachable === true) add("orca", "ok", orcaBin);
    else add("orca", "error", "orca_runtime_unreachable (open the Orca app)");
  });

  // Notification keys; the dot-facing API key goes straight into the Bearer file.
  await attempt("trial-keys", async () => {
    const [outbox, service] = await Promise.all([
      io.keys.exists("outbox-v1"),
      io.keys.exists("service-v1"),
    ]);
    if (outbox && service) return add("trial-keys", "ok", "outbox-v1, service-v1");
    if (outbox || service)
      return add("trial-keys", "error", "trial_keys_incomplete (delete both accounts and rerun)");
    if (!write) return add("trial-keys", "action", "not created");
    if (await exists(paths.serviceAuthorization))
      return add(
        "trial-keys",
        "error",
        `service_authorization_exists_without_key (delete ${paths.serviceAuthorization} and rerun)`,
      );
    await mkdir(dirname(paths.serviceAuthorization), { recursive: true, mode: 0o700 });
    await setupTrialKeys({
      keys: io.keys,
      showApiKey: (apiKey) => {
        try {
          writeFileSync(paths.serviceAuthorization, `Bearer ${apiKey}`, {
            mode: 0o600,
            flag: "wx",
          });
        } catch (error) {
          // The keys are removed on failure, so a partly written file must go too.
          if ((error as NodeJS.ErrnoException).code !== "EEXIST")
            try {
              unlinkSync(paths.serviceAuthorization);
            } catch {}
          throw new Error("service_authorization_unwritable");
        }
      },
    });
    add("trial-keys", "created", "outbox-v1, service-v1");
  });
  await attempt("service-authorization", async () => {
    const current = await readText(paths.serviceAuthorization);
    if (!(await io.keys.exists("service-v1")))
      return add("service-authorization", "action", "needs service-v1");
    const key = await io.keys.read("service-v1");
    try {
      const expected = `Bearer ${key.toString("base64url")}`;
      if (current === expected)
        return add("service-authorization", "ok", paths.serviceAuthorization);
      if (current !== undefined)
        return add(
          "service-authorization",
          "error",
          `service_authorization_mismatch (delete ${paths.serviceAuthorization} and rerun)`,
        );
      if (!write) return add("service-authorization", "action", "not written");
      await writeOwnerOnly(paths.serviceAuthorization, expected);
    } finally {
      key.fill(0);
    }
    add("service-authorization", "created", paths.serviceAuthorization);
  });

  // Relay plugin signing key and config.
  await attempt("relay", async () => {
    const [hasKey, config] = await Promise.all([
      io.keys.exists("relay-v1"),
      readText(paths.relayConfig),
    ]);
    if (hasKey && config !== undefined) {
      const key = await io.keys.read("relay-v1");
      try {
        const parsed = JSON.parse(config) as { url?: string; secret?: string };
        if (parsed.secret !== `whsec_${key.toString("base64")}`)
          return add("relay", "error", "relay_key_mismatch (plugin config and relay-v1 differ)");
        return add("relay", "ok", parsed.url ?? paths.relayConfig);
      } finally {
        key.fill(0);
      }
    }
    if (hasKey || config !== undefined)
      return add(
        "relay",
        "error",
        "relay_incomplete (delete relay-v1 and the plugin config, then rerun)",
      );
    if (!write) return add("relay", "action", "not created");
    await setupRelayKey({ keys: io.keys, configPath: paths.relayConfig, relayPort });
    add("relay", "created", `http://127.0.0.1:${relayPort}/relay`);
  });

  // Runtime control-plane key for tunnel-client (created by a person on Platform).
  await attempt("runtime-key", async () => {
    const current = (await readText(paths.runtimeKey))?.trim();
    if (options.runtimeKey !== undefined) {
      const key = options.runtimeKey.trim();
      if (!runtimeKeyPattern.test(key))
        return add("runtime-key", "error", "runtime_key_format_invalid");
      if (current === key) return add("runtime-key", "ok", paths.runtimeKey);
      if (current !== undefined)
        return add("runtime-key", "error", "runtime_key_exists (delete the file to replace it)");
      if (!write) return add("runtime-key", "action", "not written");
      await writeOwnerOnly(paths.runtimeKey, key);
      return add("runtime-key", "created", paths.runtimeKey);
    }
    if (current !== undefined && runtimeKeyPattern.test(current))
      return add("runtime-key", "ok", paths.runtimeKey);
    if (current !== undefined) return add("runtime-key", "error", "runtime_key_format_invalid");
    add(
      "runtime-key",
      "action",
      `create a Restricted key (Tunnels: Read + Use) at ${setupUrls.apiKeys}`,
    );
  });

  // tunnel-client binary.
  let tunnelClient = await resolveTunnelClient(io, paths);
  await attempt("tunnel-client", async () => {
    if (tunnelClient) return add("tunnel-client", "ok", tunnelClient);
    if (!write || !options.installTunnelClient)
      return add("tunnel-client", "action", "rerun with --install-tunnel-client");
    tunnelClient = await installTunnelClient(io, paths);
    add("tunnel-client", "created", tunnelClient);
  });

  // Tunnel IDs are remembered so later runs need no arguments. A relay port is
  // remembered only once the relay config actually uses it.
  if (!ready("relay")) next.relayPort = settings.relayPort;
  if (write)
    await attempt("settings", () =>
      writeOwnerOnly(paths.settings, `${JSON.stringify(next, null, 2)}\n`, "w"),
    );

  await attempt("status-profile", async () => {
    if (!next.statusTunnelId)
      return add("status-profile", "action", `pass --status-tunnel-id (see ${setupUrls.tunnels})`);
    if (!orcaBin) return add("status-profile", "action", "needs the Orca CLI");
    const command = statusMcpCommand({
      home: io.home,
      nodePath: io.nodePath,
      distDir: io.distDir,
      orcaBin,
    });
    await managedStep(
      "status-profile",
      paths.statusProfile,
      renderStatusProfile(paths, next.statusTunnelId, command),
    );
  });
  await attempt("notification-profile", async () => {
    if (!next.notificationTunnelId)
      return add(
        "notification-profile",
        "skipped",
        "pass --notification-tunnel-id to prepare notifications",
      );
    await managedStep(
      "notification-profile",
      paths.notificationProfile,
      renderNotificationProfile(paths, next.notificationTunnelId),
    );
  });

  const statusReady = ready("status-profile") && ready("runtime-key") && ready("tunnel-client");
  await attempt("status-doctor", async () => {
    if (!statusReady || !tunnelClient) return add("status-doctor", "skipped", "profile not ready");
    const result = await io.exec(tunnelClient, ["doctor", "--profile-file", paths.statusProfile]);
    add(
      "status-doctor",
      result.code === 0 ? "ok" : "error",
      result.code === 0 ? "tunnel-client doctor passed" : "tunnel_client_doctor_failed",
    );
  });

  // LaunchAgent keeps the status Tunnel running across logins and crashes.
  const target = `gui/${io.uid}/${launchAgentLabel}`;
  await attempt("launch-agent", async () => {
    const loaded = (await io.exec("/bin/launchctl", ["print", target])).code === 0;
    if (!write || !options.installAgent)
      return add(
        "launch-agent",
        loaded ? "ok" : "skipped",
        loaded ? target : "rerun with --install-agent to start at login",
      );
    if (!statusReady || !tunnelClient || !ready("status-doctor"))
      return add("launch-agent", "action", "status Tunnel not ready");
    const plist = renderLaunchAgent({ home: io.home, tunnelClient, profile: paths.statusProfile });
    const status = await writeManaged(
      paths.launchAgent,
      plist,
      "managed by orca-dots-bridge setup",
    );
    const inputsChanged = steps.some(
      (s) =>
        ["status-profile", "runtime-key", "tunnel-client"].includes(s.step) &&
        ["created", "updated"].includes(s.status),
    );
    if (status === "ok" && loaded) {
      // Same plist: restart only when what the running client reads has changed.
      if (!inputsChanged) return add("launch-agent", "ok", target);
      const kick = await io.exec("/bin/launchctl", ["kickstart", "-k", target]);
      return add(
        "launch-agent",
        kick.code === 0 ? "updated" : "error",
        kick.code === 0 ? `${target} restarted` : "launchctl_kickstart_failed",
      );
    }
    if (loaded) {
      await io.exec("/bin/launchctl", ["bootout", target]);
      // bootstrap right after bootout fails while the old job is still unloading.
      for (let i = 0; i < 20; i++) {
        if ((await io.exec("/bin/launchctl", ["print", target])).code !== 0) break;
        await io.sleep(250);
      }
    }
    let boot: ExecResult = { code: -1, stdout: "" };
    for (let i = 0; i < 3 && boot.code !== 0; i++) {
      if (i > 0) await io.sleep(1000);
      boot = await io.exec("/bin/launchctl", ["bootstrap", `gui/${io.uid}`, paths.launchAgent]);
    }
    add(
      "launch-agent",
      boot.code === 0 ? (loaded ? "updated" : "created") : "error",
      boot.code === 0 ? target : "launchctl_bootstrap_failed",
    );
  });

  await attempt("status-tunnel", async () => {
    const base = (await readText(paths.statusHealthUrl))?.trim();
    const code = base ? await io.probe(`${base.replace(/\/$/, "")}/readyz`).catch(() => 0) : 0;
    if (code === 200) add("status-tunnel", "ok", "ready");
    else add("status-tunnel", "skipped", "not running");
  });
  return { steps, settings: next };
}

/** What a person still has to do on Platform or in ChatGPT, given the step results. */
export function nextActions(steps: Step[], settings: Partial<Settings>) {
  const status = (name: string) => steps.find((s) => s.step === name)?.status;
  const actions: string[] = [];
  if (status("runtime-key") === "action")
    actions.push(
      `Create a runtime key at ${setupUrls.apiKeys} (Restricted, Tunnels: Read + Use), copy it, then run: pbpaste | node dist/setup.mjs --runtime-key-stdin && pbcopy < /dev/null`,
    );
  if (status("status-profile") === "action" && !settings.statusTunnelId)
    actions.push(
      `Copy the status Tunnel ID from ${setupUrls.tunnels} and rerun with --status-tunnel-id <id>`,
    );
  if (status("status-tunnel") === "ok" && settings.statusTunnelId)
    actions.push(
      `If not done yet, add the plugin once at ${setupUrls.connectors}: custom MCP server, connection type Tunnel (${settings.statusTunnelId}), authentication none`,
    );
  return actions;
}

function exec(file: string, args: string[], env?: Record<string, string>): Promise<ExecResult> {
  return new Promise((resolveExec, reject) => {
    const child = spawn(file, args, {
      stdio: ["ignore", "pipe", "ignore"],
      env: env ? { ...process.env, ...env } : process.env,
    });
    let stdout = "";
    const timer = setTimeout(() => child.kill(), 60000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 1 << 20) stdout += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveExec({ code: code ?? -1, stdout });
    });
  });
}

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const usage = `Usage: setup [doctor] [--status-tunnel-id ID] [--notification-tunnel-id ID] [--relay-port PORT]
             [--runtime-key-stdin] [--install-tunnel-client] [--install-agent] [--json]
Prepares this Mac for dot: notification keys, relay plugin config, tunnel-client, Tunnel profiles
and an optional LaunchAgent for the status Tunnel. "doctor" only checks. Never prints secrets.
`;

export function parseSetupArgs(args: string[]) {
  const options: SetupOptions & { json?: boolean; runtimeKeyStdin?: boolean } = { mode: "setup" };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = () => {
      const next = args[++i];
      if (next === undefined || next.startsWith("--")) throw new Error("missing_value");
      return next;
    };
    if (i === 0 && arg === "doctor") options.mode = "doctor";
    else if (arg === "--status-tunnel-id") options.statusTunnelId = value();
    else if (arg === "--notification-tunnel-id") options.notificationTunnelId = value();
    else if (arg === "--relay-port") options.relayPort = Number(value());
    else if (arg === "--runtime-key-stdin") options.runtimeKeyStdin = true;
    else if (arg === "--install-tunnel-client") options.installTunnelClient = true;
    else if (arg === "--install-agent") options.installAgent = true;
    else if (arg === "--json") options.json = true;
    else throw new Error("unknown_argument");
  }
  if (
    options.mode === "doctor" &&
    (options.runtimeKeyStdin || options.installAgent || options.installTunnelClient)
  )
    throw new Error("doctor_is_read_only");
  return options;
}

const marks: Record<StepStatus, string> = {
  ok: "ok",
  created: "created",
  updated: "updated",
  skipped: "skip",
  action: "todo",
  error: "ERROR",
};

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void (async () => {
    let options: ReturnType<typeof parseSetupArgs>;
    try {
      options = parseSetupArgs(process.argv.slice(2));
    } catch {
      process.stdout.write(usage);
      process.exitCode = 1;
      return;
    }
    if (options.runtimeKeyStdin) {
      if (process.stdin.isTTY) {
        process.stdout.write(
          "Pipe the key in, e.g. pbpaste | node dist/setup.mjs --runtime-key-stdin\n",
        );
        process.exitCode = 1;
        return;
      }
      options.runtimeKey = await readStdin();
    }
    const home = homedir();
    const { steps, settings } = await runSetup(
      {
        home,
        platform: process.platform,
        arch: process.arch,
        uid: process.getuid?.() ?? -1,
        env: process.env,
        nodePath: process.execPath,
        distDir: dirname(fileURLToPath(import.meta.url)),
        keys: createMacKeychain(),
        exec,
        download: async (url) => {
          const response = await fetch(url);
          if (!response.ok) throw new Error("tunnel_client_download_failed");
          return Buffer.from(await response.arrayBuffer());
        },
        probe: async (url) => (await fetch(url, { signal: AbortSignal.timeout(3000) })).status,
        sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      },
      options,
    );
    const actions = nextActions(steps, settings);
    if (options.json)
      process.stdout.write(`${JSON.stringify({ steps, nextActions: actions }, null, 2)}\n`);
    else {
      for (const s of steps)
        process.stdout.write(`[${marks[s.status].padEnd(7)}] ${s.step.padEnd(22)} ${s.detail}\n`);
      if (actions.length > 0)
        process.stdout.write(`\nNext:\n${actions.map((a) => `- ${a}`).join("\n")}\n`);
    }
    if (steps.some((s) => s.status === "error")) process.exitCode = 1;
  })();
}
