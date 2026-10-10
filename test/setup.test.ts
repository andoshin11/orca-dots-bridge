import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  parseSetupArgs,
  recordedNodePath,
  runSetup,
  setupPaths,
  statusMcpCommand,
  type SetupIo,
  type SetupOptions,
} from "../src/setup.js";

const statusTunnel = "tunnel_00000000000000000000000000000001";
const notificationTunnel = "tunnel_00000000000000000000000000000002";
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
  const agent = { loaded: false };
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
        if (args[0] === "print") return { code: agent.loaded ? 0 : 113, stdout: "" };
        if (args[0] === "bootstrap") agent.loaded = true;
        if (args[0] === "bootout") agent.loaded = false;
      }
      return { code: 0, stdout: "" };
    },
    download: async () => {
      throw new Error("no network in tests");
    },
    probe: async () => 0,
    sleep: async () => undefined,
    ...overrides,
  };
  return { io, home, orca, stored, calls, agent, paths: setupPaths(home) };
}

const full: SetupOptions = {
  mode: "setup",
  statusTunnelId: statusTunnel,
  notificationTunnelId: notificationTunnel,
  runtimeKey,
};
const byStep = (steps: { step: string; status: string; detail: string }[]) =>
  Object.fromEntries(steps.map((s) => [s.step, s.status]));

