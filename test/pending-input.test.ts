import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { OrcaAdapter } from "../src/adapter.js";
import {
  notificationSummary,
  parseMenu,
  pendingKind,
  promptOpen,
  structuredQuestions,
} from "../src/pending-input.js";
import { Bridge } from "../src/service.js";
import { answerTool, callTool, pendingInputTool } from "../src/tools.js";

// Synthetic screens in the shapes Claude Code and Codex render (no real terminal content).
const claudePermission = [
  "⏺ Bash(rm -rf build)",
  "  ⎿  Running…",
  "────────────────────────────────────────",
  " Bash command",
  "",
  "   rm -rf build",
  "   Remove the build directory",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and don't ask again for rm commands in /repo",
  "   3. No, and tell Claude what to do differently (esc)",
  "",
  " Esc to cancel · Tab to amend · ctrl+e to explain",
];
const claudeQuestion = [
  "←  ☐ Database  ✔ Submit  →",
  "",
  "Which database should we use?",
  "",
  "❯ 1. Postgres",
  "     Relational, already in use",
  "  2. SQLite",
  "     Embedded",
  "  3. Type something.",
  "────────────────────────────────────────",
  "  4. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
];
const codexApproval = [
  "  Would you like to run the following command?",
  "",
  "  $ git push --force",
  "",
  "› 1. Yes, proceed (y)",
  "  2. Yes, and don't ask again for this command (p)",
  "  3. No, and tell Codex what to do differently (esc)",
  "",
  "  Press enter to confirm or esc to cancel",
];
/** A finished turn: a numbered list in the agent's answer, then the open composer. */
const idlePrompt = [
  "⏺ Two things to decide:",
  "  1. Fix the Enter key on the email screen",
  "  2. Fix the Tailwind content globs",
  "✻ Brewed for 18s",
  "────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
];
const multiSelect = [
  "Which checks should run?",
  "❯ 1. [ ] Lint",
  "  2. [ ] Tests",
  "  3. [ ] Build",
  "Enter to select · Space to toggle",
];

describe("parseMenu", () => {
  test("reads Claude Code's permission menu with the selected row", () => {
    expect(parseMenu(claudePermission)).toEqual({
      options: [
        { number: 1, label: "Yes", selected: true },
        {
          number: 2,
          label: "Yes, and don't ask again for rm commands in /repo",
          selected: false,
        },
        { number: 3, label: "No, and tell Claude what to do differently (esc)", selected: false },
      ],
      multiSelect: false,
      prompt: "rm -rf build\nRemove the build directory\nDo you want to proceed?",
      context: [
        "⏺ Bash(rm -rf build)",
        "⎿  Running…",
        "Bash command",
        "rm -rf build",
        "Remove the build directory",
        "Do you want to proceed?",
      ],
    });
  });
  test("reads AskUserQuestion options across descriptions and separators", () => {
    const menu = parseMenu(claudeQuestion);
    expect(menu?.options.map((o) => [o.number, o.label])).toEqual([
      [1, "Postgres"],
      [2, "SQLite"],
      [3, "Type something."],
      [4, "Chat about this"],
    ]);
    expect(menu?.prompt).toContain("Which database should we use?");
  });
  test("reads Codex's approval menu", () => {
    expect(parseMenu(codexApproval)?.options).toEqual([
      { number: 1, label: "Yes, proceed (y)", selected: true },
      { number: 2, label: "Yes, and don't ask again for this command (p)", selected: false },
      { number: 3, label: "No, and tell Codex what to do differently (esc)", selected: false },
    ]);
  });
  test("ignores numbered lists in output, unmarked lists and menus above the composer", () => {
    expect(parseMenu(idlePrompt)).toBeNull();
    expect(parseMenu(["1. a", "2. b"])).toBeNull();
    expect(parseMenu([...claudePermission, "────", "❯", "────"])).toBeNull();
    expect(parseMenu(["❯ 2. b", "  3. c"])).toBeNull();
    expect(parseMenu([])).toBeNull();
  });
  test("flags checkbox menus", () => {
    const menu = parseMenu(multiSelect);
    expect(menu?.multiSelect).toBe(true);
    expect(menu?.options[0]).toEqual({ number: 1, label: "Lint", selected: true });
  });
});

