import { expect, test } from "vite-plus/test";
import { OrcaAdapter, createRunner, unwrap } from "../src/adapter.js";
import { Bridge, serialize } from "../src/service.js";
import { normalizeAgent } from "../src/normalize.js";
const agent = { paneKey: "tab:leaf", state: "working", updatedAt: 1000 };
const worktree = {
  worktreeId: "w1",
  repo: "repo",
  branch: "main",
  displayName: "Task",
  status: "working",
  agents: [agent],
};
const terminal = {
  handle: "term_1",
  worktreeId: "w1",
  tabId: "tab",
  leafId: "leaf",
  connected: true,
};
const scope = { hostIds: ["local"], omittedHostIds: [] };
const envelope = (result: unknown) => JSON.stringify({ ok: true, result });
function fixture(
  options: {
    worktrees?: unknown[];
    terminals?: unknown[];
    show?: unknown;
    log?: unknown;
    failShow?: boolean;
    truncated?: boolean;
  } = {},
) {
  const calls: string[][] = [];
  const adapter = new OrcaAdapter(async (args) => {
    calls.push(args);
    if (args[0] === "worktree")
      return envelope({
        worktrees: options.worktrees ?? [worktree],
        totalCount: options.worktrees?.length ?? 1,
        truncated: options.truncated ?? false,
        hostScope: scope,
      });
    if (args[1] === "list")
      return envelope({
        terminals: options.terminals ?? [terminal],
        totalCount: 1,
        truncated: false,
        hostScope: scope,
      });
    if (args[1] === "show") {
      if (options.failShow)
        return JSON.stringify({ ok: false, error: { code: "runtime_disconnected" } });
      return envelope({ terminal: options.show ?? { ...terminal, agentWait: null } });
    }
    return envelope({
      terminal: options.log ?? {
        handle: "term_1",
        status: "running",
        tail: ["hello"],
        truncated: false,
        nextCursor: "1",
        source: "stream",
      },
    });
  });
  return { bridge: new Bridge(adapter, () => 1000000), calls };
}
test("normalization preserves states, interruption and unknown future state; silence never means stuck", () => {
  for (const state of ["working", "blocked", "waiting", "done"])
    expect(normalizeAgent({ ...agent, state }, 999999).state).toBe(state);
  expect(normalizeAgent({ ...agent, state: "new-state" }).state).toBe("unknown");
  expect(normalizeAgent({ ...agent, interrupted: true }, 999999)).toMatchObject({
    state: "working",
    interrupted: true,
    freshness: "old_observation",
  });
  expect(normalizeAgent({ ...agent, structuredHostOwned: true }, 999999).freshness).toBe(
    "host_owned",
  );
  expect(
    normalizeAgent({ ...agent, structuredHostOwned: true, restoredUnconfirmed: true }, 999999)
      .freshness,
  ).toBe("unconfirmed");
});
test("broken JSON, changed envelope/result fail closed; additive fields tolerated", async () => {
  expect(() => unwrap("{")).toThrow("invalid JSON");
  expect(() => unwrap("[]")).toThrow("envelope");
  await expect(
    new OrcaAdapter(async () => envelope({ worktrees: "wrong" })).ps(),
  ).rejects.toMatchObject({ code: "schema_changed" });
  await expect(
    new OrcaAdapter(async () =>
      envelope({ worktrees: [], totalCount: 0, truncated: false, newField: true }),
    ).ps(),
  ).resolves.toMatchObject({ worktrees: [] });
});
test("runtime errors stay structured and do not disclose raw messages", () => {
  try {
    unwrap(
      JSON.stringify({
        ok: false,
        error: { code: "runtime_access_denied", message: "secret token" },
      }),
    );
  } catch (e) {
    expect(e).toMatchObject({ code: "runtime_access_denied" });
    expect(String(e)).not.toContain("secret token");
  }
});
test("overview paging is deterministic, covers members, rejects stale and cross-query cursors", async () => {
  const f = fixture({ worktrees: [worktree, { ...worktree, worktreeId: "w2" }] });
  const a = await f.bridge.overview({ limit: 1 });
  expect(a.items[0]?.id).toBe("w1");
  const b = await f.bridge.overview({ limit: 1, cursor: a.nextCursor });
  expect(b.items[0]?.id).toBe("w2");
  expect(b.nextCursor).toBeNull();
  await expect(f.bridge.waiting({ cursor: a.nextCursor })).rejects.toMatchObject({
    code: "cursor_expired",
  });
  await expect(fixture().bridge.overview({ cursor: a.nextCursor })).rejects.toMatchObject({
    code: "cursor_expired",
  });
  expect(a.agentCounts.working).toBe(2);
});
test("inventory truncation is explicit, missing task is not asserted absent", async () => {
  const f = fixture({ truncated: true });
  expect((await f.bridge.overview()).inventoryIncomplete).toBe(true);
  await expect(f.bridge.detail({ id: "missing" })).rejects.toMatchObject({
    code: "inventory_incomplete",
  });
});
test("waiting returns explicit reason/since and does not infer from last output", async () => {
  const f = fixture({
    show: {
      ...terminal,
      agentWait: { source: "hook", reason: "agent-approval-prompt", since: 123 },
    },
  });
  expect((await f.bridge.waiting()).items[0]?.wait).toMatchObject({
    reason: "agent-approval-prompt",
    since: 123,
  });
  expect((await fixture().bridge.waiting()).items).toHaveLength(0);
});
test("attention without terminal remains visible, empty scan pages carry cursor", async () => {
  const f = fixture({
    worktrees: [{ ...worktree, agents: [{ ...agent, state: "waiting", paneKey: "other:leaf" }] }],
  });
  const first = await f.bridge.waiting({ limit: 1 });
  expect(first.items).toHaveLength(1);
  expect(first.items[0]?.waitEvaluated).toBe(false);
  expect(first.nextCursor).not.toBeNull();
  const empty = fixture({ terminals: [terminal, { ...terminal, handle: "term_2" }] });
  const page = await empty.bridge.waiting({ limit: 1 });
  expect(page.items).toHaveLength(0);
  expect(page.nextCursor).not.toBeNull();
});
test("show failure and unevaluated waits are explicit rather than empty success", async () => {
  const result = await fixture({ failShow: true }).bridge.waiting();
  expect(result.errors[0]?.error?.code).toBe("runtime_disconnected");
  expect(result.unevaluatedWaitCount).toBe(1);
  const unknown = await fixture({ show: terminal }).bridge.waiting();
  expect(unknown.unevaluatedWaitCount).toBe(1);
});
test("log character cap and cursor loss warning; screen is not history", async () => {
  const f = fixture({
    log: {
      handle: "term_1",
      status: "running",
      tail: ["x".repeat(1000)],
      truncated: false,
      nextCursor: "10",
      source: "screen",
    },
  });
  const log = await f.bridge.logs({ handle: "term_1", maxChars: 100 });
  expect(log.text.length).toBe(100);
  expect(log.outputClipped).toBe(true);
  expect(log.cursorAdvancesPastOmittedText).toBe(true);
  expect(log.cursorUsableForHistory).toBe(false);
});
test("log cursor is passed literally and adapter only issues allowed reads", async () => {
  const f = fixture();
  await f.bridge.overview();
  await f.bridge.detail({ id: "w1" });
  await f.bridge.logs({ handle: "term_1", limit: 2, cursor: "0" });
  expect(f.calls.at(-1)).toEqual([
    "terminal",
    "read",
    "--terminal",
    "term_1",
    "--limit",
    "2",
    "--cursor",
    "0",
  ]);
  for (const args of f.calls)
    expect(["worktree ps", "terminal list", "terminal show", "terminal read"]).toContain(
      args.slice(0, 2).join(" "),
    );
});
test("argument validation rejects injection-like flags, bad cursors, limits and unknown keys", async () => {
  const f = fixture();
  for (const input of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { extra: true }])
    await expect(f.bridge.overview(input)).rejects.toMatchObject({ code: "invalid_input" });
  await expect(f.bridge.logs({ handle: "--enter" })).rejects.toMatchObject({
    code: "invalid_input",
  });
  await expect(f.bridge.logs({ handle: "term_1", cursor: "--flag" })).rejects.toMatchObject({
    code: "invalid_input",
  });
  expect(f.calls).toHaveLength(0);
});
test("response has a byte bound including multibyte text", () => {
  expect(() => serialize({ text: "あ".repeat(100000) })).toThrow("256 KiB");
});
test("missing CLI, failed process, timeout and byte cap are distinct", async () => {
  await expect(createRunner("/nonexistent/orca-bridge-test", undefined)([])).rejects.toMatchObject({
    code: "cli_missing",
  });
  await expect(
    createRunner(process.execPath, undefined)(["-e", "process.exit(2)"]),
  ).rejects.toMatchObject({ code: "cli_failed" });
  await expect(
    createRunner(process.execPath, undefined, 50)(["-e", "setTimeout(()=>{},10000)", "--"]),
  ).rejects.toMatchObject({ code: "timeout" });
  await expect(
    createRunner(
      process.execPath,
      undefined,
      1000,
      100,
    )(["-e", 'console.log("x".repeat(10000))', "--"]),
  ).rejects.toMatchObject({ code: "output_limit" });
});
