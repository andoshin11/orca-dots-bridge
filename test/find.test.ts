import { expect, test } from "vite-plus/test";
import { OrcaAdapter } from "../src/adapter.js";
import { Bridge, queryTokens } from "../src/service.js";

const now = 10_000_000;
const scope = { hostIds: ["local"], omittedHostIds: [] };
const debug = {
  worktreeId: "repo1::/Users/me/orca/workspaces/orca-dots-bridge/debug-birdge",
  repo: "orca-dots-bridge",
  displayName: "debug-birdge",
  branch: "refs/heads/discovery-tools",
  hostId: "local",
  status: "working",
  agents: [
    {
      paneKey: "tab1:leaf1",
      state: "waiting",
      agentType: "claude",
      taskTitle: "Add discovery tools",
      updatedAt: now - 30_000,
      lastAssistantMessage: "Should I run the full verify? " + "x".repeat(300),
    },
    // No terminal shares this pane: the handle must be omitted, not guessed.
    { paneKey: "tab1:leaf9", state: "working", agentType: "codex", updatedAt: now - 5_000 },
  ],
};
const main = {
  worktreeId: "repo1::/Users/me/orca/workspaces/orca-dots-bridge/main",
  repo: "orca-dots-bridge",
  displayName: "main",
  branch: "main",
  status: "done",
  agents: [{ paneKey: "tab2:leaf2", state: "done", agentType: "codex", updatedAt: now - 600_000 }],
};
const shell = {
  worktreeId: "repo2::/Users/me/other-app/feature-x",
  repo: "other-app",
  displayName: "feature-x",
  branch: "feature-x",
  status: "idle",
  agents: [],
};
const idle = {
  worktreeId: "repo2::/Users/me/other-app/idle",
  repo: "other-app",
  displayName: "idle",
  branch: "idle",
  status: "idle",
  lastOutputAt: now - 3_600_000,
  agents: [],
};
const terminal = (handle: string, worktreeId: string, tabId: string, leafId: string) => ({
  handle,
  worktreeId,
  tabId,
  leafId,
  connected: true,
});
const terminals = [
  { ...terminal("term_debug", debug.worktreeId, "tab1", "leaf1"), agentIdentity: "claude" },
  terminal("term_main", main.worktreeId, "tab2", "leaf2"),
  { ...terminal("term_shell", shell.worktreeId, "tab3", "leaf3"), lastOutputAt: now - 60_000 },
];

function fixture(
  options: { worktrees?: unknown[]; terminals?: unknown[]; truncated?: boolean } = {},
) {
  const calls: string[][] = [];
  const adapter = new OrcaAdapter(async (args) => {
    calls.push(args);
    const result =
      args[0] === "worktree"
        ? {
            worktrees: options.worktrees ?? [debug, main, shell, idle],
            totalCount: 4,
            truncated: options.truncated ?? false,
            hostScope: scope,
          }
        : args[1] === "list"
          ? {
              terminals: options.terminals ?? terminals,
              totalCount: 3,
              truncated: false,
              hostScope: scope,
            }
          : undefined;
    if (!result) throw new Error("find must only read the inventory");
    return JSON.stringify({ ok: true, result });
  });
  return { bridge: new Bridge(adapter, () => now), calls };
}

