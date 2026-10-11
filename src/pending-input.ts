import { clip } from "./normalize.js";
import type { Agent } from "./contracts.js";

// What an agent waiting for input is asking, for orca_pending_input, orca_answer and
// notification summaries. Every string here comes from the agent or its terminal: it is
// untrusted task data, never instructions.

/** Rows of the rendered screen read for a pending menu. */
export const screenRows = 60;

export type MenuOption = { number: number; label: string; selected: boolean };
export type Menu = {
  options: MenuOption[];
  /** Checkbox options: a digit toggles one instead of answering. */
  multiSelect: boolean;
  /** The few lines just above the menu (e.g. "Do you want to proceed?"). */
  prompt: string | null;
  /** Up to 6 non-empty lines above the first option, for telling menu kinds apart. */
  context: string[];
};

// `❯ 1. Yes` (Claude Code), `› 1. Yes, proceed (y)` (Codex), `  2. No`.
const optionLine = /^\s*(?:([❯›>▶])\s*)?(\d{1,2})[.)]\s+(\S.*)$/u;
// An empty input prompt: the agent's composer is open, so no menu is pending.
const lonePrompt = /^\s*[❯›>]\s*$/u;
const checkbox = /^(?:\[[ xX✓✔]\]|[☐☑☒])\s*/u;
/** Lines allowed between two options (descriptions, wrapped labels, separators). */
const maxGap = 4;
/** Footer lines allowed below the last option (key hints). */
const maxFooter = 6;

/**
 * The numbered selection menu at the bottom of a rendered screen, or null. A menu is
 * options numbered 1..n (n ≥ 2), at most a few lines apart, exactly one of them carrying
 * the selection marker, with at most a few footer lines and no open input prompt below.
 * A plain numbered list in the agent's output has no marker and is followed by the
 * composer, so it never counts.
 */
export function parseMenu(lines: readonly string[]): Menu | null {
  const rows = lines.map((line) => line.replace(/\s+$/u, ""));
  let last = -1;
  for (let i = rows.length - 1; i >= 0; i--)
    if (optionLine.test(rows[i]!)) {
      last = i;
      break;
    }
  if (last < 0) return null;
  const footer = rows.slice(last + 1);
  if (footer.some((line) => lonePrompt.test(line))) return null;
  if (footer.filter((line) => line.trim().length > 0).length > maxFooter) return null;
  const found: { number: number; label: string; selected: boolean; index: number }[] = [];
  let gap = 0;
  for (let i = last; i >= 0; i--) {
    const m = optionLine.exec(rows[i]!);
    const expected = found.length === 0 ? undefined : found[found.length - 1]!.number - 1;
    if (m && (expected === undefined || Number(m[2]) === expected)) {
      found.push({ number: Number(m[2]), label: m[3]!, selected: m[1] !== undefined, index: i });
      gap = 0;
      if (Number(m[2]) === 1) break;
      continue;
    }
    if (++gap > maxGap) return null;
  }
  const first = found[found.length - 1];
  if (!first || first.number !== 1 || found.length < 2) return null;
  if (found.filter((o) => o.selected).length !== 1) return null;
  const options = found.reverse().map((o) => ({
    number: o.number,
    label: clip(o.label.replace(checkbox, "").trim(), 200)!,
    selected: o.selected,
  }));
  const nonEmpty = (from: number) =>
    rows
      .slice(Math.max(0, from), first.index)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !/^[─━═—-]+$/u.test(line));
  const above = nonEmpty(first.index - 6);
  return {
    options,
    multiSelect: found.some((o) => checkbox.test(o.label)),
    prompt: above.length ? clip(above.slice(-3).join("\n"), 300) : null,
    context: nonEmpty(first.index - 10)
      .slice(-6)
      .map((line) => line.slice(0, 300)),
  };
}

/** An open, empty input prompt near the bottom of the screen. */
export function promptOpen(lines: readonly string[]) {
  return lines.slice(-10).some((line) => lonePrompt.test(line.replace(/\s+$/u, "")));
}

/** Claude's AskUserQuestion, grok/Pi's ask_user_question, Codex's request_user_input. */
export function isQuestionTool(toolName: string | null | undefined) {
  const n = toolName?.replace(/[^a-z0-9]/giu, "").toLowerCase();
  return n === "askuserquestion" || n === "requestuserinput" || n === "askuser";
}

export type StructuredQuestion = {
  question: string | null;
  header: string | null;
  multiSelect: boolean;
  options: { label: string; description: string | null }[];
};

/**
 * Questions from a question tool's input, when Orca passes it as JSON
 * (`{questions:[{question, header, options:[{label, description}], multiSelect}]}`).
 * Orca's preview is clipped, so a cut-off payload simply yields nothing.
 */
