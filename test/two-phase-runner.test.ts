import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  read: vi.fn(),
  load: vi.fn(),
  storeClose: vi.fn(),
  close: vi.fn(),
  activate: vi.fn(),
  endpoint: vi.fn(),
  server: vi.fn(),
}));
vi.mock("node:http", () => ({ createServer: mock.server }));
vi.mock("../src/events/keychain.js", () => ({
  createMacKeychain: () => ({ read: mock.read, remove: vi.fn() }),
}));
vi.mock("../src/events/file-store.js", () => ({
  openAtomicStore: async () => ({ load: mock.load, save: vi.fn(), close: mock.storeClose }),
}));
vi.mock("../src/events/runtime-transport.js", () => ({
  createRuntimeEventTransport: () => ({ describe: vi.fn(), open: vi.fn() }),
}));
vi.mock("../src/events/two-phase-endpoint.js", async (original) => ({
  ...(await original<object>()),
  createTwoPhaseEndpoint: mock.endpoint,
}));
import { startTwoPhaseTrial } from "../src/events/trial-runner.js";
import { digest } from "../src/events/model.js";
const target = {
  executionHostId: "local",
  worktreeId: "synthetic",
  terminalHandle: "term_test",
  paneKey: "pane",
  incarnationId: "gen",
  launchId: "launch",
  providerSessionId: "session",
};
function setup() {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mock.load.mockResolvedValue(null);
  mock.storeClose.mockResolvedValue(undefined);
  mock.close.mockResolvedValue(undefined);
  mock.activate.mockResolvedValue({ id: "same-subscription" });
  const buffers: Buffer[] = [];
  mock.read.mockImplementation(async () => {
    const value = Buffer.alloc(32, 7);
    buffers.push(value);
    return value;
  });
  mock.endpoint.mockResolvedValue({ fetch: vi.fn(), close: mock.close, activate: mock.activate });
  const server = Object.assign(new EventEmitter(), {
    listen: vi.fn((_p, _h, ready) => ready()),
    closeAllConnections: vi.fn(),
    close: vi.fn((done) => done()),
  });
  mock.server.mockReturnValue(server);
  const config = {
    directory: "/synthetic/state",
    target,
    runtime: { endpoint: "/synthetic/socket", runtimeId: "runtime" },
    verificationScope: {
      host: "receiver.example.com",
      owner: "service:trial-service-v1",
      targetHash: digest(target),
      expiresAt: Date.now() + 10000,
      domainConfirmation: "送信先ドメインを確認 receiver.example.com",
      confirmation: "確認通信1回のみを承認 receiver.example.com",
      accountBasis: "bounded_protocol_test",
    },
  };
  return { config, buffers, server };
}
afterEach(() => vi.useRealTimers());
it("requires new verification consent before key reads", async () => {
  const { config } = setup();
  config.verificationScope.confirmation = "確認通信を承認 receiver.example.com";
  await expect(startTwoPhaseTrial(config, "synthetic-runtime", vi.fn())).rejects.toThrow();
  expect(mock.read).not.toHaveBeenCalled();
  expect(mock.server).not.toHaveBeenCalled();
});
it("rejects an old state directory before key reads on restart", async () => {
  const { config } = setup();
  mock.load.mockResolvedValue("old-synthetic-state");
  await expect(startTwoPhaseTrial(config, "synthetic-runtime", vi.fn())).rejects.toThrow(
    "trial_state_already_exists",
  );
  expect(mock.read).not.toHaveBeenCalled();
  expect(mock.endpoint).not.toHaveBeenCalled();
});
it("forwards approval locally to the same endpoint and stops at the original deadline", async () => {
  const { config, buffers, server } = setup();
  const review = vi.fn();
  const trial = await startTwoPhaseTrial(config, "synthetic-runtime", review);
  expect(mock.endpoint.mock.calls[0]![0].scope.expiresAt).toBe(config.verificationScope.expiresAt);
  expect(mock.endpoint.mock.calls[0]![0].review).toBe(review);
  const approval = {
    privateUrl: "https://receiver.example.com/synthetic",
    confirmation: "synthetic",
  };
  await trial.activate(approval);
  expect(mock.activate).toHaveBeenCalledExactlyOnceWith(approval);
  expect(mock.endpoint).toHaveBeenCalledTimes(1);
  expect(server.listen).toHaveBeenCalledWith(8787, "127.0.0.1", expect.any(Function));
  await vi.advanceTimersByTimeAsync(10000);
  await trial.finished;
  expect(mock.close).toHaveBeenCalledTimes(1);
  expect(mock.storeClose).toHaveBeenCalledWith(true);
  expect(buffers.every((b) => b.equals(Buffer.alloc(32)))).toBe(true);
  await expect(trial.activate(approval)).rejects.toThrow();
});
it("closes only the trial when activation fails", async () => {
  const { config, buffers } = setup();
  mock.activate.mockRejectedValue(new Error("synthetic secret must not escape"));
  const trial = await startTwoPhaseTrial(config, "synthetic-runtime", vi.fn());
  await expect(trial.activate({})).rejects.toThrow(/^activation_rejected$/);
  await trial.finished;
  expect(mock.close).toHaveBeenCalledTimes(1);
  expect(buffers.every((b) => b.equals(Buffer.alloc(32)))).toBe(true);
});