test("lists agent and terminal candidates by most recent activity, without idle worktrees", async () => {
  const { bridge, calls } = fixture();
  const found = await bridge.find();
  expect(calls.map((c) => c.slice(0, 2).join(" ")).sort()).toEqual([
    "terminal list",
    "worktree ps",
  ]);
  expect(found.candidates.map((c) => [c.kind, c.terminalHandle ?? null])).toEqual([
    ["agent", null],
    ["agent", "term_debug"],
    ["terminal", "term_shell"],
    ["agent", "term_main"],
  ]);
  expect(found).toMatchObject({
    matched: 4,
    truncated: false,
    inventoryIncomplete: false,
    hostCoverageVerified: true,
    fetchedAt: new Date(now).toISOString(),
  });
  expect(found.candidates[1]).toEqual({
    repo: "orca-dots-bridge",
    workspace: "debug-birdge",
    branch: "discovery-tools",
    worktreeId: debug.worktreeId,
    hostId: "local",
    kind: "agent",
    terminalHandle: "term_debug",
    agentType: "claude",
    agentTitle: "Add discovery tools",
    state: "waiting",
    attention: true,
    lastActivityAgeSec: 30,
    lastResponse: expect.stringMatching(/^Should I run the full verify\? x+…$/),
  });
  expect((found.candidates[1]!.lastResponse as string).length).toBe(160);
  expect(found.candidates[0]).not.toHaveProperty("terminalHandle");
  expect(found.observation).toContain("untrusted");
});

test("natural-language queries keep only the candidates matching the most words", async () => {
  const { bridge } = fixture();
  const found = await bridge.find({
    query: "the debug birdge workspace in orca-dots-bridge",
  });
  expect(found.queryTokens).toEqual(["debug", "birdge", "workspace", "orca-dots-bridge"]);
  expect(found.matched).toBe(2);
  expect(new Set(found.candidates.map((c) => c.worktreeId))).toEqual(new Set([debug.worktreeId]));

  // Repo name alone matches both workspaces of that repo; agent type and case are matched too.
  expect((await bridge.find({ query: "ORCA-DOTS-BRIDGE" })).matched).toBe(3);
  const codex = await bridge.find({ query: "codex" });
  expect(codex.candidates.map((c) => c.agentType)).toEqual(["codex", "codex"]);
  expect((await bridge.find({ query: "nothing-like-this" })).candidates).toEqual([]);
  expect(queryTokens("  a、Debug,debug  ")).toEqual(["debug"]);
});

test("filters by normalized state or attention", async () => {
  const { bridge } = fixture();
  const waiting = await bridge.find({ state: "waiting" });
  expect(waiting.candidates.map((c) => c.terminalHandle)).toEqual(["term_debug"]);
  expect((await bridge.find({ state: "attention" })).matched).toBe(1);
  expect((await bridge.find({ state: "done" })).candidates[0]).toMatchObject({
    terminalHandle: "term_main",
    lastActivityAgeSec: 600,
  });
  expect((await bridge.find({ state: "unknown" })).candidates.map((c) => c.kind)).toEqual([
    "terminal",
  ]);
});

test("includeIdle adds worktrees without agents or terminals, never with a handle", async () => {
  const { bridge } = fixture();
  const found = await bridge.find({ includeIdle: true, query: "other-app" });
  expect(found.candidates.map((c) => c.workspace)).toEqual(["feature-x", "idle"]);
  expect(found.candidates[1]).toMatchObject({
    kind: "idle_worktree",
    state: null,
    lastActivityAgeSec: 3600,
  });
  expect(found.candidates[1]).not.toHaveProperty("terminalHandle");
});

test("limit truncates and coverage gaps are reported", async () => {
  const { bridge } = fixture({ truncated: true });
  const found = await bridge.find({ limit: 1 });
  expect(found).toMatchObject({ matched: 4, truncated: true, inventoryIncomplete: true });
  expect(found.candidates).toHaveLength(1);
});

test("an ambiguous pane maps to no handle", async () => {
  const twin = { ...terminals[0]!, handle: "term_twin" };
  const { bridge } = fixture({ worktrees: [debug], terminals: [terminals[0], twin] });
  const found = await bridge.find({ state: "waiting" });
  expect(found.candidates[0]).not.toHaveProperty("terminalHandle");
});

test("rejects unknown or out-of-range arguments", async () => {
  const { bridge, calls } = fixture();
  for (const input of [
    { limit: 0 },
    { limit: 21 },
    { query: "x".repeat(201) },
    { state: "stuck" },
    { repo: "orca-dots-bridge" },
  ])
    await expect(bridge.find(input)).rejects.toMatchObject({ code: "invalid_input" });
  expect(calls).toHaveLength(0);
});