describe("setup", () => {
  test("prepares keys, the Bearer file, the relay config and both profiles without showing a key", async () => {
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
      "status-profile": "created",
      "notification-profile": "created",
      "status-doctor": "ok",
      "launch-agent": "skipped",
    });
    expect(JSON.stringify(steps)).not.toContain(stored.get("service-v1")!.toString("base64url"));
    expect(await readFile(paths.serviceAuthorization, "utf8")).toBe(
      `Bearer ${stored.get("service-v1")!.toString("base64url")}`,
    );
    const relay = JSON.parse(await readFile(paths.relayConfig, "utf8")) as { secret: string };
    expect(relay.secret).toBe(`whsec_${stored.get("relay-v1")!.toString("base64")}`);
    for (const file of [paths.serviceAuthorization, paths.runtimeKey, paths.statusProfile])
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    const profile = await readFile(paths.statusProfile, "utf8");
    expect(profile).toContain(`tunnel_id: "${statusTunnel}"`);
    expect(profile).toContain(`api_key: "file:${paths.runtimeKey}"`);
    expect(profile).not.toContain(runtimeKey);
    expect(await readFile(paths.notificationProfile, "utf8")).toContain(
      `Authorization: "file:${paths.serviceAuthorization}"`,
    );
  });

  test("a second run changes nothing and remembers the Tunnel IDs", async () => {
    const { io, paths } = await fakeIo();
    await executable(join(paths.tunnelClientDir, "tunnel-client"));
    await runSetup(io, full);
    const { steps, settings } = await runSetup(io, { mode: "setup" });
    expect(settings).toMatchObject({
      statusTunnelId: statusTunnel,
      notificationTunnelId: notificationTunnel,
    });
    for (const s of steps.filter((s) => !["launch-agent", "status-tunnel"].includes(s.step)))
      expect([s.step, s.status]).toEqual([s.step, "ok"]);
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
    await mkdir(join(paths.statusProfile, ".."), { recursive: true });
    await writeFile(paths.statusProfile, "hand-made\n");
    const { steps } = await runSetup(io, full);
    expect(steps.find((s) => s.step === "status-profile")).toMatchObject({ status: "error" });
    expect(await readFile(paths.statusProfile, "utf8")).toBe("hand-made\n");
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

  test("installs the LaunchAgent only after the status profile passes doctor", async () => {
    const { io, paths, calls } = await fakeIo();
    await executable(join(paths.tunnelClientDir, "tunnel-client"));
    let { steps } = await runSetup(io, { mode: "setup", installAgent: true });
    expect(byStep(steps)["launch-agent"]).toBe("action");
    ({ steps } = await runSetup(io, { ...full, installAgent: true }));
    expect(byStep(steps)["launch-agent"]).toBe("created");
    expect(calls).toContainEqual({
      file: "/bin/launchctl",
      args: ["bootstrap", "gui/501", paths.launchAgent],
    });
    const plist = await readFile(paths.launchAgent, "utf8");
    expect(plist).toContain(`<string>${paths.statusProfile}</string>`);
    expect(plist).not.toContain(runtimeKey);
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
      { statusTunnelId: "not-a-tunnel" },
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

  test("restarts a loaded agent when the profile changes and reloads it when the plist changes", async () => {
    const { io, paths, calls, agent } = await fakeIo();
    await executable(join(paths.tunnelClientDir, "tunnel-client"));
    await runSetup(io, { ...full, installAgent: true });
    expect(agent.loaded).toBe(true);

    calls.length = 0;
    let { steps } = await runSetup(io, { mode: "setup", installAgent: true });
    expect(byStep(steps)["launch-agent"]).toBe("ok");
    expect(calls.some((c) => c.args[0] === "kickstart")).toBe(false);

    const otherTunnel = "tunnel_0123456789abcdef0123456789abcdef";
    ({ steps } = await runSetup(io, {
      mode: "setup",
      installAgent: true,
      statusTunnelId: otherTunnel,
    }));
    expect(byStep(steps)["launch-agent"]).toBe("updated");
    expect(calls).toContainEqual({
      file: "/bin/launchctl",
      args: ["kickstart", "-k", "gui/501/dev.orca-dots-bridge.status-tunnel"],
    });

    calls.length = 0;
    await writeFile(paths.launchAgent, "<!-- managed by orca-dots-bridge setup -->\nold\n");
    ({ steps } = await runSetup(io, { mode: "setup", installAgent: true }));
    expect(byStep(steps)["launch-agent"]).toBe("updated");
    const order = calls.filter((c) => c.file === "/bin/launchctl").map((c) => c.args[0]);
    expect(order.indexOf("bootout")).toBeLessThan(order.lastIndexOf("bootstrap"));
    expect(agent.loaded).toBe(true);
  });
});

describe("setup with several Node paths", () => {
  test("keeps the Node recorded in the managed profile while it still runs", async () => {
    const { io, paths } = await fakeIo();
    const first = join(io.home, "node-a");
    await executable(first);
    await runSetup({ ...io, nodePath: first }, full);
    const { steps } = await runSetup({ ...io, nodePath: "/elsewhere/node" }, { mode: "setup" });
    expect(steps.find((s) => s.step === "status-profile")?.status).toBe("ok");
    expect(recordedNodePath(await readFile(paths.statusProfile, "utf8"))).toBe(first);
  });

  test("falls back to the current Node when the recorded one is gone", async () => {
    const { io, paths } = await fakeIo();
    await runSetup({ ...io, nodePath: join(io.home, "missing-node") }, full);
    const { steps } = await runSetup(io, { mode: "setup" });
    expect(steps.find((s) => s.step === "status-profile")?.status).toBe("updated");
    expect(recordedNodePath(await readFile(paths.statusProfile, "utf8"))).toBe(io.nodePath);
  });
});

describe("recorded Node edge cases", () => {
  test("an unparsable command line is treated as no recorded Node", () => {
    const marker = "# managed by orca-dots-bridge setup";
    expect(recordedNodePath(`${marker}\n      command: '/bin/node /d/mcp.mjs'\n`)).toBeUndefined();
    expect(recordedNodePath(`${marker}\n      command: 42\n`)).toBeUndefined();
    expect(recordedNodePath('command: "/usr/bin/env -i /n /d/mcp.mjs"')).toBeUndefined();
  });

  test("an old recorded Node or an explicit one is not kept", async () => {
    const { io, paths } = await fakeIo();
    const old = join(io.home, "node-old");
    await executable(old);
    await runSetup({ ...io, nodePath: old }, full);
    const oldIo: SetupIo = {
      ...io,
      exec: async (file, args) =>
        file === old && args[0] === "--version"
          ? { code: 0, stdout: "v18.0.0\n" }
          : io.exec(file, args),
    };
    await runSetup(oldIo, { mode: "setup" });
    expect(recordedNodePath(await readFile(paths.statusProfile, "utf8"))).toBe(io.nodePath);
    const chosen = join(io.home, "node-chosen");
    await runSetup(io, { mode: "setup", nodePath: chosen });
    expect(recordedNodePath(await readFile(paths.statusProfile, "utf8"))).toBe(chosen);
  });
});

describe("setup helpers", () => {
  test("the status MCP command starts from an empty environment and exposes status only", () => {
    const command = statusMcpCommand({
      home: "/Users/a",
      nodePath: "/usr/local/bin/node",
      distDir: "/opt/bridge/dist",
      orcaBin: "/opt/homebrew/bin/orca",
    });
    expect(command).toBe(
      "/usr/bin/env -i HOME=/Users/a PATH=/usr/bin:/bin:/opt/homebrew/bin ORCA_BIN=/opt/homebrew/bin/orca ORCA_ENVIRONMENT= ORCA_PAIRING_CODE= ORCA_BRIDGE_TOOLSET=status-send ORCA_BRIDGE_ENABLE_SEND=1 ORCA_BRIDGE_CHATGPT_SETTINGS=1 ELECTRON_RUN_AS_NODE=1 /usr/local/bin/node /opt/bridge/dist/mcp.mjs",
    );
    expect(() =>
      statusMcpCommand({ home: "/Users/a b", nodePath: "/n", distDir: "/d", orcaBin: "/o" }),
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
    expect(() => parseSetupArgs(["--status-tunnel-id"])).toThrow("missing_value");
  });
});