// Real screens (October 2026), kept verbatim apart from the workspace path.
const codexPermissionsMenu = [
  "  Update Model Permissions",
  "  1. Ask for approval       Read and edit workspace files and run commands, with approval required for internet access or edits outside the workspace",
  "  2. Approve for me         Only ask for actions detected as potentially unsafe",
  "› 3. Full Access (current)  Use with caution: Codex can edit files outside this workspace and access the internet without approval",
  "  4. Read Only              Read workspace files, with approval required for edits or internet access",
  "  enter select · esc back",
];
const codexCommandApproval = [
  "  Would you like to run the following command?",
  "  Environment: local",
  "  Reason: ネットワーク制限によりホスト名を解決できなかったため、サンドボックス外で同じコマンドを実行してよいですか？",
  "  $ curl -sI https://example.com",
  "› 1. Yes, proceed (y)",
  "  2. Yes, and don't ask again for commands that start with `curl -sI https://example.com` (p)",
  "  3. No, and tell Codex what to do differently (esc)",
  "  Press enter to confirm or esc to cancel",
];
const claudeBashPermission = [
  " Bash command",
  " touch orca-bridge-test.txt",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and always allow access to /Users/me/workspaces/dot-test-2 from this project",
  "   3. Yes, and switch to auto mode · auto mode handles these prompts for you",
  "   4. No",
  " Esc to cancel · Tab to amend",
];
const kindOf = (agent: { state: string; toolName: string | null }, lines: string[]) =>
  pendingKind(agent, { menu: parseMenu(lines), promptOpen: promptOpen(lines) });

describe("pending kind from the visible screen", () => {
  test("Codex's /permissions menu is a selection, even with a stale toolName", () => {
    const menu = parseMenu(codexPermissionsMenu);
    expect(menu?.options.map((o) => [o.number, o.selected])).toEqual([
      [1, false],
      [2, false],
      [3, true],
      [4, false],
    ]);
    expect(menu?.options[2]?.label).toMatch(/^Full Access \(current\)/);
    expect(menu?.prompt).toBe("Update Model Permissions");
    expect(kindOf({ state: "done", toolName: "Bash" }, codexPermissionsMenu)).toBe("selection");
    expect(kindOf({ state: "waiting", toolName: "Bash" }, codexPermissionsMenu)).toBe("selection");
    expect(kindOf({ state: "done", toolName: null }, codexPermissionsMenu)).toBe("selection");
  });
  test("Codex's command approval: the $ line above and the footer below are read", () => {
    const menu = parseMenu(codexCommandApproval);
    expect(menu?.options).toEqual([
      { number: 1, label: "Yes, proceed (y)", selected: true },
      {
        number: 2,
        label:
          "Yes, and don't ask again for commands that start with `curl -sI https://example.com` (p)",
        selected: false,
      },
      { number: 3, label: "No, and tell Codex what to do differently (esc)", selected: false },
    ]);
    expect(menu?.prompt).toContain("$ curl -sI https://example.com");
    for (const agent of [
      { state: "blocked", toolName: "exec_command" },
      { state: "waiting", toolName: null },
      // Orca may still report the previous turn; the visible header decides.
      { state: "done", toolName: null },
    ])
      expect(kindOf(agent, codexCommandApproval)).toBe("permission");
  });
  test("Claude's permission prompt is permission", () => {
    expect(parseMenu(claudeBashPermission)?.options.map((o) => o.label)).toEqual([
      "Yes",
      "Yes, and always allow access to /Users/me/workspaces/dot-test-2 from this project",
      "Yes, and switch to auto mode · auto mode handles these prompts for you",
      "No",
    ]);
    expect(kindOf({ state: "blocked", toolName: "Bash" }, claudeBashPermission)).toBe("permission");
    expect(kindOf({ state: "blocked", toolName: "Bash" }, claudePermission)).toBe("permission");
  });
  test("approval-shaped options without a header count only for a waiting agent with a tool", () => {
    const bare = ["❯ 1. Yes", "  2. No"];
    expect(kindOf({ state: "blocked", toolName: "Bash" }, bare)).toBe("permission");
    expect(kindOf({ state: "done", toolName: "Bash" }, bare)).toBe("selection");
    expect(kindOf({ state: "blocked", toolName: null }, bare)).toBe("selection");
  });
  test("AskUserQuestion menus are questions, by tool or by their shape", () => {
    expect(kindOf({ state: "waiting", toolName: "AskUserQuestion" }, claudeQuestion)).toBe(
      "question",
    );
    expect(kindOf({ state: "waiting", toolName: null }, claudeQuestion)).toBe("question");
    // A stale question tool on a finished agent does not make a menu a question.
    expect(kindOf({ state: "done", toolName: "AskUserQuestion" }, ["❯ 1. a", "  2. b"])).toBe(
      "selection",
    );
  });
  test("no menu: free input with an open composer, otherwise unknown", () => {
    expect(kindOf({ state: "done", toolName: "Bash" }, idlePrompt)).toBe("free_input");
    expect(kindOf({ state: "waiting", toolName: null }, ["working…"])).toBe("unknown");
    expect(pendingKind({ state: "blocked", toolName: "Bash" })).toBe("permission");
    expect(pendingKind({ state: "done", toolName: "Bash" })).toBe("unknown");
  });
});

