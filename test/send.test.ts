import { expect, test } from "vite-plus/test";
import { OrcaAdapter, createRunner } from "../src/adapter.js";
import { Bridge } from "../src/service.js";
import { BridgeError } from "../src/errors.js";
import { resolve } from "node:path";
const target = {
  handle: "term_fixture",
  worktreeId: "w1",
  tabId: "tab",
  leafId: "leaf",
  connected: true,
  writable: true,
  agentIdentity: "codex",
};
function fixture(options: { target?: unknown; response?: unknown; error?: Error } = {}) {
  const calls: string[][] = [];
  const bridge = new Bridge(
    new OrcaAdapter(async (args) => {
      calls.push(args);
      if (args[1] === "show")
        return JSON.stringify({ ok: true, result: { terminal: options.target ?? target } });
      if (options.error) throw options.error;
      return JSON.stringify({
        ok: true,
        result: {
          send: options.response ?? {
            handle: "term_fixture",
            accepted: true,
            bytesWritten: 5,
            prompt: {
              requestId: "synthetic-request",
              stages: ["input_accepted"],
              provider: "codex",
              observation: "supported",
            },
          },
        },
      });
    }),
  );
  return { bridge, calls };
}
test("send requires one exact handle and bounded nonblank instruction before any CLI call", async () => {
  const f = fixture();
  for (const input of [
    {},
    { handle: "term_fixture" },
    { handle: "term_fixture", text: "" },
    { handle: "term_fixture", text: "  \n" },
    { handle: "all", text: "test" },
    { handle: "current", text: "test" },
    { handle: "term_fixture", text: "x".repeat(16001) },
    { handle: "term_fixture", text: "あ".repeat(6000) },
    { handle: "term_fixture", text: "--interrupt" },
    { handle: "term_fixture", text: "\u0003" },
    { handle: "term_fixture", text: "test", retry: true },
    { handle: ["term_1", "term_2"], text: "test" },
  ]) {
    await expect(f.bridge.send(input)).rejects.toMatchObject({ code: "invalid_input" });
  }
  expect(f.calls).toHaveLength(0);
});
test("send preflight rejects disconnected, unknown, read-only, mismatched and non-agent terminals", async () => {
  for (const t of [
    { ...target, connected: false },
    { ...target, writable: false },
    { ...target, writable: undefined },
    { ...target, agentIdentity: undefined },
    { ...target, agentIdentity: "unknown" },
    { ...target, handle: "term_other" },
  ]) {
    const f = fixture({ target: t });
    await expect(f.bridge.send({ handle: "term_fixture", text: "test" })).rejects.toMatchObject({
      code: "send_target_unavailable",
    });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.[1]).toBe("show");
  }
});
test("instruction is one literal argv value, submitted once, with no interrupt or retry", async () => {
  const f = fixture();
  const text = "Keep literal $(echo test); `echo test` and 'quotes'\nsecond line";
  const result = await f.bridge.send({ handle: "term_fixture", text });
  expect(f.calls).toEqual([
    ["terminal", "show", "--terminal", "term_fixture"],
    ["terminal", "send", "--terminal", "term_fixture", "--text", text, "--enter"],
  ]);
  expect(result).toMatchObject({
    accepted: true,
    delivery: "accepted",
    turnStarted: false,
    completion: "not_observed",
    retrySafe: false,
  });
  expect(JSON.stringify(result)).not.toContain(text);
});
test("turn start, refusal and legacy missing receipt never claim completion", async () => {
  for (const [response, expected] of [
    [
      {
        handle: "term_fixture",
        accepted: true,
        bytesWritten: 5,
        prompt: {
          requestId: "synthetic",
          stages: ["input_accepted", "turn_started"],
          provider: "codex",
          observation: "supported",
        },
      },
      { accepted: true, turnStarted: true },
    ],
    [
      { handle: "term_fixture", accepted: false, bytesWritten: 0, refusedReason: "permission" },
      { accepted: false, delivery: "refused", refusedReason: "permission" },
    ],
    [
      { handle: "term_fixture", accepted: true, bytesWritten: 5 },
      { accepted: true, receipt: null },
    ],
  ] as const) {
    const result = await fixture({ response }).bridge.send({
      handle: "term_fixture",
      text: "test",
    });
    expect(result).toMatchObject({ ...expected, completion: "not_observed" });
  }
});
test("lost or changed send receipts return unknown outcome without retry", async () => {
  for (const error of [
    new BridgeError("timeout", "timeout"),
    new BridgeError("runtime_disconnected", "gone"),
    new BridgeError("invalid_json", "bad"),
  ]) {
    const f = fixture({ error });
    await expect(f.bridge.send({ handle: "term_fixture", text: "test" })).rejects.toMatchObject({
      code: "send_outcome_unknown",
    });
    expect(f.calls.filter((a) => a[1] === "send")).toHaveLength(1);
  }
  for (const response of [
    { accepted: true },
    { handle: "term_other", accepted: true, bytesWritten: 1 },
  ]) {
    await expect(
      fixture({ response }).bridge.send({ handle: "term_fixture", text: "test" }),
    ).rejects.toMatchObject({ code: "send_outcome_unknown" });
  }
});
test("nonzero Orca refusal preserves the explicit refused receipt", async () => {
  const adapter = new OrcaAdapter(createRunner(resolve("test/fixtures/orca.mjs"), ""));
  const result = await adapter.send("term_fixture", "refuse");
  expect(result).toMatchObject({ accepted: false, refusedReason: "permission", bytesWritten: 0 });
});
