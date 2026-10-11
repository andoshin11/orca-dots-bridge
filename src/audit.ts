import { constants } from "node:fs";
import { mkdir, open, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

// A local record of every write dot (or a stdio MCP client) asked this bridge to do:
// JSON Lines in ~/.orca-dots-bridge/audit.log, owner-only, rotated at 1 MB with one
// previous file kept. Entries carry the tool, the outcome, the target and a short,
// clipped summary of the input; never keys, webhook secrets or full texts. Writing is
// best effort: a failure here never delays or fails the tool call itself.

/** Every tool that changes something, on this Mac or in Orca. */
export const auditedTools = [
  "orca_send_instruction",
  "orca_answer",
  "orca_create_workspace",
  "orca_start_task",
  "orca_close_agent",
  "orca_remove_workspace",
  "orca_set_alias",
  "orca_remove_alias",
  "orca_settings_update",
] as const;
export type AuditedTool = (typeof auditedTools)[number];
const audited = new Set<string>(auditedTools);
export const isAuditedTool = (name: string): name is AuditedTool => audited.has(name);

export type AuditSource = "chatgpt" | "stdio";
export type AuditOutcome = "ok" | "refused" | "error";
export type AuditTarget = Record<string, string | number | boolean>;
export type AuditEntry = {
  time: string;
  source: AuditSource;
  tool: AuditedTool;
  outcome: AuditOutcome;
  errorCode?: string;
  target?: AuditTarget;
  summary?: string;
};

/** Sent or typed text is stored clipped to this many characters. */
export const summaryChars = 200;
export const rotateBytes = 1024 * 1024;
export const auditReadMax = 100;

export function auditLogPath(home = homedir()) {
  return join(home, ".orca-dots-bridge", "audit.log");
}

/** One line of text, printable, clipped; null when nothing is left. */
export function clipText(value: unknown, max = summaryChars): string | null {
  if (typeof value !== "string") return null;
  const flat = Array.from(value.replace(/\s+/gu, " ").trim())
    .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
    .join("");
  if (!flat) return null;
  const chars = Array.from(flat);
  return chars.length <= max ? flat : chars.slice(0, max - 1).join("") + "…";
}

/**
 * Codes for which the bridge or Orca acted (or may have) and something went wrong; any
 * other refusal means nothing was done.
 */
const errorCodes = new Set([
  "internal_error",
  "cli_missing",
  "cli_failed",
  "timeout",
  "invalid_json",
  "schema_changed",
  "output_limit",
  "response_limit",
  "alias_write_failed",
]);
export function auditOutcome(code: string): AuditOutcome {
  return errorCodes.has(code) || code.endsWith("_outcome_unknown") ? "error" : "refused";
}

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * The target and summary of one call, from whitelisted fields only. `args` may be
 * invalid (a refused call), so every field is checked for type and clipped; `result`
 * is the handler's JSON on success.
 */
export function describeCall(
  tool: AuditedTool,
  rawArgs: unknown,
  rawResult?: unknown,
): { target?: AuditTarget; summary?: string } {
  const args = recordOf(rawArgs),
    result = recordOf(rawResult);
  const target: AuditTarget = {};
  const put = (key: string, value: unknown, max = 200) => {
    if (typeof value === "number" && Number.isFinite(value)) target[key] = value;
    else if (typeof value === "boolean") target[key] = value;
    else {
      const text = clipText(value, max);
      if (text !== null) target[key] = text;
    }
  };
  let summary: string | null = null;
  switch (tool) {
    case "orca_send_instruction":
      put("handle", args.handle, 100);
      put("worktreeId", args.expectedWorktreeId, 400);
      summary = clipText(args.text);
      break;
    case "orca_answer":
      put("handle", args.handle, 100);
      put("worktreeId", args.expectedWorktreeId, 400);
      put("option", args.option);
      summary =
        typeof args.option === "number"
          ? clipText(
              typeof result.chosenLabel === "string"
                ? `${args.option}. ${result.chosenLabel}`
                : String(args.option),
            )
          : clipText(args.text);
      break;
    case "orca_create_workspace":
    case "orca_start_task":
      put("repo", args.repo);
      if (tool === "orca_start_task") {
        put("template", args.template, 40);
        put("issue", args.issue);
        put("pr", args.pr);
      }
      put("workspace", result.workspace ?? args.name);
      put("agent", result.agent ?? args.agent, 40);
      put("worktreeId", result.worktreeId, 400);
      put("handle", result.terminalHandle, 100);
      summary =
        tool === "orca_create_workspace"
          ? clipText(args.prompt)
          : clipText(args.template === "custom" ? args.prompt : args.note);
      break;
    case "orca_close_agent":
      put("handle", args.handle, 100);
      put("worktreeId", args.worktreeId ?? args.expectedWorktreeId, 400);
      if (args.allInWorkspace === true) put("allInWorkspace", true);
      break;
    case "orca_remove_workspace":
      put("worktreeId", args.worktreeId, 400);
      put("workspace", result.workspace);
      break;
    case "orca_set_alias":
      put("alias", args.name, 40);
      put("worktreeId", args.worktreeId, 400);
      put("workspace", result.workspace);
      break;
    case "orca_remove_alias":
      put("alias", args.name, 40);
      break;
    case "orca_settings_update": {
      // Only known boolean switches; nothing else is ever copied.
      const set = recordOf(args.set);
      const changed = Object.keys(set)
        .filter((key) => /^[A-Za-z]{1,40}$/.test(key) && typeof set[key] === "boolean")
        .slice(0, 20);
      for (const key of changed) target[key] = set[key] as boolean;
      summary = changed.length
        ? changed.map((key) => `${key}=${String(set[key])}`).join(", ")
        : null;
      break;
    }
  }
  return {
    ...(Object.keys(target).length ? { target } : {}),
    ...(summary !== null ? { summary } : {}),
  };
}

const entrySchema = z
  .object({
    time: z.string().max(40),
    source: z.enum(["chatgpt", "stdio"]),
    tool: z.enum(auditedTools),
    outcome: z.enum(["ok", "refused", "error"]),
    errorCode: z
      .string()
      .regex(/^[a-z_]{1,80}$/)
      .optional(),
    target: z
      .record(z.union([z.string().max(500), z.number(), z.boolean()]))
      .refine((t) => Object.keys(t).length <= 30)
      .optional(),
    summary: z.string().max(400).optional(),
  })
  .strip();

/** Parses JSON Lines, skipping anything that is not a well-formed entry. */
export function parseAuditLines(text: string): AuditEntry[] {
  const entries: AuditEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = entrySchema.safeParse(parsed);
    if (entry.success) entries.push(entry.data as AuditEntry);
  }
  return entries;
}

