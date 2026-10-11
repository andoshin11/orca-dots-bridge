import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  legacyLabels,
  nextActions,
  parseSetupArgs,
  recordedNodePath,
  renderServiceAgent,
  runSetup,
  serviceLabel,
  setupPaths,
  tunnelLabel,
  type SetupIo,
  type SetupOptions,
} from "../src/setup.js";

const tunnelId = "tunnel_00000000000000000000000000000001";
const runtimeKey = `sk-test-${"a".repeat(40)}`;

async function executable(path: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "#!/bin/sh\n");
  await chmod(path, 0o755);
}

async function fakeIo(overrides: Partial<SetupIo> = {}) {
  const home = await mkdtemp(join(tmpdir(), "setup-home-"));
  const orca = join(home, "bin", "orca");
  await executable(orca);
  const stored = new Map<string, Buffer>();
  const calls: { file: string; args: string[] }[] = [];
  const agent = { loaded: new Set<string>() };
  const io: SetupIo = {
    home,
    platform: "darwin",
    arch: "arm64",
    uid: 501,
    env: { ORCA_BIN: orca, PATH: "" },
    nodePath: "/usr/local/bin/node",
    distDir: "/opt/bridge/dist",
    keys: {
      exists: async (account) => stored.has(account),
      read: async (account) => {
        const key = stored.get(account);
        if (!key) throw new Error("keychain_read_failed");
        return Buffer.from(key);
      },
      putNew: async (account, key) => {
        if (stored.has(account)) throw new Error("keychain_account_exists_or_unavailable");
        stored.set(account, Buffer.from(key));
      },
      remove: async (account) => {
        stored.delete(account);
      },
    },
    exec: async (file, args) => {
      calls.push({ file, args });
      if (args[0] === "--version") return { code: 0, stdout: "v24.11.0\n" };
      if (file === orca)
        return {
          code: 0,
          stdout: JSON.stringify({ ok: true, result: { runtime: { reachable: true } } }),
        };
      if (file === "/bin/launchctl") {
        // Each LaunchAgent is tracked by label (print/bootout) and plist file name (bootstrap).
        const label = (args.at(-1) ?? "")
          .split("/")
          .at(-1)!
          .replace(/\.plist$/, "");
        if (args[0] === "print") return { code: agent.loaded.has(label) ? 0 : 113, stdout: "" };
        if (args[0] === "bootstrap") agent.loaded.add(label);
        if (args[0] === "bootout") agent.loaded.delete(label);
      }
      return { code: 0, stdout: "" };
    },
    download: async () => {
      throw new Error("no network in tests");
    },
    // The bridge service answers OAuth discovery with 404 while it listens.
    probe: async (url) =>
      url.endsWith("/oauth-protected-resource") && agent.loaded.has(serviceLabel) ? 404 : 0,
    sleep: async () => undefined,
    ...overrides,
  };
  return { io, home, orca, stored, calls, agent, paths: setupPaths(home) };
}

const full: SetupOptions = { mode: "setup", tunnelId, runtimeKey };
const byStep = (steps: { step: string; status: string; detail: string }[]) =>
  Object.fromEntries(steps.map((s) => [s.step, s.status]));
const managed = "<!-- managed by orca-dots-bridge setup -->\n";