export function structuredQuestions(
  toolName: string | null | undefined,
  toolInput: string | null | undefined,
): StructuredQuestion[] | null {
  if (!isQuestionTool(toolName) || !toolInput) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolInput);
  } catch {
    return null;
  }
  const raw = (parsed as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw)) return null;
  const text = (value: unknown, max: number) =>
    typeof value === "string" && value.trim() ? clip(value.trim(), max) : null;
  const questions = raw.slice(0, 4).flatMap((q): StructuredQuestion[] => {
    if (!q || typeof q !== "object") return [];
    const r = q as Record<string, unknown>;
    const options = (Array.isArray(r.options) ? r.options : []).slice(0, 9).flatMap((o) => {
      const label = typeof o === "string" ? o : (o as Record<string, unknown> | null)?.label;
      if (typeof label !== "string" || !label.trim()) return [];
      const description =
        typeof o === "object" && o ? (o as Record<string, unknown>).description : undefined;
      return [{ label: clip(label.trim(), 200)!, description: text(description, 200) }];
    });
    const question = text(r.question, 300);
    if (!question && options.length === 0) return [];
    return [{ question, header: text(r.header, 80), multiSelect: r.multiSelect === true, options }];
  });
  return questions.length ? questions : null;
}

/** A short, safe description of the pending tool call: a command, a path or a question. */
export function toolInputSummary(agent: Pick<Agent, "toolName" | "toolInput">) {
  const input = agent.toolInput?.replace(/\s+/gu, " ").trim();
  if (!input) return null;
  if (isQuestionTool(agent.toolName)) {
    const questions = structuredQuestions(agent.toolName, agent.toolInput);
    if (questions) return clip(questions.map((q) => q.question ?? q.header ?? "").join(" / "), 300);
  }
  return clip(input, 300);
}

export type PendingKind = "permission" | "question" | "selection" | "free_input" | "unknown";

// Approval headers right above the options: Claude Code ("Do you want to proceed?",
// "Do you want to make this edit to x?", "Do you want to create x?"), Codex ("Would you
// like to run the following command?", "Would you like to make the following edits?",
// "Allow command?") and similar. A question mark is required, so a settings menu titled
// "Update Model Permissions" never counts.
const approvalHeader =
  /\b(?:do you want to|would you like to|allow|approve|permit)\b[^?？]*[?？]/iu;
const approvalYes = /^(?:yes|allow|approve|proceed|run|accept)\b/iu;
const approvalNo = /^(?:no|deny|reject|decline|cancel|don['’]t)\b|\(esc\)$/iu;
/** Options shaped like an approval: the first says yes/allow, another says no/deny. */
function approvalOptions(menu: Menu) {
  return (
    approvalYes.test(menu.options[0]?.label ?? "") &&
    menu.options.slice(1).some((o) => approvalNo.test(o.label))
  );
}
// Claude Code's AskUserQuestion screen: a tab row ("☐ Database  ✔ Submit") and its
// fixed "Type something." / "Chat about this" options.
const questionContext = /[☐☑✔✓]\s*Submit\b/u;
const questionOption = /^(?:type something\.?|chat about this)$/iu;
function questionLike(menu: Menu) {
  return (
    menu.context.some((line) => questionContext.test(line)) ||
    menu.options.some((o) => questionOption.test(o.label))
  );
}

/** Orca's states for an agent that is waiting on the user. */
const waitingStates = new Set(["waiting", "blocked"]);
/** States in which toolName only names the last tool the agent ran. */
const finishedStates = new Set(["done", "idle"]);
/** Whether the agent's toolName is only left over from its last turn. */
export const staleTool = (agent: { state?: string | null } | undefined) =>
  agent?.state != null && finishedStates.has(agent.state);

/**
 * The kind of input an agent waits for, from Orca's status and (when read) the visible
 * screen. A finished (done or idle) agent's toolName is stale: it names the last tool
 * the agent ran, so it is ignored.
 *
 * - permission: an approval prompt is visible (an approval header right above the
 *   options), or a waiting agent with a pending tool shows approval-shaped options.
 * - question: a question tool is pending, or the menu looks like AskUserQuestion.
 * - selection: any other visible numbered menu (e.g. Codex's /permissions or /model).
 * - free_input: no menu, the composer is open.
 */
export function pendingKind(
  agent: (Pick<Agent, "toolName"> & { state?: string | null }) | undefined,
  screen?: { menu: Menu | null; promptOpen: boolean },
): PendingKind {
  const state = agent?.state ?? null;
  const toolName = staleTool(agent) ? null : (agent?.toolName ?? null);
  const question = isQuestionTool(toolName);
  if (!screen) return question ? "question" : toolName ? "permission" : "unknown";
  const menu = screen.menu;
  if (menu) {
    if (question || questionLike(menu)) return "question";
    if (menu.context.some((line) => approvalHeader.test(line))) return "permission";
    if (toolName && state !== null && waitingStates.has(state) && approvalOptions(menu))
      return "permission";
    return "selection";
  }
  if (question) return "question";
  if (screen.promptOpen) return "free_input";
  return "unknown";
}

/** Fields captured for a notification: no screen read, so `kind` comes from Orca's status. */
export function notificationSummary(agent: Agent, eventKind: string) {
  const summary = clip(agent.lastAssistantMessage?.trim() || null, 280);
  if (eventKind !== "input_required") return summary ? { summary } : {};
  return {
    ...(summary ? { summary } : {}),
    pending: {
      kind: pendingKind(agent),
      toolName: clip(agent.toolName, 100),
      toolInput: toolInputSummary(agent),
    },
  };
}