test("structured AskUserQuestion input is read when Orca passes it as JSON", () => {
  const input = JSON.stringify({
    questions: [
      {
        question: "Which database?",
        header: "DB",
        multiSelect: false,
        options: [{ label: "Postgres", description: "Relational" }, { label: "SQLite" }],
      },
    ],
  });
  expect(structuredQuestions("AskUserQuestion", input)).toEqual([
    {
      question: "Which database?",
      header: "DB",
      multiSelect: false,
      options: [
        { label: "Postgres", description: "Relational" },
        { label: "SQLite", description: null },
      ],
    },
  ]);
  expect(structuredQuestions("AskUserQuestion", input.slice(0, 40))).toBeNull();
  expect(structuredQuestions("Bash", input)).toBeNull();
});

test("notification summary clips the last message and describes the pending tool", () => {
  const agent = {
    paneKey: "tab:leaf",
    state: "waiting",
    lastAssistantMessage: "x".repeat(400),
    toolName: "Bash",
    toolInput: "rm -rf build",
  };
  expect(notificationSummary(agent, "turn_finished")).toEqual({ summary: "x".repeat(279) + "…" });
  expect(notificationSummary(agent, "input_required")).toMatchObject({
    pending: { kind: "permission", toolName: "Bash", toolInput: "rm -rf build" },
  });
  expect(notificationSummary({ ...agent, lastAssistantMessage: null }, "turn_finished")).toEqual(
    {},
  );
});

const terminal = {
  handle: "term_1",
  worktreeId: "wt_1",
  tabId: "tab",
  leafId: "leaf",
  connected: true,
  writable: true,
  agentIdentity: "claude",
};
const waitingAgent = {
  paneKey: "tab:leaf",
  state: "blocked",
  agentType: "claude",
  lastAssistantMessage: "I need to clean the build.",
  toolName: "Bash",
  toolInput: "rm -rf build",
  stateStartedAt: 1_000,
  updatedAt: 1_000,
};

/** A stubbed Orca CLI: screens are served in order (the last one repeats). */
function fixture(options: { screens?: string[][]; agent?: object; target?: object } = {}) {
  const calls: string[][] = [];
  const screens = [...(options.screens ?? [claudePermission])];
  const bridge = new Bridge(
    new OrcaAdapter(async (args) => {
      calls.push(args);
      const verb = args.slice(0, 2).join(" ");
      const result =
        verb === "worktree ps"
          ? {
              worktrees: [
                {
                  worktreeId: "wt_1",
                  repo: "repo",
                  branch: "main",
                  displayName: "ws",
                  status: "active",
                  agents: [options.agent ?? waitingAgent],
                },
              ],
              totalCount: 1,
              truncated: false,
            }
          : verb === "terminal list"
            ? { terminals: [terminal], totalCount: 1, truncated: false }
            : verb === "terminal show"
              ? { terminal: options.target ?? terminal }
              : verb === "terminal read"
                ? {
                    terminal: {
                      handle: "term_1",
                      status: "running",
                      tail: screens.length > 1 ? screens.shift()! : screens[0]!,
                      truncated: false,
                      nextCursor: null,
                      source: "screen",
                    },
                  }
                : { send: { handle: "term_1", accepted: true, bytesWritten: 1 } };
      return JSON.stringify({ ok: true, result });
    }),
    () => 31_000,
    async () => undefined,
  );
  return { bridge, calls, sends: () => calls.filter((a) => a[1] === "send") };
}
const answer = { handle: "term_1", expectedWorktreeId: "wt_1" };

