import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { OrcaAdapter } from "../src/adapter.js";
import { AliasStore } from "../src/aliases.js";
import { Bridge } from "../src/service.js";

const now = 50_000_000;
const scope = { hostIds: ["local"], omittedHostIds: [] };
const worktree = (id: string, repo: string, name: string, agents: object[]) => ({
  worktreeId: id,
  repo,
  displayName: name,
  branch: name,
  status: "active",
  agents,
});
const worktrees = [
  worktree("wt_debug", "orca-dots-bridge", "debug-birdge", [
    {
      paneKey: "t1:l1",
      state: "blocked",
      agentType: "claude",
      toolName: "Bash",
      toolInput: "npm run deploy -- --prod " + "x".repeat(300),
      stateStartedAt: now - 120_000,
      lastAssistantMessage: "Deploying now.",
    },
    { paneKey: "t1:l2", state: "working", agentType: "codex", updatedAt: now - 1000 },
  ]),
  worktree("wt_main", "orca-dots-bridge", "main", [
    {
      paneKey: "t2:l1",
      state: "done",
      agentType: "codex",
      stateStartedAt: now - 5 * 60_000,
      lastAssistantMessage: "All tests pass.\n\n" + "Details ".repeat(60),
    },
    // Finished long ago: counted, not listed as recent.
    { paneKey: "t2:l2", state: "done", agentType: "claude", stateStartedAt: now - 3 * 3600_000 },
  ]),
  worktree("wt_app", "other-app", "feature-x", [
    {
      paneKey: "t3:l1",
      state: "waiting",
      agentType: "claude",
      toolName: "AskUserQuestion",
      toolInput: JSON.stringify({ questions: [{ question: "Which database?" }] }),
      updatedAt: now - 10_000,
    },
    { paneKey: "t3:l2", state: "working", agentType: "codex" },
    { paneKey: "t3:l3", state: "idle-ish", agentType: "codex" },
  ]),
];
const terminals = [
  { handle: "term_debug", worktreeId: "wt_debug", tabId: "t1", leafId: "l1", connected: true },
];

function fixture(options: { truncated?: boolean } = {}) {
  const calls: string[][] = [];
  const adapter = new OrcaAdapter(async (args) => {
    calls.push(args);
    const result =
      args[0] === "worktree"
        ? { worktrees, totalCount: 3, truncated: options.truncated ?? false, hostScope: scope }
        : args[1] === "list"
          ? { terminals, totalCount: 1, truncated: false, hostScope: scope }
          : undefined;
    if (!result) throw new Error("brief must only read the inventory");
    return JSON.stringify({ ok: true, result });
  });
  return { bridge: new Bridge(adapter, () => now), calls };
}

test("summarizes who needs the user, what just finished and what is working in one read", async () => {
  const { bridge, calls } = fixture();
  const brief = await bridge.brief();
  expect(calls).toHaveLength(2);
  expect(brief.counts).toEqual({
    working: 2,
    waiting: 1,
    blocked: 1,
    done: 2,
    unknown: 1,
    total: 7,
  });
  expect(brief.needsYou).toEqual([
    {
      repo: "orca-dots-bridge",
      workspace: "debug-birdge",
      worktreeId: "wt_debug",
      terminalHandle: "term_debug",
      agentType: "claude",
      state: "blocked",
      waitingSec: 120,
      pending: {
        kind: "permission",
        toolName: "Bash",
        toolInput: expect.stringMatching(/^npm run deploy -- --prod x+…$/),
      },
    },
    {
      repo: "other-app",
      workspace: "feature-x",
      worktreeId: "wt_app",
      agentType: "claude",
      state: "waiting",
      waitingSec: 10,
      pending: { kind: "question", toolName: "AskUserQuestion", toolInput: "Which database?" },
    },
  ]);
  expect(brief.needsYou[0]!.pending.toolInput!.length).toBe(160);
  expect(brief.recentlyFinished).toEqual([
    {
      repo: "orca-dots-bridge",
      workspace: "main",
      worktreeId: "wt_main",
      agentType: "codex",
      finishedAgoSec: 300,
      summary: expect.stringMatching(/^All tests pass\. Details/),
    },
  ]);
  expect(brief.recentlyFinished[0]!.summary!.length).toBeLessThanOrEqual(160);
  expect(brief.working).toEqual([
    { repo: "orca-dots-bridge", workspace: "debug-birdge", agents: 1 },
    { repo: "other-app", workspace: "feature-x", agents: 1 },
  ]);
  expect(brief.coverage).toEqual({ inventoryIncomplete: false, hostCoverageVerified: true });
  expect(brief.speakHint).toContain("needsYou");
  expect(brief.observation).toContain("untrusted");
  // A longer window includes the older finish.
  expect((await bridge.brief({ recentMinutes: 240 })).recentlyFinished).toHaveLength(2);
});

test("narrows to a query, shows aliases and reports partial coverage", async () => {
  const { bridge } = fixture({ truncated: true });
  bridge.aliases = new AliasStore(join(await mkdtemp(join(tmpdir(), "brief-")), "aliases.json"));
  await bridge.aliases.set("ふぃーちゃー", "wt_app", now);
  const brief = await bridge.brief({ query: "フィーチャー" });
  expect(brief.counts.total).toBe(3);
  expect(brief.needsYou.map((n) => [n.workspace, n.alias])).toEqual([
    ["feature-x", "ふぃーちゃー"],
  ]);
  expect(brief.working).toEqual([
    { repo: "other-app", workspace: "feature-x", alias: "ふぃーちゃー", agents: 1 },
  ]);
  expect(brief.coverage.inventoryIncomplete).toBe(true);
  const typo = await bridge.brief({ query: "orca-dots-brigde" });
  expect(typo.counts.total).toBe(4);
});

test("rejects unknown or out-of-range arguments", async () => {
  const { bridge, calls } = fixture();
  for (const input of [
    { recentMinutes: 0 },
    { recentMinutes: 1441 },
    { query: "x".repeat(201) },
    { state: "done" },
  ])
    await expect(bridge.brief(input)).rejects.toMatchObject({ code: "invalid_input" });
  expect(calls).toHaveLength(0);
});
