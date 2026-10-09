import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
const mock = vi.hoisted(() => ({
  createServer: vi.fn(),
  store: { load: vi.fn(), save: vi.fn(), close: vi.fn() },
  keys: { read: vi.fn(), remove: vi.fn() },
  endpoint: { fetch: vi.fn(), close: vi.fn() },
  describeTarget: vi.fn(),
}));
vi.mock("node:http", () => ({ createServer: mock.createServer }));
vi.mock("../src/events/file-store.js", () => ({ openAtomicStore: async () => mock.store }));
vi.mock("../src/events/keychain.js", () => ({ createMacKeychain: () => mock.keys }));
vi.mock("../src/events/service-endpoint.js", async (importOriginal) => ({
  // trial-runner also builds sessionMonitor/paneMonitor; only the endpoint itself is faked.
  ...(await importOriginal<typeof import("../src/events/service-endpoint.js")>()),
  createServiceNotificationEndpoint: vi.fn(async () => mock.endpoint),
}));
vi.mock("../src/events/runtime-transport.js", () => ({
  createRuntimeEventTransport: () => ({ describe: mock.describeTarget, open: vi.fn() }),
}));
import { digest } from "../src/events/model.js";
import { startNotificationTrial } from "../src/events/trial-runner.js";
const target = {
  executionHostId: "local",
  worktreeId: "fixture",
  terminalHandle: "term_fixture",
  paneKey: "pane",
  incarnationId: "gen",
  launchId: "launch",
  providerSessionId: "session",
};
const config = {
  directory: "/synthetic/state",
  target,
  runtime: { endpoint: "/synthetic/socket", runtimeId: "fixture" },
  callbackApproval: {
    host: "receiver.example.com",
    urlHash: "a".repeat(64),
    owner: "service:trial-service-v1",
    targetHash: "b".repeat(64),
    expiresAt: 0,
  },
};
function setup(failListen = false) {
  vi.useFakeTimers();
  vi.clearAllMocks();
  config.callbackApproval.expiresAt = Date.now() + 600000;
  mock.store.load.mockResolvedValue(null);
  mock.store.close.mockResolvedValue(undefined);
  mock.endpoint.close.mockResolvedValue(undefined);
  const buffers: Buffer[] = [];
  mock.keys.read.mockImplementation(async () => {
    const key = Buffer.alloc(32, 6);
    buffers.push(key);
    return key;
  });
  mock.keys.remove.mockResolvedValue(undefined);
  const server = Object.assign(new EventEmitter(), {
    requestTimeout: 0,
    headersTimeout: 0,
    timeout: 0,
    listen: vi.fn((_port: number, _host: string, ready: () => void) => {
      if (failListen) server.emit("error", new Error("fixture bind failure"));
      else ready();
    }),
    close: vi.fn((done: () => void) => done()),
    closeAllConnections: vi.fn(),
  });
  mock.createServer.mockReturnValue(server);
  return { server, buffers };
}
afterEach(() => vi.useRealTimers());
it("binds only loopback and stops after ten minutes, removing trial state and wiping key buffers", async () => {
  const { server, buffers } = setup();
  const trial = await startNotificationTrial(config, "synthetic-runtime-token");
  expect(server.listen).toHaveBeenCalledWith(8787, "127.0.0.1", expect.any(Function));
  await vi.advanceTimersByTimeAsync(600000);
  await trial.close();
  expect(mock.endpoint.close).toHaveBeenCalledTimes(1);
  expect(mock.store.close).toHaveBeenCalledWith(true);
  expect(buffers.every((key) => key.equals(Buffer.alloc(32)))).toBe(true);
  expect(mock.keys.remove).not.toHaveBeenCalled();
  await trial.deleteTrialKeys();
  expect(mock.keys.remove.mock.calls).toEqual([["service-v1"], ["outbox-v1"]]);
});
it("does not delete previous trial state or read keys when existing state is found", async () => {
  setup();
  mock.store.load.mockResolvedValue("old-state");
  await expect(startNotificationTrial(config, "synthetic-runtime-token")).rejects.toThrow(
    "trial_state_already_exists",
  );
  expect(mock.store.close).toHaveBeenCalledWith();
  expect(mock.keys.read).not.toHaveBeenCalled();
});
it("cleans up a failed listener without revealing the underlying error", async () => {
  const { buffers } = setup(true);
  await expect(startNotificationTrial(config, "synthetic-runtime-token")).rejects.toThrow(
    "trial_start_failed",
  );
  expect(mock.store.close).toHaveBeenCalledWith(true);
  expect(buffers.every((key) => key.equals(Buffer.alloc(32)))).toBe(true);
});
it("rejects wrong host, browser-origin and oversized requests before invoking MCP", async () => {
  setup();
  const trial = await startNotificationTrial(config, "synthetic-runtime-token");
  const handler = mock.createServer.mock.calls[0]![0];
  for (const headers of [
    { host: "attacker.test" },
    { host: "127.0.0.1:8787", origin: "https://attacker.test" },
  ]) {
    const res = Object.assign(new EventEmitter(), {
      writeHead: vi.fn().mockReturnThis(),
      end: vi.fn(),
    });
    await handler(Object.assign(new EventEmitter(), { url: "/mcp", method: "POST", headers }), res);
    expect(res.writeHead).toHaveBeenCalledWith(403);
  }
  const res = Object.assign(new EventEmitter(), {
    writeHead: vi.fn().mockReturnThis(),
    end: vi.fn(),
  });
  await handler(
    Object.assign(new EventEmitter(), {
      url: "/mcp",
      method: "POST",
      headers: { host: "127.0.0.1:8787" },
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(262145);
      },
    }),
    res,
  );
  expect(res.writeHead).toHaveBeenCalledWith(413);
  expect(mock.endpoint.fetch).not.toHaveBeenCalled();
  await trial.close();
});

