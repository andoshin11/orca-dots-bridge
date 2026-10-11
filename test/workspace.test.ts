import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { OrcaAdapter } from "../src/adapter.js";
import { BridgeError } from "../src/errors.js";
import { Bridge } from "../src/service.js";
import { callTool, listEntry, workspaceToolDefinitions } from "../src/tools.js";

const worktree = (over: Record<string, unknown> = {}) => ({
  worktreeId: "repo1::/w/feature",
  repo: "sample-repo",
  branch: "refs/heads/feature",
  displayName: "feature",
  status: "active",
  agents: [],
  isMainWorktree: false,
  workspaceKind: "git",
  liveTerminalCount: 0,
  hasAttachedPty: false,
  ...over,
});
const terminal = (over: Record<string, unknown> = {}) => ({
  handle: "term_1",
  worktreeId: "repo1::/w/feature",
  tabId: "tab",
  leafId: "leaf",
  connected: true,
  writable: true,
  agentIdentity: "codex",
  ...over,
});

/** A stub Orca CLI. Write commands answer from `writes`; everything is recorded. */
function fixture(
  options: {
    worktrees?: unknown[];
    terminals?: unknown[];
    show?: unknown;
    writes?: Record<string, unknown>;
    error?: Error;
  } = {},
) {
  const calls: string[][] = [];
  const timeouts: (number | undefined)[] = [];
  const adapter = new OrcaAdapter(async (args, runOptions) => {
    calls.push(args);
    timeouts.push(runOptions?.timeout);
    const verb = `${args[0]} ${args[1]}`;
    let result: unknown;
    if (verb === "worktree ps") {
      const worktrees = options.worktrees ?? [worktree()];
      result = { worktrees, totalCount: worktrees.length, truncated: false };
    } else if (verb === "terminal list") {
      const terminals = options.terminals ?? [];
      result = { terminals, totalCount: terminals.length, truncated: false };
    } else if (verb === "terminal show") result = { terminal: options.show ?? terminal() };
    else {
      if (options.error) throw options.error;
      result = options.writes?.[verb];
    }
    return JSON.stringify({ ok: true, result });
  });
  return { bridge: new Bridge(adapter), calls, timeouts };
}
const writes = {
  "worktree create": {
    worktree: {
      id: "repo1::/w/new-task",
      displayName: "new-task",
      branch: "refs/heads/new-task",
      path: "/w/new-task",
      isMainWorktree: false,
    },
    agentTerminalHandle: "term_new",
    startupTerminal: { handle: "term_new" },
  },
  "terminal close": { close: { handle: "term_1", ptyKilled: true }, closed: 2, stopped: 2 },
  "worktree rm": { removed: true },
};
const forbidden = ["--force", "--run-hooks", "--activate", "--allow-failed-archive-hook"];

