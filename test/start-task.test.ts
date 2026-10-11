import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { OrcaAdapter } from "../src/adapter.js";
import { Bridge } from "../src/service.js";
import {
  builtinPrompts,
  builtinTemplates,
  defaultWorkspaceName,
  loadTemplates,
  renderPrompt,
} from "../src/templates.js";
import { callTool, listEntry, startTaskTool } from "../src/tools.js";

/** A stub Orca CLI that answers `worktree create`; every argv is recorded. */
function fixture() {
  const calls: string[][] = [];
  const adapter = new OrcaAdapter(async (args) => {
    calls.push(args);
    const name = args[args.indexOf("--name") + 1]!;
    return JSON.stringify({
      ok: true,
      result: {
        worktree: { id: `repo1::/w/${name}`, displayName: name, branch: `refs/heads/${name}` },
        agentTerminalHandle: "term_new",
      },
    });
  });
  // 2026-10-11 15:04 local time.
  const now = new Date(2026, 9, 11, 15, 4).getTime();
  return { bridge: new Bridge(adapter, () => now), calls, now };
}
const tempDir = () => mkdtemp(join(tmpdir(), "start-task-"));
const forbidden = ["--force", "--run-hooks", "--activate", "--setup run", "--parent-worktree"];
const argAfter = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