it("reports cleanup failure through completion and never deletes unapproved keys", async () => {
  setup();
  const trial = await startNotificationTrial(config, "synthetic-runtime-token");
  mock.store.close.mockRejectedValue(new Error("synthetic storage failure"));
  await expect(trial.close()).rejects.toThrow("synthetic storage failure");
  await expect(trial.finished).rejects.toThrow("synthetic storage failure");
  expect(mock.keys.remove).not.toHaveBeenCalled();
});

it("reports absent OAuth discovery without admitting browser or foreign-host requests", async () => {
  setup();
  const trial = await startNotificationTrial(config, "synthetic-runtime-token");
  const handler = mock.createServer.mock.calls[0]![0];
  for (const url of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ]) {
    for (const [headers, status] of [
      [{ host: "127.0.0.1:8787" }, 404],
      [{ host: "attacker.test" }, 403],
      [{ host: "127.0.0.1:8787", origin: "https://attacker.test" }, 403],
    ] as const) {
      const res = Object.assign(new EventEmitter(), {
        writeHead: vi.fn().mockReturnThis(),
        end: vi.fn(),
      });
      await handler(Object.assign(new EventEmitter(), { url, method: "GET", headers }), res);
      expect(res.writeHead).toHaveBeenCalledWith(status);
    }
  }
  expect(mock.endpoint.fetch).not.toHaveBeenCalled();
  await trial.close();
});

it("revalidates live target before callback and checks expiry again after IPC", async () => {
  setup();
  const url = "https://receiver.example.com/synthetic";
  config.callbackApproval.urlHash = digest(url);
  config.callbackApproval.targetHash = digest(target);
  const trial = await startNotificationTrial(config, "synthetic-runtime-token");
  const guard = mock.endpoint.fetch;
  guard.mockClear();
  const options = (await import("../src/events/service-endpoint.js"))
    .createServiceNotificationEndpoint;
  const before = vi.mocked(options).mock.calls.at(-1)![0].beforeSubscribe!;
  const params = {
    name: "orca.session_activity",
    arguments: target,
    delivery: { mode: "webhook", url, secret: "whsec_" + Buffer.alloc(32, 7).toString("base64") },
  };
  mock.describeTarget.mockResolvedValue({ ...target, incarnationId: "changed" });
  await expect(before("service:trial-service-v1", params)).rejects.toThrow(
    "runtime_target_changed",
  );
  mock.describeTarget.mockImplementation(async () => {
    vi.setSystemTime(config.callbackApproval.expiresAt);
    return target;
  });
  await expect(before("service:trial-service-v1", params)).rejects.toThrow(
    "callback_approval_required",
  );
  await trial.close();
});

it("writes fixed approved lifecycle diagnostics outside encrypted state and retains them after stop", async () => {
  setup();
  const directory = mkdtempSync(join(tmpdir(), "synthetic-trial-diagnostics-"));
  const path = join(directory, "approved-diagnostics.json");
  try {
    const trial = await startNotificationTrial(
      { ...config, diagnosticsPath: path },
      "synthetic-runtime-token",
    );
    expect(JSON.parse(readFileSync(path, "utf8")).counts.running).toBe(1);
    await trial.close();
    const text = readFileSync(path, "utf8");
    expect(JSON.parse(text).counts.stopped).toBe(1);
    expect(text).not.toContain("synthetic-runtime-token");
    expect(text).not.toContain(config.callbackApproval.urlHash);
    expect(text).not.toContain(config.callbackApproval.host);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
it("refuses existing approved diagnostics before reading keys or overwriting records", async () => {
  setup();
  const directory = mkdtempSync(join(tmpdir(), "synthetic-trial-diagnostics-"));
  const path = join(directory, "approved-diagnostics.json");
  writeFileSync(path, "retained", { mode: 0o600 });
  try {
    await expect(
      startNotificationTrial({ ...config, diagnosticsPath: path }, "synthetic-runtime-token"),
    ).rejects.toThrow("diagnostics_unavailable");
    expect(mock.keys.read).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf8")).toBe("retained");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