/** Files and loaded agents of the earlier two-Tunnel layout. */
async function legacyInstall(f: Awaited<ReturnType<typeof fakeIo>>) {
  const { paths, agent, home } = f;
  const marker = "# managed by orca-dots-bridge setup\n";
  const node = join(home, "node-legacy");
  await executable(node);
  await mkdir(join(paths.legacy.statusProfile, ".."), { recursive: true });
  await writeFile(
    paths.legacy.statusProfile,
    `${marker}mcp:\n  commands:\n    - channel: main\n      command: "/usr/bin/env -i HOME=/h ${node} /old/dist/mcp.mjs"\n`,
  );
  await writeFile(paths.legacy.notificationProfile, `${marker}mcp:\n`);
  await writeFile(paths.legacy.statusHealthUrl, "http://127.0.0.1:1\n");
  await writeFile(paths.legacy.notificationHealthUrl, "http://127.0.0.1:2\n");
  await mkdir(join(paths.legacy.serviceAgent, ".."), { recursive: true });
  for (const [label, path] of [
    [legacyLabels.statusTunnel, paths.legacy.statusTunnelAgent],
    [legacyLabels.service, paths.legacy.serviceAgent],
    [legacyLabels.notificationTunnel, paths.legacy.notificationTunnelAgent],
  ] as const) {
    await writeFile(path, `${managed}${label}\n`);
    agent.loaded.add(label);
  }
  await mkdir(paths.root, { recursive: true });
  await writeFile(
    paths.settings,
    JSON.stringify({
      statusTunnelId: tunnelId,
      notificationTunnelId: "tunnel_00000000000000000000000000000002",
      relayPort: 8788,
    }),
  );
  return { node };
}

