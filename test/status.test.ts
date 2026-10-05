import { expect, test } from "vite-plus/test";
import { OrcaAdapter } from "../src/adapter.js";
import { taskStatus } from "../src/status.js";
const lead = {
  paneKey: "tab:lead",
  state: "done",
  updatedAt: 999900,
  parentPaneKey: null,
  lastAssistantMessage: "Review finished; another worker is testing.",
};
const child = { paneKey: "tab:child", state: "working", updatedAt: 999950, parentPaneKey: null };
const workspace = {
  worktreeId: "w1",
  repo: "sample-repo",
  displayName: "review",
  branch: "refs/heads/feature",
  hostId: "local",
  status: "working",
  agents: [child, lead],
};
const team = {
  handle: "term_lead",
  worktreeId: "w1",
  tabId: "tab",
  leafId: "lead",
  connected: true,
  agentIdentity: "claude-agent-teams",
};
const worker = { ...team, handle: "term_child", leafId: "child", agentIdentity: "claude" };
const scope = { hostIds: ["local"], omittedHostIds: [] };
function fixture(
  options: {
    worktrees?: unknown[];
    terminals?: unknown[];
    truncated?: boolean;
    terminalTruncated?: boolean;
    shown?: unknown;
    log?: unknown;
    failFocus?: boolean;
  } = {},
) {
  const calls: string[][] = [];
  const adapter = new OrcaAdapter(async (args) => {
    calls.push(args);
    let result: unknown;
    if (args[0] === "worktree")
      result = {
        worktrees: options.worktrees ?? [workspace],
        totalCount: 1,
        truncated: options.truncated ?? false,
        hostScope: scope,
      };
    else if (args[1] === "list")
      result = {
        terminals: options.terminals ?? [worker, team],
        totalCount: 2,
        truncated: options.terminalTruncated ?? false,
        hostScope: scope,
      };
    else if (options.failFocus)
      return JSON.stringify({ ok: false, error: { code: "runtime_disconnected" } });
    else if (args[1] === "show")
      result = { terminal: options.shown ?? { ...team, agentWait: null } };
    else if (args[1] === "read")
      result = {
        terminal: options.log ?? {
          handle: "term_lead",
          status: "running",
          tail: ["synthetic progress"],
          truncated: false,
          nextCursor: "1",
          source: "screen",
        },
      };
    else throw new Error("Unexpected mutation");
    return JSON.stringify({ ok: true, result });
  });
  return {
    calls,
    run: (input: unknown = { repo: "sample-repo", name: "review" }) =>
      taskStatus(adapter, input, () => 1000000),
  };
}
test("exact status resolves the team terminal without treating every null parent as main", async () => {
  const f = fixture();
  const r = await f.run();
  expect(r).toMatchObject({
    resolution: "resolved",
    counts: { working: 1, done: 1 },
    freshWorking: 1,
    selection: "team_lead_candidate",
    focus: { handle: "term_lead", roleConfirmed: false },
    waitCoverage: { checked: 1, unknownAgentCount: 1 },
  });
  expect(f.calls.map((a) => a.slice(0, 2).join(" "))).toEqual([
    "worktree ps",
    "terminal list",
    "terminal show",
    "terminal read",
  ]);
  expect(
    f.calls.filter((a) => a[1] === "show" || a[1] === "read").every((a) => a.includes("term_lead")),
  ).toBe(true);
  expect(r).toHaveProperty("agents.0.role", "unverified");
});
test("same-name branches require disambiguation and do not read an arbitrary terminal", async () => {
  const f = fixture({
    worktrees: [workspace, { ...workspace, worktreeId: "w2", branch: "refs/heads/another" }],
  });
  expect(await f.run()).toMatchObject({ resolution: "ambiguous", candidatesTruncated: false });
  expect(f.calls).toHaveLength(2);
  expect(
    await f.run({
      repo: "sample-repo",
      name: "review",
      branch: "feature",
      hostId: "local",
      id: "w1",
    }),
  ).toMatchObject({ resolution: "resolved" });
});
test("matching is exact; no prefix/case guesses or invalid selectors", async () => {
  const f = fixture();
  expect(await f.run({ repo: "sample-repo", name: "rev" })).toMatchObject({
    resolution: "not_found",
  });
  expect(await f.run({ repo: "Sample-repo", name: "review" })).toMatchObject({
    resolution: "not_found",
  });
  const invalid = fixture();
  for (const input of [
    { repo: "sample-repo" },
    { repo: " ", name: "review" },
    { repo: "sample-repo", name: "review", all: true },
  ])
    await expect(invalid.run(input)).rejects.toMatchObject({ code: "invalid_input" });
  expect(invalid.calls).toHaveLength(0);
});
test("truncated inventory cannot establish uniqueness; truncated terminals cannot select lead", async () => {
  const f = fixture({ truncated: true });
  expect(await f.run()).toMatchObject({ resolution: "inventory_incomplete" });
  expect(f.calls).toHaveLength(2);
  const t = fixture({ terminalTruncated: true });
  expect(await t.run()).toMatchObject({
    selection: "unresolved",
    focus: null,
    terminalInventoryIncomplete: true,
  });
  expect(t.calls).toHaveLength(2);
});
test("multiple ordinary agents or team terminals do not establish main/subagent roles", async () => {
  for (const terminals of [
    [worker, { ...team, agentIdentity: "claude" }],
    [team, { ...worker, agentIdentity: "claude-agent-teams" }],
  ]) {
    const f = fixture({ terminals });
    expect(await f.run()).toMatchObject({ selection: "unresolved", focus: null });
    expect(f.calls).toHaveLength(2);
  }
});
test("changed target or failed focus returns useful counts with explicit error, never wrong logs", async () => {
  for (const options of [{ shown: { ...team, worktreeId: "other" } }, { failFocus: true }]) {
    const r = await fixture(options).run();
    expect(r).toMatchObject({
      resolution: "resolved",
      focus: null,
      counts: { working: 1 },
      waitCoverage: { checked: 0, unknownAgentCount: 2 },
    });
    expect(r).toHaveProperty("focusError.code");
  }
});
test("response bounds agent details and log text while preserving all state counts", async () => {
  const agents = Array.from({ length: 30 }, (_, i) => ({
    ...child,
    paneKey: `tab:child${i}`,
    parentPaneKey: "tab:lead",
  }));
  const r = await fixture({
    worktrees: [{ ...workspace, agents: [lead, ...agents] }],
    log: {
      handle: "term_lead",
      status: "running",
      tail: ["x".repeat(10000)],
      truncated: false,
      nextCursor: "1",
    },
  }).run();
  expect(r).toMatchObject({
    agentTotal: 31,
    agentsTruncated: true,
    counts: { working: 30, done: 1 },
    focus: { log: { outputClipped: true } },
  });
  expect(r).toHaveProperty("agents.length", 12);
  expect(r).toHaveProperty("focus.log.text.length", 1600);
});
test("old working observations are not counted as recently working or declared stuck", async () => {
  const r = await fixture({
    worktrees: [{ ...workspace, agents: [{ ...child, updatedAt: 1 }] }],
    terminals: [worker],
    shown: { ...worker, agentWait: { source: "hook", reason: "agent-approval-prompt", since: 10 } },
    log: { handle: "term_child", status: "running", tail: [], truncated: false, nextCursor: null },
  }).run();
  expect(r).toMatchObject({
    freshWorking: 0,
    counts: { working: 1 },
    selection: "single_agent",
    focus: { freshness: "old_observation", agentWait: { reason: "agent-approval-prompt" } },
  });
  expect(r.summary).not.toContain("stuck");
});