describe("orca_pending_input", () => {
  test("one terminal: permission kind, tool summary and the visible options", async () => {
    const f = fixture();
    const result = await f.bridge.pendingInput(answer);
    expect(result.pending).toBe(true);
    expect(result.items[0]).toMatchObject({
      handle: "term_1",
      agentType: "claude",
      state: "blocked",
      waitingSec: 30,
      kind: "permission",
      toolName: "Bash",
      toolInput: "rm -rf build",
      lastAssistantMessage: "I need to clean the build.",
      menuVisible: true,
      options: [{ number: 1, label: "Yes", selected: true }, expect.anything(), expect.anything()],
      screenTail: null,
    });
    expect(f.calls).toContainEqual([
      "terminal",
      "read",
      "--terminal",
      "term_1",
      "--screen",
      "--limit",
      "60",
    ]);
    expect(f.sends()).toHaveLength(0);
  });
  test("worktree: every waiting agent; question kind with structured options", async () => {
    const f = fixture({
      screens: [claudeQuestion],
      agent: {
        ...waitingAgent,
        state: "waiting",
        toolName: "AskUserQuestion",
        toolInput: JSON.stringify({
          questions: [{ question: "Which database?", options: [{ label: "Postgres" }] }],
        }),
      },
    });
    const result = await f.bridge.pendingInput({ worktreeId: "wt_1" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      kind: "question",
      toolInput: "Which database?",
      questions: [{ question: "Which database?", options: [{ label: "Postgres" }] }],
      options: [{ number: 1, label: "Postgres", selected: true }, {}, {}, {}],
    });
  });
  test("no menu: kind unknown with a clipped screen tail", async () => {
    const f = fixture({ screens: [["Thinking about it…", "still going"]] });
    const result = await f.bridge.pendingInput(answer);
    expect(result.items[0]).toMatchObject({
      kind: "unknown",
      menuVisible: false,
      options: [],
      screenTail: "Thinking about it…\nstill going",
    });
  });
  test("a finished agent's settings menu is a selection without its stale tool", async () => {
    const f = fixture({
      screens: [codexPermissionsMenu],
      agent: { ...waitingAgent, state: "done", agentType: "codex" },
    });
    expect((await f.bridge.pendingInput(answer)).items[0]).toMatchObject({
      state: "done",
      kind: "selection",
      toolName: null,
      toolInput: null,
      menuVisible: true,
      menuPrompt: "Update Model Permissions",
      options: [{ number: 1 }, { number: 2 }, { number: 3, selected: true }, { number: 4 }],
    });
  });
  test("an open composer is free input", async () => {
    const f = fixture({ screens: [idlePrompt], agent: { ...waitingAgent, toolName: null } });
    expect((await f.bridge.pendingInput(answer)).items[0]).toMatchObject({
      kind: "free_input",
      screenTail: null,
    });
  });
  test("refuses a terminal that moved to another worktree", async () => {
    const f = fixture({ target: { ...terminal, worktreeId: "wt_2" } });
    await expect(f.bridge.pendingInput(answer)).rejects.toMatchObject({ code: "target_mismatch" });
  });
  test("needs handle + expectedWorktreeId or worktreeId alone", async () => {
    const f = fixture();
    for (const input of [
      {},
      { handle: "term_1" },
      { handle: "term_1", worktreeId: "wt_1" },
      { ...answer, worktreeId: "wt_1" },
    ])
      await expect(f.bridge.pendingInput(input)).rejects.toMatchObject({ code: "invalid_input" });
    expect(f.calls).toHaveLength(0);
  });
});