describe("setup", () => {
  test("prepares keys, the Bearer file, the relay config and the one profile without showing a key", async () => {
    const { io, stored, paths } = await fakeIo();
    await executable(join(paths.tunnelClientDir, "tunnel-client"));
    const { steps } = await runSetup(io, full);
    expect(byStep(steps)).toMatchObject({
      orca: "ok",
      "trial-keys": "created",
      "service-authorization": "ok",
      relay: "created",
      "runtime-key": "created",
      "tunnel-client": "ok",
      profile: "created",
      service: "skipped",
      // The profile forwards to the service, which is not running yet.
      "profile-doctor": "skipped",
      "tunnel-agent": "skipped",
    });
    expect(steps.some((s) => s.step.startsWith("legacy-"))).toBe(false);
    expect(JSON.stringify(steps)).not.toContain(stored.get("service-v1")!.toString("base64url"));
    expect(await readFile(paths.serviceAuthorization, "utf8")).toBe(
      `Bearer ${stored.get("service-v1")!.toString("base64url")}`,
    );
    const relay = JSON.parse(await readFile(paths.relayConfig, "utf8")) as { secret: string };
    expect(relay.secret).toBe(`whsec_${stored.get("relay-v1")!.toString("base64")}`);
    for (const file of [paths.serviceAuthorization, paths.runtimeKey, paths.profile])
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(paths.profile.endsWith("/tunnel/profiles/orca-dots-bridge.yaml")).toBe(true);
    const profile = await readFile(paths.profile, "utf8");
    expect(profile).toContain(`tunnel_id: "${tunnelId}"`);
    expect(profile).toContain(`api_key: "file:${paths.runtimeKey}"`);
    expect(profile).toContain('url: "http://127.0.0.1:8787/mcp"');
    expect(profile).toContain(`Authorization: "file:${paths.serviceAuthorization}"`);
    expect(profile).toContain(`url_file: "${paths.healthUrl}"`);
    expect(profile).not.toContain(runtimeKey);
    expect(JSON.parse(await readFile(paths.settings, "utf8")).tunnelId).toBe(tunnelId);
  });

  test("a second run changes nothing and remembers the Tunnel ID", async () => {
    const { io, paths } = await fakeIo();
    await executable(join(paths.tunnelClientDir, "tunnel-client"));
    await runSetup(io, full);
    const { steps, settings } = await runSetup(io, { mode: "setup" });
    expect(settings).toMatchObject({ tunnelId });
    const optional = ["service", "profile-doctor", "tunnel-agent", "tunnel"];
    for (const s of steps.filter((s) => !optional.includes(s.step)))
      expect([s.step, s.status]).toEqual([s.step, "ok"]);
  });

  test("--install-agent runs the bridge service, then the Tunnel that waits for it", async () => {
    const { io, paths, calls, agent } = await fakeIo();
    await executable(join(paths.tunnelClientDir, "tunnel-client"));
    const { steps } = await runSetup(io, { ...full, installAgent: true });
    expect(byStep(steps)).toMatchObject({
      service: "created",
      "profile-doctor": "ok",
      "tunnel-agent": "created",
    });
    const service = await readFile(paths.serviceAgent, "utf8");
    expect(service).toContain("<string>dev.orca-dots-bridge.service</string>");
    expect(service).toContain("<string>ELECTRON_RUN_AS_NODE=1</string>");
    expect(service).toContain("/opt/bridge/dist/bridge-service.mjs");
    expect(service).toContain("<string>-i</string>");
    expect(service).not.toContain(runtimeKey);
    const tunnel = await readFile(paths.tunnelAgent, "utf8");
    expect(tunnel).toContain("<string>dev.orca-dots-bridge.tunnel</string>");
    expect(tunnel).toContain(paths.profile);
    // tunnel-client checks its target once, so it waits for the service to listen.
    expect(tunnel).toContain("until /usr/bin/nc -z 127.0.0.1 8787; do sleep 1; done; exec");
    expect(tunnel).not.toContain(runtimeKey);
    const booted = calls
      .filter((c) => c.file === "/bin/launchctl" && c.args[0] === "bootstrap")
      .map((c) => c.args[2]);
    expect(booted).toEqual([paths.serviceAgent, paths.tunnelAgent]);
    expect([...agent.loaded].sort()).toEqual([serviceLabel, tunnelLabel].sort());
  });

  test("moves an earlier two-Tunnel install to the one service and Tunnel, in a safe order", async () => {
    const f = await fakeIo();
    const { io, paths, calls, agent } = f;
    await executable(join(paths.tunnelClientDir, "tunnel-client"));
    const { node } = await legacyInstall(f);
    await writeFile(paths.legacy.statusProfile.replace("orca-status", "hand-made"), "mine\n");
    // Doctor only reports what is left of the earlier layout.
    let { steps, settings } = await runSetup(io, { mode: "doctor", runtimeKey });
    expect(settings.tunnelId).toBe(tunnelId);
    expect(byStep(steps)).toMatchObject({
      "legacy-service": "action",
      "legacy-status-tunnel": "action",
      "legacy-notification-tunnel": "action",
      "legacy-profiles": "action",
    });
    expect(nextActions(steps, settings).join("\n")).toContain("--install-agent");
    expect(agent.loaded.has(legacyLabels.service)).toBe(true);

    calls.length = 0;
    ({ steps, settings } = await runSetup(io, {
      ...full,
      tunnelId: undefined,
      installAgent: true,
    }));
    expect(byStep(steps)).toMatchObject({
      profile: "created",
      "legacy-service": "updated",
      service: "created",
      "legacy-status-tunnel": "updated",
      "tunnel-agent": "created",
      "legacy-notification-tunnel": "updated",
      "legacy-profiles": "updated",
    });
    // Port 8787 is freed before the new service starts, and the Tunnel ID is never served twice.
    const order = calls
      .filter((c) => c.file === "/bin/launchctl" && ["bootout", "bootstrap"].includes(c.args[0]!))
      .map((c) => `${c.args[0]} ${(c.args.at(-1) ?? "").split("/").at(-1)}`);
    expect(order).toEqual([
      `bootout ${legacyLabels.service}`,
      `bootstrap ${serviceLabel}.plist`,
      `bootout ${legacyLabels.statusTunnel}`,
      `bootstrap ${tunnelLabel}.plist`,
      `bootout ${legacyLabels.notificationTunnel}`,
    ]);
    expect([...agent.loaded].sort()).toEqual([serviceLabel, tunnelLabel].sort());
    for (const gone of [
      paths.legacy.serviceAgent,
      paths.legacy.statusTunnelAgent,
      paths.legacy.notificationTunnelAgent,
      paths.legacy.statusProfile,
      paths.legacy.notificationProfile,
      paths.legacy.statusHealthUrl,
      paths.legacy.notificationHealthUrl,
    ])
      await expect(stat(gone)).rejects.toMatchObject({ code: "ENOENT" });
    // Unrelated files stay, and the earlier Node keeps running the service.
    expect(
      await readFile(paths.legacy.statusProfile.replace("orca-status", "hand-made"), "utf8"),
    ).toBe("mine\n");
    expect(recordedNodePath(await readFile(paths.serviceAgent, "utf8"))).toBe(node);
    const saved = JSON.parse(await readFile(paths.settings, "utf8"));
    expect(saved).toEqual({ relayPort: 8788, tunnelId });
    const actions = nextActions(steps, settings).join("\n");
    expect(actions).toContain("ツールを更新");
    expect(actions).toContain("delete it");

    // Nothing of the earlier layout is left to report.
    ({ steps } = await runSetup(io, { mode: "doctor" }));
    expect(steps.some((s) => s.step.startsWith("legacy-"))).toBe(false);
  });

  test("keeps the earlier Tunnels running while the new service cannot start", async () => {
    const f = await fakeIo();
    const { io, paths, agent } = f;
    await executable(join(paths.tunnelClientDir, "tunnel-client"));
    await legacyInstall(f);
    // The new service never listens.
    io.probe = async () => 0;
    const { steps } = await runSetup(io, { ...full, installAgent: true });
    expect(byStep(steps)).toMatchObject({
      "legacy-service": "updated",
      service: "error",
      "tunnel-agent": "action",
      "legacy-status-tunnel": "action",
      "legacy-notification-tunnel": "action",
      "legacy-profiles": "action",
    });
    expect(agent.loaded.has(legacyLabels.statusTunnel)).toBe(true);
    expect(agent.loaded.has(tunnelLabel)).toBe(false);
    expect(await readFile(paths.legacy.statusProfile, "utf8")).toContain("managed by");
  });

  test("never deletes a LaunchAgent plist it did not write", async () => {
    const f = await fakeIo();
    const { io, paths, agent } = f;
    await executable(join(paths.tunnelClientDir, "tunnel-client"));
    await legacyInstall(f);
    await writeFile(paths.legacy.notificationTunnelAgent, "hand-made\n");
    const { steps } = await runSetup(io, { ...full, installAgent: true });
    expect(steps.find((s) => s.step === "legacy-notification-tunnel")).toMatchObject({
      status: "action",
      detail: `unmanaged_file_kept (remove ${paths.legacy.notificationTunnelAgent})`,
    });
    expect(agent.loaded.has(legacyLabels.notificationTunnel)).toBe(false);
    expect(await readFile(paths.legacy.notificationTunnelAgent, "utf8")).toBe("hand-made\n");
  });

  test("doctor reports a loaded bridge service that is not listening", async () => {
    const { io, paths } = await fakeIo();
    await executable(join(paths.tunnelClientDir, "tunnel-client"));
    await runSetup(io, { ...full, installAgent: true });
    await mkdir(join(paths.root, "notifications"), { recursive: true });
    await writeFile(join(paths.root, "notifications", "last-error"), "keychain_read_failed\n");
    io.probe = async () => 0;
    let { steps } = await runSetup(io, { mode: "doctor" });
    expect(steps.find((s) => s.step === "service")).toMatchObject({
      status: "error",
      detail: "not listening on 8787 (keychain_read_failed)",
    });
    io.probe = async (url) => (url.endsWith("/oauth-protected-resource") ? 404 : 0);
    ({ steps } = await runSetup(io, { mode: "doctor" }));
    expect(byStep(steps).service).toBe("ok");
  });

  test("doctor reports a service LaunchAgent that still points at an earlier runtime", async () => {
    const { io, paths } = await fakeIo();
    await executable(join(paths.tunnelClientDir, "tunnel-client"));
    await runSetup(io, { ...full, installAgent: true });
    const moved = { ...io, distDir: "/opt/bridge-next/dist" };
    let { steps } = await runSetup(moved, { mode: "doctor" });
    expect(steps.find((s) => s.step === "service")).toMatchObject({
      status: "action",
      detail: "outdated (rerun with --install-agent)",
    });
    ({ steps } = await runSetup(moved, { mode: "setup", installAgent: true }));
    expect(byStep(steps).service).toBe("updated");
    expect(await readFile(paths.serviceAgent, "utf8")).toContain("/opt/bridge-next/dist/");
  });

  test("keeps hand-added notification callback hosts in settings.json", async () => {
    const { io, paths } = await fakeIo();
    await runSetup(io, full);
    const saved = JSON.parse(await readFile(paths.settings, "utf8"));
    await writeFile(
      paths.settings,
      JSON.stringify({ ...saved, notificationCallbackHosts: ["hooks.example.com"] }),
    );
    await runSetup(io, { mode: "setup", relayPort: 8790 });
    expect(JSON.parse(await readFile(paths.settings, "utf8")).notificationCallbackHosts).toEqual([
      "hooks.example.com",
    ]);
  });

  test("doctor writes nothing", async () => {
    const { io, stored, paths } = await fakeIo();
    const { steps } = await runSetup(io, { ...full, mode: "doctor", runtimeKey: undefined });
    expect(stored.size).toBe(0);
    await expect(stat(paths.root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(byStep(steps)).toMatchObject({ "trial-keys": "action", "runtime-key": "action" });
  });

  test("restores a missing Bearer file from service-v1", async () => {
    const { io, stored, paths } = await fakeIo();
    stored.set("outbox-v1", Buffer.alloc(32, 1));
    stored.set("service-v1", Buffer.alloc(32, 2));
    const { steps } = await runSetup(io, { mode: "setup" });
    expect(byStep(steps)["service-authorization"]).toBe("created");
    expect(await readFile(paths.serviceAuthorization, "utf8")).toBe(
      `Bearer ${Buffer.alloc(32, 2).toString("base64url")}`,
    );
  });

  test("refuses half-made key sets and mismatched relay keys instead of repairing them", async () => {
    const { io, stored, paths } = await fakeIo();
    stored.set("service-v1", Buffer.alloc(32, 2));
    stored.set("relay-v1", Buffer.alloc(32, 3));
    await mkdir(join(paths.relayConfig, ".."), { recursive: true });
    await writeFile(paths.relayConfig, JSON.stringify({ secret: "whsec_other" }));
    const { steps } = await runSetup(io, { mode: "setup" });
    expect(byStep(steps)).toMatchObject({ "trial-keys": "error", relay: "error" });
    expect(stored.has("outbox-v1")).toBe(false);
  });

  test("never replaces a profile it did not generate", async () => {
    const { io, paths } = await fakeIo();
    await mkdir(join(paths.profile, ".."), { recursive: true });
    await writeFile(paths.profile, "hand-made\n");
    const { steps } = await runSetup(io, full);
    expect(steps.find((s) => s.step === "profile")).toMatchObject({ status: "error" });
    expect(await readFile(paths.profile, "utf8")).toBe("hand-made\n");
  });

  test("rejects malformed runtime keys and replaces a stored one only when asked", async () => {
    const { io, paths } = await fakeIo();
    let { steps } = await runSetup(io, { mode: "setup", runtimeKey: "not-a-key" });
    expect(byStep(steps)["runtime-key"]).toBe("error");
    await runSetup(io, { mode: "setup", runtimeKey });
    const rotated = `sk-${"b".repeat(40)}`;
    ({ steps } = await runSetup(io, { mode: "setup", runtimeKey: rotated }));
    expect(byStep(steps)["runtime-key"]).toBe("error");
    expect((await readFile(paths.runtimeKey, "utf8")).trim()).toBe(runtimeKey);

    ({ steps } = await runSetup(io, {
      mode: "doctor",
      runtimeKey: rotated,
      replaceRuntimeKey: true,
    }));
    expect(byStep(steps)["runtime-key"]).toBe("action");
    ({ steps } = await runSetup(io, {
      mode: "setup",
      runtimeKey: rotated,
      replaceRuntimeKey: true,
    }));
    expect(byStep(steps)["runtime-key"]).toBe("updated");
    expect((await readFile(paths.runtimeKey, "utf8")).trim()).toBe(rotated);
    expect((await stat(paths.runtimeKey)).mode & 0o777).toBe(0o600);
  });

  test("tightens a runtime key file whose permissions are too open", async () => {
    const { io, paths } = await fakeIo();
    await runSetup(io, { mode: "setup", runtimeKey });
    await chmod(paths.runtimeKey, 0o644);
    let { steps } = await runSetup(io, { mode: "doctor" });
    expect(byStep(steps)["runtime-key"]).toBe("action");
    expect((await stat(paths.runtimeKey)).mode & 0o777).toBe(0o644);
    ({ steps } = await runSetup(io, { mode: "setup" }));
    expect(byStep(steps)["runtime-key"]).toBe("ok");
    expect((await stat(paths.runtimeKey)).mode & 0o777).toBe(0o600);
  });

  test("does not extract a tunnel-client archive whose digest is not the pinned one", async () => {
    const { io, calls } = await fakeIo({ download: async () => Buffer.from("tampered") });
    const { steps } = await runSetup(io, { mode: "setup", installTunnelClient: true });
    expect(steps.find((s) => s.step === "tunnel-client")).toMatchObject({
      status: "error",
      detail: "tunnel_client_digest_mismatch",
    });
    expect(calls.some((c) => c.file === "/usr/bin/ditto")).toBe(false);
  });

  test("installs the Tunnel LaunchAgent only once the profile is ready and passes doctor", async () => {
    const { io, paths, agent } = await fakeIo();
    await executable(join(paths.tunnelClientDir, "tunnel-client"));
    let { steps } = await runSetup(io, { mode: "setup", installAgent: true });
    expect(byStep(steps)["tunnel-agent"]).toBe("action");
    const failing: SetupIo = {
      ...io,
      exec: async (file, args) =>
        args[0] === "doctor" ? { code: 1, stdout: "" } : io.exec(file, args),
    };
    ({ steps } = await runSetup(failing, { ...full, installAgent: true }));
    expect(byStep(steps)).toMatchObject({ "profile-doctor": "error", "tunnel-agent": "action" });
    expect(agent.loaded.has(tunnelLabel)).toBe(false);
    ({ steps } = await runSetup(io, { ...full, installAgent: true }));
    expect(byStep(steps)["tunnel-agent"]).toBe("created");
    const plist = await readFile(paths.tunnelAgent, "utf8");
    expect(plist).toContain(`'${paths.profile}'`);
  });
});

describe("setup after review", () => {
  test("reports a Bearer file that no longer matches service-v1", async () => {
    const { io, stored, paths } = await fakeIo();
    stored.set("outbox-v1", Buffer.alloc(32, 1));
    stored.set("service-v1", Buffer.alloc(32, 2));
    await mkdir(join(paths.serviceAuthorization, ".."), { recursive: true });
    await writeFile(paths.serviceAuthorization, "Bearer stale");
    const { steps } = await runSetup(io, { mode: "setup" });
    expect(steps.find((s) => s.step === "service-authorization")?.detail).toMatch(
      /^service_authorization_mismatch/,
    );
    expect(await readFile(paths.serviceAuthorization, "utf8")).toBe("Bearer stale");
  });

  test("checks arguments before creating anything and never saves an invalid port", async () => {
    const { io, stored, paths } = await fakeIo();
    for (const options of [
      { relayPort: 80 },
      { tunnelId: "not-a-tunnel" },
    ] as Partial<SetupOptions>[]) {
      const { steps } = await runSetup(io, { mode: "setup", ...options });
      expect(steps.every((s) => s.step === "settings" && s.status === "error")).toBe(true);
    }
    expect(stored.size).toBe(0);
    await expect(stat(paths.settings)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("reports unreadable settings instead of crashing", async () => {
    const { io, paths } = await fakeIo();
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.settings, "{broken");
    const { steps } = await runSetup(io, { mode: "doctor" });
    expect(steps).toEqual([expect.objectContaining({ step: "settings", status: "error" })]);
  });

  test("doctor never writes a runtime key even when one is passed", async () => {
    const { io, paths } = await fakeIo();
    await runSetup(io, { mode: "doctor", runtimeKey });
    await expect(stat(paths.runtimeKey)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("restarts the Tunnel when the profile changes and reloads it when the plist changes", async () => {
    const { io, paths, calls, agent } = await fakeIo();
    await executable(join(paths.tunnelClientDir, "tunnel-client"));
    await runSetup(io, { ...full, installAgent: true });
    expect(agent.loaded.has(tunnelLabel)).toBe(true);

    calls.length = 0;
    let { steps } = await runSetup(io, { mode: "setup", installAgent: true });
    expect(byStep(steps)).toMatchObject({ service: "ok", "tunnel-agent": "ok" });
    expect(calls.some((c) => c.args[0] === "kickstart")).toBe(false);

    const otherTunnel = "tunnel_0123456789abcdef0123456789abcdef";
    ({ steps } = await runSetup(io, { mode: "setup", installAgent: true, tunnelId: otherTunnel }));
    expect(byStep(steps)["tunnel-agent"]).toBe("updated");
    expect(calls).toContainEqual({
      file: "/bin/launchctl",
      args: ["kickstart", "-k", "gui/501/dev.orca-dots-bridge.tunnel"],
    });

    calls.length = 0;
    await writeFile(paths.tunnelAgent, `${managed}old\n`);
    ({ steps } = await runSetup(io, { mode: "setup", installAgent: true }));
    expect(byStep(steps)["tunnel-agent"]).toBe("updated");
    const order = calls.filter((c) => c.file === "/bin/launchctl").map((c) => c.args[0]);
    expect(order.indexOf("bootout")).toBeLessThan(order.lastIndexOf("bootstrap"));
    expect(agent.loaded.has(tunnelLabel)).toBe(true);
  });

  test("accepts --status-tunnel-id from older commands as the one Tunnel ID", () => {
    expect(parseSetupArgs(["--status-tunnel-id", tunnelId]).tunnelId).toBe(tunnelId);
    expect(parseSetupArgs(["--tunnel-id", tunnelId]).tunnelId).toBe(tunnelId);
    expect(() => parseSetupArgs(["--notification-tunnel-id", tunnelId])).toThrow(
      "unknown_argument",
    );
    expect(() => parseSetupArgs(["--install-notifications"])).toThrow("unknown_argument");
  });
});

describe("setup with several Node paths", () => {
  test("keeps the Node recorded in the service LaunchAgent while it still runs", async () => {
    const { io, paths } = await fakeIo();
    await executable(join(paths.tunnelClientDir, "tunnel-client"));
    const first = join(io.home, "node-a");
    await executable(first);
    await runSetup({ ...io, nodePath: first }, { ...full, installAgent: true });
    const { steps } = await runSetup(
      { ...io, nodePath: "/elsewhere/node" },
      { mode: "setup", installAgent: true },
    );
    expect(byStep(steps).service).toBe("ok");
    expect(recordedNodePath(await readFile(paths.serviceAgent, "utf8"))).toBe(first);
  });

  test("falls back to the current Node when the recorded one is gone", async () => {
    const { io, paths } = await fakeIo();
    await executable(join(paths.tunnelClientDir, "tunnel-client"));
    await runSetup(
      { ...io, nodePath: join(io.home, "missing-node") },
      { ...full, installAgent: true },
    );
    const { steps } = await runSetup(io, { mode: "setup", installAgent: true });
    expect(byStep(steps).service).toBe("updated");
    expect(recordedNodePath(await readFile(paths.serviceAgent, "utf8"))).toBe(io.nodePath);
  });
});

describe("recorded Node edge cases", () => {
  test("an unparsable command line is treated as no recorded Node", () => {
    const marker = "# managed by orca-dots-bridge setup";
    expect(recordedNodePath(`${marker}\n      command: '/bin/node /d/mcp.mjs'\n`)).toBeUndefined();
    expect(recordedNodePath(`${marker}\n      command: 42\n`)).toBeUndefined();
    expect(recordedNodePath('command: "/usr/bin/env -i /n /d/mcp.mjs"')).toBeUndefined();
    expect(recordedNodePath(`${managed}<plist><dict></dict></plist>`)).toBeUndefined();
  });

  test("reads the Node from a service LaunchAgent and from an earlier status profile", () => {
    const plist = renderServiceAgent({
      home: "/Users/a",
      nodePath: "/opt/node/bin/node",
      distDir: "/opt/bridge/dist",
      orcaBin: "/opt/homebrew/bin/orca",
    });
    expect(recordedNodePath(plist)).toBe("/opt/node/bin/node");
    expect(
      recordedNodePath(
        '# managed by orca-dots-bridge setup\n      command: "/usr/bin/env -i HOME=/h /n/node /d/mcp.mjs"\n',
      ),
    ).toBe("/n/node");
  });

  test("an old recorded Node or an explicit one is not kept", async () => {
    const { io, paths } = await fakeIo();
    await executable(join(paths.tunnelClientDir, "tunnel-client"));
    const old = join(io.home, "node-old");
    await executable(old);
    await runSetup({ ...io, nodePath: old }, { ...full, installAgent: true });
    const oldIo: SetupIo = {
      ...io,
      exec: async (file, args) =>
        file === old && args[0] === "--version"
          ? { code: 0, stdout: "v18.0.0\n" }
          : io.exec(file, args),
    };
    await runSetup(oldIo, { mode: "setup", installAgent: true });
    expect(recordedNodePath(await readFile(paths.serviceAgent, "utf8"))).toBe(io.nodePath);
    const chosen = join(io.home, "node-chosen");
    await runSetup(io, { mode: "setup", installAgent: true, nodePath: chosen });
    expect(recordedNodePath(await readFile(paths.serviceAgent, "utf8"))).toBe(chosen);
  });
});

describe("setup helpers", () => {
  test("the service starts from an empty environment and rejects paths with spaces", () => {
    const plist = renderServiceAgent({
      home: "/Users/a",
      nodePath: "/usr/local/bin/node",
      distDir: "/opt/bridge/dist",
      orcaBin: "/opt/homebrew/bin/orca",
    });
    for (const arg of [
      "/usr/bin/env",
      "-i",
      "HOME=/Users/a",
      "PATH=/usr/bin:/bin:/opt/homebrew/bin",
      "ORCA_BIN=/opt/homebrew/bin/orca",
      "ORCA_ENVIRONMENT=",
      "ORCA_PAIRING_CODE=",
      "/opt/bridge/dist/bridge-service.mjs",
    ])
      expect(plist).toContain(`<string>${arg}</string>`);
    expect(() =>
      renderServiceAgent({ home: "/Users/a b", nodePath: "/n", distDir: "/d", orcaBin: "/o" }),
    ).toThrow("path_with_whitespace_unsupported");
  });

  test("argument parsing keeps doctor read-only and rejects unknown flags", () => {
    expect(parseSetupArgs(["doctor"]).mode).toBe("doctor");
    expect(() => parseSetupArgs(["doctor", "--install-agent"])).toThrow("doctor_is_read_only");
    expect(() => parseSetupArgs(["--force"])).toThrow("unknown_argument");
    expect(parseSetupArgs(["--runtime-key-stdin", "--replace-runtime-key"]).replaceRuntimeKey).toBe(
      true,
    );
    expect(() => parseSetupArgs(["doctor", "--replace-runtime-key"])).toThrow(
      "doctor_is_read_only",
    );
    expect(() => parseSetupArgs(["--tunnel-id"])).toThrow("missing_value");
  });
});