describe("orca_create_workspace", () => {
  test("builds one fixed argv with --no-parent and never activates or forces hooks", async () => {
    const f = fixture({ writes });
    const result = await f.bridge.createWorkspace({
      repo: "sample-repo",
      name: "new-task",
      baseBranch: "origin/main",
      agent: "claude",
      prompt: "Fix the flaky test; keep $(literal) `text`",
    });
    expect(f.calls).toEqual([
      [
        "worktree",
        "create",
        "--no-parent",
        "--setup",
        "inherit",
        "--repo",
        "name:sample-repo",
        "--name",
        "new-task",
        "--base-branch",
        "origin/main",
        "--agent",
        "claude",
        "--prompt",
        "Fix the flaky test; keep $(literal) `text`",
      ],
    ]);
    for (const flag of forbidden) expect(f.calls[0]).not.toContain(flag);
    expect(f.timeouts[0]).toBe(60000);
    expect(result).toMatchObject({
      worktreeId: "repo1::/w/new-task",
      workspace: "new-task",
      branch: "new-task",
      agent: "claude",
      promptSent: true,
      terminalHandle: "term_new",
      retrySafe: false,
    });
  });

  test("omits optional flags and falls back to the startup terminal of older runtimes", async () => {
    const f = fixture({
      writes: {
        "worktree create": {
          worktree: { id: "repo1::/w/x" },
          startupTerminal: { handle: "term_s" },
        },
      },
    });
    const result = await f.bridge.createWorkspace({ repo: "sample-repo", name: "x" });
    expect(f.calls[0]).toEqual([
      "worktree",
      "create",
      "--no-parent",
      "--setup",
      "inherit",
      "--repo",
      "name:sample-repo",
      "--name",
      "x",
    ]);
    expect(result).toMatchObject({
      worktreeId: "repo1::/w/x",
      workspace: "x",
      terminalHandle: "term_s",
    });
  });

  test("rejects unsafe or ambiguous input before any CLI call", async () => {
    const f = fixture({ writes });
    for (const input of [
      {},
      { repo: "sample-repo" },
      { repo: "-x", name: "a" },
      { repo: "sample-repo", name: "../escape" },
      { repo: "sample-repo", name: "has space" },
      { repo: "sample-repo", name: "-flag" },
      { repo: "sample-repo", name: "x".repeat(101) },
      { repo: "sample-repo", name: "a", baseBranch: "--force" },
      { repo: "sample-repo", name: "a", baseBranch: "a..b" },
      { repo: "sample-repo", name: "a", agent: "Claude Code" },
      { repo: "sample-repo", name: "a", agent: "--activate" },
      { repo: "sample-repo", name: "a", prompt: "needs an agent" },
      { repo: "sample-repo", name: "a", agent: "codex", prompt: "--run-hooks" },
      { repo: "sample-repo", name: "a", agent: "codex", prompt: "- leading dash" },
      { repo: "sample-repo", name: "a", agent: "codex", prompt: "x".repeat(16001) },
      { repo: "sample-repo", name: "a", agent: "codex", prompt: "\u0003" },
      { repo: "sample-repo", name: "a", activate: true },
      { repo: "sample-repo", name: "a", runHooks: true },
    ]) {
      await expect(f.bridge.createWorkspace(input)).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
    expect(f.calls).toHaveLength(0);
  });

  test("maps Orca refusals and lost receipts without retrying", async () => {
    const refused = fixture({ error: new BridgeError("selector_not_found", "x") });
    await expect(refused.bridge.createWorkspace({ repo: "nope", name: "a" })).rejects.toMatchObject(
      { code: "create_failed", message: expect.stringContaining("selector_not_found") },
    );
    const lost = fixture({ error: new BridgeError("timeout", "x") });
    await expect(lost.bridge.createWorkspace({ repo: "r", name: "a" })).rejects.toMatchObject({
      code: "create_outcome_unknown",
    });
    expect(lost.calls).toHaveLength(1);
    const missing = fixture({ error: new BridgeError("cli_missing", "x") });
    await expect(missing.bridge.createWorkspace({ repo: "r", name: "a" })).rejects.toMatchObject({
      code: "cli_missing",
    });
  });
});

describe("orca_close_agent", () => {
  test("closes one terminal after verifying it is still in the expected workspace", async () => {
    const f = fixture({ writes });
    const result = await f.bridge.closeAgent({
      handle: "term_1",
      expectedWorktreeId: "repo1::/w/feature",
    });
    expect(f.calls).toEqual([
      ["terminal", "show", "--terminal", "term_1"],
      ["terminal", "close", "--terminal", "term_1"],
    ]);
    expect(result).toMatchObject({
      scope: "single_terminal",
      processStopped: true,
      workspaceKept: true,
    });
  });

  test("refuses a terminal that now belongs to another workspace", async () => {
    for (const show of [
      terminal({ worktreeId: "repo1::/w/other" }),
      terminal({ handle: "term_2" }),
    ]) {
      const f = fixture({ writes, show });
      await expect(
        f.bridge.closeAgent({ handle: "term_1", expectedWorktreeId: "repo1::/w/feature" }),
      ).rejects.toMatchObject({ code: "target_mismatch" });
      expect(f.calls.filter((c) => c[1] === "close")).toHaveLength(0);
    }
  });

  test("closes every terminal of one exact, known workspace", async () => {
    const f = fixture({ writes });
    const result = await f.bridge.closeAgent({
      allInWorkspace: true,
      worktreeId: "repo1::/w/feature",
    });
    expect(f.calls.at(-1)).toEqual([
      "terminal",
      "close",
      "--worktree",
      "id:repo1::/w/feature",
      "--all",
    ]);
    expect(result).toMatchObject({ scope: "workspace", closedTabs: 2, stoppedProcesses: 2 });
    const unknown = fixture({ writes });
    await expect(
      unknown.bridge.closeAgent({ allInWorkspace: true, worktreeId: "repo1::/w/gone" }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(unknown.calls.filter((c) => c[1] === "close")).toHaveLength(0);
  });

  test("requires exactly one target form", async () => {
    const f = fixture({ writes });
    for (const input of [
      {},
      { handle: "term_1" },
      { handle: "term_1", expectedWorktreeId: "w", allInWorkspace: true, worktreeId: "w" },
      { allInWorkspace: true },
      { worktreeId: "w" },
      { allInWorkspace: false, worktreeId: "w" },
      { handle: "current", expectedWorktreeId: "w" },
      { allInWorkspace: true, worktreeId: "-x" },
    ]) {
      await expect(f.bridge.closeAgent(input)).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(f.calls).toHaveLength(0);
  });

  test("an unconfirmed stop is reported, not retried", async () => {
    const f = fixture({ error: new BridgeError("terminal_stop_live", "x") });
    await expect(
      f.bridge.closeAgent({ handle: "term_1", expectedWorktreeId: "repo1::/w/feature" }),
    ).rejects.toMatchObject({ code: "close_failed" });
    expect(f.calls.filter((c) => c[1] === "close")).toHaveLength(1);
  });
});

describe("orca_remove_workspace", () => {
  test("removes one exact non-main workspace without --force or hooks", async () => {
    const f = fixture({ writes });
    const result = await f.bridge.removeWorkspace({ worktreeId: "repo1::/w/feature" });
    const rm = f.calls.filter((c) => c[1] === "rm");
    expect(rm).toEqual([["worktree", "rm", "--worktree", "id:repo1::/w/feature"]]);
    for (const flag of forbidden) expect(rm[0]).not.toContain(flag);
    expect(result).toMatchObject({ removed: true, workspace: "feature", branch: "feature" });
  });

  test("refuses the main checkout, unconfirmed or folder workspaces and unknown ids", async () => {
    for (const [w, code] of [
      [worktree({ isMainWorktree: true }), "remove_refused"],
      [worktree({ isMainWorktree: undefined }), "remove_refused"],
      [worktree({ workspaceKind: "folder" }), "remove_refused"],
    ] as const) {
      const f = fixture({ writes, worktrees: [w] });
      await expect(
        f.bridge.removeWorkspace({ worktreeId: "repo1::/w/feature" }),
      ).rejects.toMatchObject({
        code,
      });
      expect(f.calls.filter((c) => c[1] === "rm")).toHaveLength(0);
    }
    const f = fixture({ writes });
    await expect(f.bridge.removeWorkspace({ worktreeId: "repo1::/w/gone" })).rejects.toMatchObject({
      code: "not_found",
    });
    for (const input of [
      { worktreeId: "-x" },
      { name: "feature" },
      { worktreeId: "repo1::/w/feature", force: true },
    ])
      await expect(f.bridge.removeWorkspace(input)).rejects.toMatchObject({
        code: "invalid_input",
      });
    expect(f.calls.filter((c) => c[1] === "rm")).toHaveLength(0);
  });

  test("refuses while terminals or active agents remain", async () => {
    for (const options of [
      { terminals: [terminal()] },
      { worktrees: [worktree({ liveTerminalCount: 1 })] },
      { worktrees: [worktree({ hasAttachedPty: true })] },
      {
        worktrees: [
          worktree({ agents: [{ paneKey: "tab:leaf", state: "working", updatedAt: Date.now() }] }),
        ],
      },
    ]) {
      const f = fixture({ writes, ...options });
      await expect(
        f.bridge.removeWorkspace({ worktreeId: "repo1::/w/feature" }),
      ).rejects.toMatchObject({
        code: "close_agents_first",
      });
      expect(f.calls.filter((c) => c[1] === "rm")).toHaveLength(0);
    }
  });

  test("Orca's refusal for uncommitted changes becomes remove_refused", async () => {
    const f = fixture({ error: new BridgeError("runtime_error", "x") });
    await expect(
      f.bridge.removeWorkspace({ worktreeId: "repo1::/w/feature" }),
    ).rejects.toMatchObject({
      code: "remove_refused",
      message: expect.stringContaining("uncommitted"),
    });
    const lost = fixture({ error: new BridgeError("invalid_json", "x") });
    await expect(
      lost.bridge.removeWorkspace({ worktreeId: "repo1::/w/feature" }),
    ).rejects.toMatchObject({
      code: "remove_outcome_unknown",
    });
  });
});

describe("settings gates", () => {
  const cases = [
    ["orca_create_workspace", "createEnabled", "create_disabled", { repo: "r", name: "a" }],
    [
      "orca_close_agent",
      "closeEnabled",
      "close_disabled",
      { handle: "term_1", expectedWorktreeId: "repo1::/w/feature" },
    ],
    [
      "orca_remove_workspace",
      "removeEnabled",
      "remove_disabled",
      { worktreeId: "repo1::/w/feature" },
    ],
  ] as const;

  test("each tool is refused until its own setting is on, re-read on every call", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "workspace-gates-")), "chatgpt-settings.json");
    for (const [name, key, code, args] of cases) {
      const f = fixture({ writes });
      const def = workspaceToolDefinitions(f.bridge, { settingsPath: path }).find(
        (d) => d.name === name,
      )!;
      // Every other setting on, this one off.
      await writeFile(
        path,
        JSON.stringify({
          sendEnabled: true,
          createEnabled: true,
          closeEnabled: true,
          removeEnabled: true,
          [key]: false,
        }),
      );
      const refused = await callTool(def, args, undefined);
      expect(refused.isError).toBe(true);
      const error = JSON.parse(refused.content[0]!.text).error;
      expect(error.code).toBe(code);
      expect(error.message).toContain("settings");
      expect(f.calls).toHaveLength(0);
      await writeFile(path, JSON.stringify({ [key]: "true" }));
      expect(JSON.parse((await callTool(def, args, undefined)).content[0]!.text).error.code).toBe(
        code,
      );
      await writeFile(path, JSON.stringify({ [key]: true }));
      const allowed = await callTool(def, args, undefined);
      expect(allowed.isError).toBeUndefined();
      expect(f.calls.length).toBeGreaterThan(0);
    }
  });

  test("annotations mark close and remove destructive, none idempotent", () => {
    const entries = Object.fromEntries(
      workspaceToolDefinitions(fixture().bridge, {}).map((d) => [d.name, listEntry(d)]),
    );
    expect(entries.orca_create_workspace!.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    for (const name of ["orca_close_agent", "orca_remove_workspace"])
      expect(entries[name]!.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      });
    expect((entries.orca_remove_workspace!.inputSchema as any).required).toEqual(["worktreeId"]);
    expect((entries.orca_create_workspace!.inputSchema as any).required).toEqual(["repo", "name"]);
  });
});
