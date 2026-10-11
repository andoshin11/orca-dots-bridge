import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// Built-in task templates for orca_start_task ("Issue 12 に着手させて", "PR 45 をレビュー
// させて"), and the optional per-user overrides in ~/.orca-dots-bridge/templates.json.
// A broken override file never breaks the tool: the built-ins are used instead.

export const taskTemplates = ["issue", "pr_review", "custom"] as const;
export type TaskTemplate = (typeof taskTemplates)[number];

/** `{number}` is the Issue/PR number; `{prompt}` the user's own prompt (custom). */
export const builtinPrompts: Record<TaskTemplate, string> = {
  issue: [
    "GitHub の Issue #{number} に取り組んでください。",
    "1. gh issue view {number} --comments で Issue の内容とコメントを読んでください。",
    "2. 関係するコードを読み、実装方針を短くまとめてから実装してください。",
    "3. テストやビルドで動作を確認してください。",
    "4. 作業ブランチにコミットして push し、gh pr create で Issue #{number} を参照する PR を作ってください。",
    "5. 最後に、変更内容・確認したこと・PR の URL を短く報告してください。",
  ].join("\n"),
  pr_review: [
    "GitHub の PR #{number} をレビューしてください。",
    "1. gh pr view {number} --comments と gh pr diff {number} で、説明・議論・差分を読んでください。",
    "2. 正しさ・抜けているテスト・セキュリティ・読みやすさの観点で問題を探してください。",
    "3. コードの変更・コミット・push・PR へのコメント投稿やレビューの送信はしないでください。",
    "4. 見つけた問題を重要度の高い順に、ファイルと行を添えて報告してください。問題がなければそう報告してください。",
  ].join("\n"),
  custom: "{prompt}",
};
export const defaultAgent = "claude";
/** Appended when the user adds extra instructions (note). */
export const noteHeading = "追加の指示:";

export function templatesPath(home = homedir()) {
  return join(home, ".orca-dots-bridge", "templates.json");
}

const maxFileBytes = 64 * 1024;
const required: Record<TaskTemplate, string> = {
  issue: "{number}",
  pr_review: "{number}",
  custom: "{prompt}",
};
const promptOverride = (template: TaskTemplate) =>
  z
    .string()
    .min(1)
    .max(4000)
    .refine(
      (s) =>
        s.trim().length > 0 &&
        !s.trimStart().startsWith("-") &&
        Array.from(s).every((c) => c.charCodeAt(0) >= 32 || "\n\t".includes(c)) &&
        s.includes(required[template]) &&
        // Only the placeholders this template knows.
        (s.match(/\{[A-Za-z_]+\}/gu) ?? []).every((p) => p === required[template]),
    );
const fileSchema = z
  .object({
    version: z.literal(1),
    defaultAgent: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{0,40}$/)
      .optional(),
    prompts: z
      .object({
        issue: promptOverride("issue").optional(),
        pr_review: promptOverride("pr_review").optional(),
        custom: promptOverride("custom").optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type TemplateConfig = {
  defaultAgent: string;
  prompts: Record<TaskTemplate, string>;
  /** Which prompts came from templates.json. */
  overridden: TaskTemplate[];
  /** Set when templates.json exists but was not used. */
  problem: "invalid_templates_file" | null;
};

export const builtinTemplates = (): TemplateConfig => ({
  defaultAgent,
  prompts: { ...builtinPrompts },
  overridden: [],
  problem: null,
});

/**
 * Reads templates.json fresh: owner's file, no symlink, at most 64 KiB, strictly valid.
 * A missing file gives the built-ins; any other problem gives the built-ins with
 * `problem` set.
 */
export async function loadTemplates(path: string): Promise<TemplateConfig> {
  let text: string;
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxFileBytes)
        return { ...builtinTemplates(), problem: "invalid_templates_file" };
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? builtinTemplates()
      : { ...builtinTemplates(), problem: "invalid_templates_file" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...builtinTemplates(), problem: "invalid_templates_file" };
  }
  const file = fileSchema.safeParse(parsed);
  if (!file.success) return { ...builtinTemplates(), problem: "invalid_templates_file" };
  const prompts = { ...builtinPrompts, ...file.data.prompts };
  return {
    defaultAgent: file.data.defaultAgent ?? defaultAgent,
    prompts,
    overridden: taskTemplates.filter((t) => file.data.prompts?.[t] !== undefined),
    problem: null,
  };
}

/** The agent prompt: the template filled in, plus the user's note when given. */
export function renderPrompt(
  config: TemplateConfig,
  input: { template: TaskTemplate; number?: number; prompt?: string; note?: string },
) {
  const filled = config.prompts[input.template].replace(/\{(number|prompt)\}/gu, (_, key) =>
    key === "number" ? String(input.number ?? "") : (input.prompt ?? ""),
  );
  return input.note === undefined ? filled : `${filled}\n\n${noteHeading}\n${input.note}`;
}

/** A workspace name in the create rules when the user gave none. */
export function defaultWorkspaceName(
  input: { template: TaskTemplate; number?: number },
  now: number,
) {
  if (input.template === "issue") return `issue-${input.number}`;
  if (input.template === "pr_review") return `review-pr-${input.number}`;
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `task-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
