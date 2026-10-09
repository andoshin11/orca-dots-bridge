import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { expect, it, vi } from "vite-plus/test";
import { digest } from "../src/events/model.js";
import {
  relayTwoPhaseTrialConfigSchema,
  startNotificationTrial,
  startTwoPhaseTrial,
  trialConfigSchema,
  twoPhaseTrialConfigSchema,
} from "../src/events/trial-runner.js";
import { runTwoPhaseCli } from "../src/notification-two-phase.js";
import { diagnosticStages } from "../src/events/preflight-diagnostics.js";

const paneTarget = {
  executionHostId: "local" as const,
  worktreeId: "wt_pane",
  terminalHandle: "term_pane",
  paneKey: "tab_1:leaf_1",
  incarnationId: "inc_1",
};
const sessionTarget = { ...paneTarget, launchId: "launch", providerSessionId: "session" };
function scope(target: unknown, expiresAt = Date.now() + 300000) {
  return {
    host: "receiver.example.com",
    owner: "service:trial-service-v1" as const,
    targetHash: digest(target),
    expiresAt,
    domainConfirmation: "送信先ドメインを確認 receiver.example.com",
    confirmation: "確認通信1回のみを承認 receiver.example.com",
    accountBasis: "bounded_protocol_test" as const,
  };
}
const relayConfig = (extra: Record<string, unknown> = {}) => ({
  source: "relay",
  directory: "/synthetic/never-opened",
  target: paneTarget,
  relayPort: 8788,
  verificationScope: scope(paneTarget),
  ...extra,
});

it("parses a relay config with the default MCP port and a pane target", () => {
  const parsed = relayTwoPhaseTrialConfigSchema.parse(relayConfig());
  expect(parsed.port).toBe(8787);
  expect(parsed.relayPort).toBe(8788);
  expect(parsed.target).toEqual(paneTarget);
  expect(relayTwoPhaseTrialConfigSchema.parse(relayConfig({ port: 9000 })).port).toBe(9000);
});

it("requires the relay source marker and rejects runtime settings and extra keys", () => {
  for (const bad of [
    relayConfig({ source: "runtime" }),
    relayConfig({ source: undefined }),
    relayConfig({ runtime: { endpoint: "/x.sock", runtimeId: "r" } }),
    relayConfig({ callbackApproval: {} }),
    relayConfig({ extra: true }),
    relayConfig({ relayPort: undefined }),
    relayConfig({ verificationScope: undefined }),
  ])
    expect(relayTwoPhaseTrialConfigSchema.safeParse(bad).success).toBe(false);
});

it("rejects a session-shaped target and a non-local pane", () => {
  expect(
    relayTwoPhaseTrialConfigSchema.safeParse(relayConfig({ target: sessionTarget })).success,
  ).toBe(false);
  expect(
    relayTwoPhaseTrialConfigSchema.safeParse(
      relayConfig({ target: { ...paneTarget, executionHostId: "remote" } }),
    ).success,
  ).toBe(false);
});

it("requires the relay port to differ from the MCP port", () => {
  const same = relayTwoPhaseTrialConfigSchema.safeParse(
    relayConfig({ relayPort: 9000, port: 9000 }),
  );
  expect(same.success).toBe(false);
  expect(JSON.stringify(same.error?.issues)).toContain("relay_port_conflict");
  // The default MCP port 8787 conflicts too.
  expect(relayTwoPhaseTrialConfigSchema.safeParse(relayConfig({ relayPort: 8787 })).success).toBe(
    false,
  );
});

it.each([0, 80, 1023, 65536, 8788.5])("rejects relayPort %s", (relayPort) => {
  expect(relayTwoPhaseTrialConfigSchema.safeParse(relayConfig({ relayPort })).success).toBe(false);
});

it("keeps the session configs unchanged and unable to carry a relay source", () => {
  const session = {
    directory: "/synthetic",
    target: sessionTarget,
    runtime: { endpoint: "/x.sock", runtimeId: "r" },
  };
  expect(
    twoPhaseTrialConfigSchema.safeParse({ ...session, verificationScope: scope(sessionTarget) })
      .success,
  ).toBe(true);
  expect(
    twoPhaseTrialConfigSchema.safeParse({
      ...session,
      source: "relay",
      verificationScope: scope(sessionTarget),
    }).success,
  ).toBe(false);
  expect(trialConfigSchema.safeParse({ ...session, target: paneTarget }).success).toBe(false);
});