describe("orca_answer", () => {
  test("types the visible option's digit without Enter and sees the menu go away", async () => {
    const f = fixture({ screens: [claudePermission, ["⏺ Bash(rm -rf build)", "  ⎿  Done"]] });
    const result = await f.bridge.answer({ ...answer, option: 1 });
    expect(f.sends()).toEqual([["terminal", "send", "--terminal", "term_1", "--text", "1"]]);
    expect(result).toMatchObject({
      accepted: true,
      answered: true,
      chosenLabel: "Yes",
      retrySafe: false,
    });
  });
  test("reports unknown when the menu stays, and never resends", async () => {
    const f = fixture({ screens: [codexApproval] });
    const result = await f.bridge.answer({ ...answer, option: 3 });
    expect(result.answered).toBe("unknown");
    expect(f.sends()).toHaveLength(1);
  });
  test("refuses an option when no menu is visible", async () => {
    const f = fixture({ screens: [idlePrompt] });
    await expect(f.bridge.answer({ ...answer, option: 1 })).rejects.toMatchObject({
      code: "no_menu_visible",
    });
    expect(f.sends()).toHaveLength(0);
  });
  test("refuses an option the menu does not have", async () => {
    const f = fixture();
    await expect(f.bridge.answer({ ...answer, option: 4 })).rejects.toMatchObject({
      code: "option_not_found",
    });
    expect(f.sends()).toHaveLength(0);
  });
  test("refuses checkbox menus, where a digit only toggles", async () => {
    const f = fixture({ screens: [multiSelect] });
    await expect(f.bridge.answer({ ...answer, option: 1 })).rejects.toMatchObject({
      code: "multi_select_unsupported",
    });
  });
  test("refuses a worktree mismatch or a non-agent terminal before reading the screen", async () => {
    for (const target of [
      { ...terminal, worktreeId: "wt_2" },
      { ...terminal, agentIdentity: undefined },
      { ...terminal, writable: false },
    ]) {
      const f = fixture({ target });
      await expect(f.bridge.answer({ ...answer, option: 1 })).rejects.toMatchObject({
        code: "send_target_unavailable",
      });
      expect(f.calls.map((a) => a[1])).toEqual(["show"]);
    }
  });
  test("free text goes with Enter, only while no menu is open", async () => {
    const f = fixture({ screens: [idlePrompt] });
    const result = await f.bridge.answer({ ...answer, text: "Use Postgres" });
    expect(f.sends()).toEqual([
      ["terminal", "send", "--terminal", "term_1", "--text", "Use Postgres", "--enter"],
    ]);
    expect(result).toMatchObject({ accepted: true, answered: "unknown" });
    expect(JSON.stringify(result)).not.toContain("Use Postgres");
    const menu = fixture();
    await expect(menu.bridge.answer({ ...answer, text: "y" })).rejects.toMatchObject({
      code: "menu_visible",
    });
    expect(menu.sends()).toHaveLength(0);
  });
  test("validates exactly one bounded answer before touching Orca", async () => {
    const f = fixture();
    for (const input of [
      answer,
      { ...answer, option: 1, text: "yes" },
      { ...answer, option: 0 },
      { ...answer, option: 10 },
      { ...answer, option: 1.5 },
      { ...answer, text: "-rf" },
      { ...answer, text: "x".repeat(2001) },
      { handle: "term_1", option: 1 },
    ])
      await expect(f.bridge.answer(input)).rejects.toMatchObject({ code: "invalid_input" });
    expect(f.calls).toHaveLength(0);
  });
  test("the tool is refused while 指示の送信を許可 is off", async () => {
    const dir = await mkdtemp(join(tmpdir(), "answer-gate-"));
    const settingsPath = join(dir, "chatgpt-settings.json");
    await writeFile(settingsPath, JSON.stringify({ sendEnabled: false }));
    const f = fixture();
    const tool = answerTool(f.bridge, { settingsPath });
    const refused = await callTool(tool, { ...answer, option: 1 }, undefined);
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain("send_disabled");
    expect(f.calls).toHaveLength(0);
    await writeFile(settingsPath, JSON.stringify({ sendEnabled: true }));
    const allowed = await callTool(tool, { ...answer, option: 1 }, undefined);
    expect(allowed.isError).toBeUndefined();
    expect(f.sends()).toHaveLength(1);
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(pendingInputTool(f.bridge).annotations.readOnlyHint).toBe(true);
  });
});