/** Reads a regular file without following a symlink; the last `maxBytes` only. */
async function readTail(path: string, maxBytes: number): Promise<string> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return "";
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return "";
    const length = Math.min(info.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    const text = buffer.toString("utf8");
    // A cut-off first line is dropped.
    return info.size > length ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return "";
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export type AuditLog = {
  /** Never throws and never waits for the disk; see `flush` for tests. */
  record(entry: Omit<AuditEntry, "time">): void;
  /** Resolves once every recorded entry has been written (or dropped). */
  flush(): Promise<void>;
  /** The newest entries first. */
  read(options?: { limit?: number; tool?: AuditedTool }): Promise<AuditEntry[]>;
};

export function createAuditLog(
  path: string = auditLogPath(),
  now: () => number = Date.now,
  maxBytes = rotateBytes,
): AuditLog {
  let queue: Promise<void> = Promise.resolve();
  const append = async (line: string) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // O_NOFOLLOW: a symlink planted at the path is never written through.
    let handle = await open(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile()) return;
      if (info.size > 0 && info.size + Buffer.byteLength(line) > maxBytes) {
        await handle.close();
        // rename replaces a symlink at audit.log.1 itself, never its target.
        await rename(path, `${path}.1`);
        handle = await open(
          path,
          constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
          0o600,
        );
      }
      await handle.chmod(0o600);
      await handle.write(line);
    } finally {
      await handle.close().catch(() => undefined);
    }
  };
  return {
    record(entry) {
      let line: string;
      try {
        line = `${JSON.stringify({ time: new Date(now()).toISOString(), ...entry })}\n`;
      } catch {
        return;
      }
      queue = queue.then(() => append(line)).catch(() => undefined);
    },
    flush: () => queue,
    async read(options = {}) {
      // Entries this process recorded are readable at once.
      await queue;
      const limit = Math.max(1, Math.min(auditReadMax, options.limit ?? 20));
      const pick = (entries: AuditEntry[]) =>
        options.tool === undefined ? entries : entries.filter((e) => e.tool === options.tool);
      let entries = pick(parseAuditLines(await readTail(path, maxBytes + 64 * 1024)));
      if (entries.length < limit)
        entries = [
          ...pick(parseAuditLines(await readTail(`${path}.1`, maxBytes + 64 * 1024))),
          ...entries,
        ];
      return entries.slice(-limit).reverse();
    },
  };
}

/** Records one finished call; `error` is what the handler threw, if anything. */
export function recordCall(
  log: AuditLog,
  source: AuditSource,
  tool: AuditedTool,
  args: unknown,
  outcome: { result?: unknown; errorCode?: string },
) {
  try {
    const { target, summary } = describeCall(tool, args, outcome.result);
    let result: AuditOutcome = "ok",
      errorCode = outcome.errorCode;
    if (errorCode !== undefined) result = auditOutcome(errorCode);
    else if (recordOf(outcome.result).accepted === false) {
      // Orca received the request but did not take the input.
      result = "refused";
      errorCode = "not_accepted";
    }
    log.record({
      source,
      tool,
      outcome: result,
      ...(errorCode !== undefined
        ? { errorCode: /^[a-z_]{1,80}$/.test(errorCode) ? errorCode : "internal_error" }
        : {}),
      ...(target ? { target } : {}),
      ...(summary !== undefined ? { summary } : {}),
    });
  } catch {
    // Best effort only.
  }
}

export const auditToolInput = {
  limit: z.number().int().min(1).max(auditReadMax).default(20),
  tool: z.enum(auditedTools).optional(),
};