// None of these reach the Keychain, the store directory or a listener: every one is rejected first.
it("rejects a runtime token for a relay config before touching any key or file", async () => {
  await expect(startTwoPhaseTrial(relayConfig(), "synthetic-token", vi.fn())).rejects.toThrow(
    "runtime_token_unexpected",
  );
});

it("rejects a relay config whose scope was issued for another target before the token check", async () => {
  await expect(
    startTwoPhaseTrial(
      relayConfig({ verificationScope: scope({ ...paneTarget, incarnationId: "other" }) }),
      "",
      vi.fn(),
    ),
  ).rejects.toThrow("verification_scope_invalid");
});

it("rejects an expired relay scope", async () => {
  await expect(
    startTwoPhaseTrial(
      relayConfig({ verificationScope: scope(paneTarget, Date.now() + 1000) }),
      "",
      vi.fn(),
    ),
  ).rejects.toThrow();
});

it("still requires a runtime token for a session config", async () => {
  const config = {
    directory: "/synthetic/never-opened",
    target: sessionTarget,
    runtime: { endpoint: "/x.sock", runtimeId: "r" },
    verificationScope: scope(sessionTarget),
  };
  await expect(startTwoPhaseTrial(config, "", vi.fn())).rejects.toThrow("runtime_token_required");
});

it("never treats a relay config as the legacy single-phase trial", async () => {
  await expect(startNotificationTrial(relayConfig(), "")).rejects.toThrow();
  await expect(startNotificationTrial(relayConfig(), "synthetic-token")).rejects.toThrow();
});

// ---- two-phase CLI: the first record's runtimeToken is optional ----

function cli() {
  const input = new PassThrough(),
    signals = new EventEmitter();
  let finish!: () => void;
  const finished = new Promise<void>((r) => {
    finish = r;
  });
  const trial = {
    close: vi.fn(async () => finish()),
    finished,
    activate: vi.fn(async () => ({})),
    deleteTrialKeys: vi.fn(),
  };
  const start = vi.fn(async (..._args: unknown[]) => trial);
  const io = {
    input,
    signals,
    output: vi.fn(),
    review: vi.fn(),
    failed: vi.fn(),
    privateTerminal: () => true,
  };
  return {
    io,
    start,
    trial,
    finish,
    write: (value: unknown) => input.write(JSON.stringify(value) + "\n"),
    run: () => runTwoPhaseCli(io, start as unknown as typeof startTwoPhaseTrial),
  };
}

it("accepts a first record without runtimeToken and passes an empty token to the runner", async () => {
  const f = cli();
  const done = f.run();
  f.write({ config: { source: "relay" } });
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(1));
  expect(f.start.mock.calls[0]).toMatchObject([{ source: "relay" }, "", expect.any(Function)]);
  expect(f.io.failed).not.toHaveBeenCalled();
  f.finish();
  await done;
});

it("still passes a provided runtimeToken through", async () => {
  const f = cli();
  const done = f.run();
  f.write({ config: {}, runtimeToken: "synthetic-secret" });
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(1));
  expect(f.start.mock.calls[0]![1]).toBe("synthetic-secret");
  f.finish();
  await done;
});

it.each([
  ["an empty runtimeToken", { config: {}, runtimeToken: "" }],
  ["a non-string runtimeToken", { config: {}, runtimeToken: 1 }],
  ["an unknown key", { config: {}, extra: true }],
])("rejects a first record with %s", async (_name, record) => {
  const f = cli();
  const done = f.run();
  f.write(record);
  await done;
  expect(f.start).not.toHaveBeenCalled();
  expect(f.io.failed).toHaveBeenCalled();
});

it("keeps diagnostic stages unique and includes the relay and pane stages", () => {
  expect(new Set(diagnosticStages).size).toBe(diagnosticStages.length);
  for (const stage of [
    "relay_arrived",
    "relay_signature_rejected",
    "relay_replay_rejected",
    "relay_schema_rejected",
    "relay_test_received",
    "relay_status_received",
    "pane_status_queued",
  ])
    expect(diagnosticStages).toContain(stage);
});