describe("orca_start_task", () => {
  test("issue: built-in prompt, linked with --issue, default name and agent", async () => {
    const f = fixture();
    const result = await f.bridge.startTask(
      { repo: "sample-repo", template: "issue", issue: 123 },
      builtinTemplates(),
    );
    const argv = f.calls[0]!;
    expect(argv.slice(0, 9)).toEqual([
      "worktree",
      "create",
      "--no-parent",
      "--setup",
      "inherit",
      "--repo",
      "name:sample-repo",
      "--name",
      "issue-123",
    ]);
    expect(argAfter(argv, "--agent")).toBe("claude");
    expect(argAfter(argv, "--issue")).toBe("123");
    expect(argv).not.toContain("--pr");
    const prompt = argAfter(argv, "--prompt")!;
    expect(prompt).toContain("Issue #123");
    expect(prompt).toContain("gh issue view 123");
    expect(prompt).toContain("gh pr create");
    for (const flag of forbidden) expect(argv.join(" ")).not.toContain(flag);
    expect(result).toMatchObject({
      worktreeId: "repo1::/w/issue-123",
      workspace: "issue-123",
      agent: "claude",
      terminalHandle: "term_new",
      template: "issue",
      issue: 123,
      promptSource: "builtin",
      promptSent: true,
      retrySafe: false,
    });
  });

  test("pr_review: links --pr, never asks to push, takes agent, name and note", async () => {
    const f = fixture();
    await f.bridge.startTask(
      {
        repo: "sample-repo",
        template: "pr_review",
        pr: 45,
        agent: "codex",
        name: "review-45",
        note: "セキュリティを重点的に",
      },
      builtinTemplates(),
    );
    const argv = f.calls[0]!;
    expect(argAfter(argv, "--name")).toBe("review-45");
    expect(argAfter(argv, "--agent")).toBe("codex");
    expect(argAfter(argv, "--pr")).toBe("45");
    expect(argv).not.toContain("--issue");
    const prompt = argAfter(argv, "--prompt")!;
    expect(prompt).toContain("gh pr diff 45");
    expect(prompt).toContain("push");
    expect(prompt.endsWith("追加の指示:\nセキュリティを重点的に")).toBe(true);
  });

  test("custom: the user's prompt as is, a dated default name, no link", async () => {
    const f = fixture();
    const result = await f.bridge.startTask(
      { repo: "sample-repo", template: "custom", prompt: "README の誤字を直して" },
      builtinTemplates(),
    );
    const argv = f.calls[0]!;
    expect(argAfter(argv, "--prompt")).toBe("README の誤字を直して");
    expect(argAfter(argv, "--name")).toBe("task-20261011-1504");
    expect(argv).not.toContain("--issue");
    expect(argv).not.toContain("--pr");
    expect(result).toMatchObject({ template: "custom", workspace: "task-20261011-1504" });
  });

  test("refuses missing, mismatched or unsafe input before any CLI call", async () => {
    const f = fixture();
    for (const input of [
      { repo: "r", template: "issue" },
      { repo: "r", template: "issue", issue: 1, pr: 2 },
      { repo: "r", template: "pr_review", issue: 2 },
      { repo: "r", template: "custom" },
      { repo: "r", template: "custom", prompt: "x", issue: 3 },
      { repo: "r", template: "issue", issue: 0 },
      { repo: "r", template: "issue", issue: 1.5 },
      { repo: "r", template: "deploy", issue: 1 },
      { repo: "-r", template: "issue", issue: 1 },
      { repo: "r", template: "issue", issue: 1, name: "../x" },
      { repo: "r", template: "issue", issue: 1, agent: "--rm" },
      { repo: "r", template: "issue", issue: 1, note: "-x" },
      { repo: "r", template: "issue", issue: 1, note: "x".repeat(2001) },
      { repo: "r", template: "custom", prompt: "--help" },
      { repo: "r", template: "issue", issue: 1, extra: true },
    ])
      await expect(f.bridge.startTask(input, builtinTemplates())).rejects.toMatchObject({
        code: "invalid_input",
      });
    expect(f.calls).toHaveLength(0);
  });

  test("is gated by the 作成 setting, read on every call", async () => {
    const dir = await tempDir();
    const settingsPath = join(dir, "chatgpt-settings.json");
    const f = fixture();
    const def = startTaskTool(f.bridge, { settingsPath, templatesPath: join(dir, "t.json") });
    const args = { repo: "sample-repo", template: "issue", issue: 7 };
    const refused = await callTool(def, args, undefined);
    expect(JSON.parse(refused.content[0]!.text).error.code).toBe("create_disabled");
    expect(f.calls).toHaveLength(0);
    await writeFile(settingsPath, JSON.stringify({ createEnabled: true }));
    const allowed = await callTool(def, args, undefined);
    expect(allowed.isError).toBeUndefined();
    expect(f.calls).toHaveLength(1);
    const entry = listEntry(def);
    expect(entry.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect((entry.inputSchema as any).required).toEqual(["repo", "template"]);
    expect(entry.description).toContain("Issue 12 に着手させて");
  });
});

describe("templates.json", () => {
  test("overrides prompts and the default agent", async () => {
    const dir = await tempDir();
    const path = join(dir, "templates.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        defaultAgent: "codex",
        prompts: { issue: "Issue {number} をやって。終わったら報告。" },
      }),
    );
    const config = await loadTemplates(path);
    expect(config).toMatchObject({ defaultAgent: "codex", overridden: ["issue"], problem: null });
    expect(config.prompts.pr_review).toBe(builtinPrompts.pr_review);
    const f = fixture();
    const result = await f.bridge.startTask({ repo: "r", template: "issue", issue: 9 }, config);
    expect(argAfter(f.calls[0]!, "--prompt")).toBe("Issue 9 をやって。終わったら報告。");
    expect(argAfter(f.calls[0]!, "--agent")).toBe("codex");
    expect(result).toMatchObject({ promptSource: "templates.json" });
  });

  test("a missing file is the built-ins; any problem falls back with a flag", async () => {
    const dir = await tempDir();
    expect(await loadTemplates(join(dir, "none.json"))).toEqual(builtinTemplates());
    const bad = [
      "not json",
      JSON.stringify({ prompts: { issue: "#{number}" } }),
      JSON.stringify({ version: 1, prompts: { issue: "no number placeholder" } }),
      JSON.stringify({ version: 1, prompts: { issue: "{number} and {repo}" } }),
      JSON.stringify({ version: 1, prompts: { custom: "no prompt" } }),
      JSON.stringify({ version: 1, prompts: { deploy: "{number}" } }),
      JSON.stringify({ version: 1, defaultAgent: "--yolo" }),
      JSON.stringify({ version: 1, prompts: { issue: "-{number}" } }),
      JSON.stringify({ version: 1, prompts: { issue: "{number}\u0007" } }),
      JSON.stringify({ version: 1, extra: true }),
    ];
    for (const [i, text] of bad.entries()) {
      const path = join(dir, `bad-${i}.json`);
      await writeFile(path, text);
      expect(await loadTemplates(path)).toEqual({
        ...builtinTemplates(),
        problem: "invalid_templates_file",
      });
    }
    const target = join(dir, "real.json");
    await writeFile(target, JSON.stringify({ version: 1, defaultAgent: "codex" }));
    const link = join(dir, "link.json");
    await symlink(target, link);
    expect((await loadTemplates(link)).problem).toBe("invalid_templates_file");
    const unreadable = join(dir, "unreadable.json");
    await writeFile(unreadable, "{}");
    await chmod(unreadable, 0);
    expect((await loadTemplates(unreadable)).defaultAgent).toBe("claude");
    const f = fixture();
    const result = await f.bridge.startTask(
      { repo: "r", template: "issue", issue: 1 },
      await loadTemplates(join(dir, "bad-0.json")),
    );
    expect(result).toMatchObject({
      templatesFile: "invalid_templates_file",
      promptSource: "builtin",
    });
  });

  test("custom overrides wrap the user's prompt", () => {
    const config = {
      ...builtinTemplates(),
      prompts: { ...builtinPrompts, custom: "次をやって:\n{prompt}" },
    };
    expect(renderPrompt(config, { template: "custom", prompt: "{number} はそのまま" })).toBe(
      "次をやって:\n{number} はそのまま",
    );
    expect(defaultWorkspaceName({ template: "pr_review", number: 3 }, 0)).toBe("review-pr-3");
  });
});
