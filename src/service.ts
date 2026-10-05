import { createHash } from "node:crypto";
import { z } from "zod";
import { OrcaAdapter } from "./adapter.js";
import { BridgeError, errorResult } from "./errors.js";
import { clip, normalizeAgent, normalizeWorktree } from "./normalize.js";
import type { Agent, Terminal } from "./contracts.js";
const identifier = z
  .string()
  .min(1)
  .max(4096)
  .refine((s) => !s.startsWith("-") && Array.from(s).every((c) => c.charCodeAt(0) >= 32));
export const pageShape = {
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z.string().max(512).optional(),
};
export const pageSchema = z.object(pageShape).strict();
export const detailSchema = z.object({ id: identifier }).strict();
export const logsSchema = z
  .object({
    handle: identifier,
    limit: z.number().int().min(1).max(200).default(40),
    cursor: z.string().regex(/^\d+$/).max(30).optional(),
    maxChars: z.number().int().min(100).max(20000).default(8000),
  })
  .strict();

export const sendSchema = z
  .object({
    handle: z
      .string()
      .regex(/^term_[a-zA-Z0-9_-]+$/)
      .max(256),
    text: z
      .string()
      .min(1)
      .max(16000)
      .refine(
        (value) =>
          value.trim().length > 0 &&
          !value.trimStart().startsWith("--") &&
          Buffer.byteLength(value, "utf8") <= 16000 &&
          Array.from(value).every((c) => c.charCodeAt(0) >= 32 || "\n\r\t".includes(c)),
      ),
  })
  .strict();
function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new BridgeError("invalid_input", "Invalid arguments or out-of-range limit/cursor.");
  return result.data;
}
function page<T>(items: T[], limit: number, cursor: string | undefined, scope: string) {
  // Membership-based cursors survive changing activity but reject additions/removals. No hidden disk cache.
  const hash = createHash("sha256").update(scope).digest("hex").slice(0, 24);
  let offset = 0;
  if (cursor) {
    const m = /^([a-f0-9]{24}):(\d+)$/.exec(cursor);
    if (!m || m[1] !== hash)
      throw new BridgeError(
        "cursor_expired",
        "Inventory changed or cursor belongs to another query; restart without cursor.",
      );
    offset = Number(m[2]);
    if (!Number.isSafeInteger(offset) || offset >= items.length)
      throw new BridgeError("invalid_cursor", "Cursor offset is outside the inventory.");
  }
  const next = offset + limit;
  return {
    items: items.slice(offset, next),
    nextCursor: next < items.length ? `${hash}:${next}` : null,
  };
}
async function mapBounded<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const result: R[] = [];
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (index < items.length) {
        const i = index++;
        result[i] = await fn(items[i]!);
      }
    }),
  );
  return result;
}
export class Bridge {
  constructor(
    private adapter = new OrcaAdapter(),
    private now = () => Date.now(),
  ) {}
  private async inventory() {
    const [ps, terms] = await Promise.all([this.adapter.ps(), this.adapter.terminals()]);
    const worktrees = ps.worktrees
      .slice(0, 1000)
      .sort((a, b) => a.worktreeId.localeCompare(b.worktreeId));
    const terminals = terms.terminals
      .slice(0, 1000)
      .sort((a, b) => a.handle.localeCompare(b.handle));
    return {
      worktrees,
      terminals,
      meta: {
        fetchedAt: new Date(this.now()).toISOString(),
        worktreeTotal: ps.totalCount,
        terminalTotal: terms.totalCount,
        inventoryIncomplete:
          ps.truncated ||
          terms.truncated ||
          ps.worktrees.length > 1000 ||
          terms.terminals.length > 1000,
        worktreeHostScope: ps.hostScope ?? null,
        terminalHostScope: terms.hostScope ?? null,
        hostCoverageVerified:
          !!ps.hostScope &&
          !!terms.hostScope &&
          ps.hostScope.omittedHostIds.length === 0 &&
          terms.hostScope.omittedHostIds.length === 0,
      },
    };
  }
  async overview(input: unknown = {}) {
    const options = parse(pageSchema, input),
      inv = await this.inventory();
    const counts: Record<string, number> = {
      working: 0,
      blocked: 0,
      waiting: 0,
      done: 0,
      unknown: 0,
    };
    for (const w of inv.worktrees)
      for (const a of w.agents) {
        const state = normalizeAgent(a, this.now()).state;
        counts[state] = (counts[state] ?? 0) + 1;
      }
    const p = page(
      inv.worktrees,
      options.limit,
      options.cursor,
      "overview" + JSON.stringify(inv.worktrees.map((w) => [w.hostId, w.worktreeId])),
    );
    return {
      ...inv.meta,
      countsScope: "fetched_inventory",
      agentCounts: counts,
      items: p.items.map((w) => normalizeWorktree(w, this.now())),
      nextCursor: p.nextCursor,
    };
  }
  async waiting(input: unknown = {}) {
    const options = parse(pageSchema, input),
      inv = await this.inventory();
    type Candidate = { key: string; worktreeId: string; agent?: Agent; terminal?: Terminal };
    const candidates: Candidate[] = [],
      matched = new Set<string>();
    for (const w of inv.worktrees)
      for (const a of w.agents) {
        const t = inv.terminals.find(
          (t) => t.worktreeId === w.worktreeId && `${t.tabId}:${t.leafId}` === a.paneKey,
        );
        if (t) matched.add(t.handle);
        candidates.push({
          key: `a:${w.worktreeId}:${a.paneKey}`,
          worktreeId: w.worktreeId,
          agent: a,
          terminal: t,
        });
      }
    for (const t of inv.terminals)
      if (!matched.has(t.handle))
        candidates.push({ key: `t:${t.handle}`, worktreeId: t.worktreeId, terminal: t });
    candidates.sort((a, b) => a.key.localeCompare(b.key));
    const p = page(
      candidates,
      options.limit,
      options.cursor,
      "waiting" + JSON.stringify(candidates.map((c) => [c.key, c.terminal?.handle])),
    );
    const rows = await mapBounded(p.items, async (c) => {
      const agent = c.agent ? normalizeAgent(c.agent, this.now()) : null;
      let wait: unknown = null,
        waitEvaluated = false,
        readError: ReturnType<typeof errorResult> | null = null;
      if (c.terminal) {
        try {
          const show = await this.adapter.show(c.terminal.handle);
          waitEvaluated = show.agentWait !== undefined;
          wait = show.agentWait
            ? {
                source: clip(show.agentWait.source, 80),
                reason: clip(show.agentWait.reason, 160),
                since: show.agentWait.since ?? null,
              }
            : null;
        } catch (e) {
          readError = errorResult(e);
        }
      }
      return {
        worktreeId: c.worktreeId,
        handle: c.terminal?.handle ?? null,
        agent,
        wait,
        waitEvaluated,
        readError,
      };
    });
    return {
      ...inv.meta,
      examined: rows.length,
      candidateTotal: candidates.length,
      items: rows.filter((r) => r.wait || r.agent?.attention),
      errors: rows
        .filter((r) => r.readError)
        .map((r) => ({ handle: r.handle, error: r.readError })),
      unevaluatedWaitCount: rows.filter((r) => !r.waitEvaluated).length,
      nextCursor: p.nextCursor,
      interpretation:
        "Agent blocked/waiting indicates attention, not necessarily human approval. Continue all pages, including empty pages, before concluding there are no waits.",
    };
  }
  async detail(input: unknown) {
    const { id } = parse(detailSchema, input),
      inv = await this.inventory();
    const w = inv.worktrees.find((w) => w.worktreeId === id);
    if (!w)
      throw new BridgeError(
        inv.meta.inventoryIncomplete ? "inventory_incomplete" : "not_found",
        "Worktree was not in the fetched inventory.",
      );
    const terminals = inv.terminals.filter((t) => t.worktreeId === id);
    const shown = await mapBounded(terminals.slice(0, 20), async (t) => {
      try {
        const s = await this.adapter.show(t.handle);
        return {
          ...t,
          title: clip(t.title, 200),
          agentWait: s.agentWait
            ? {
                source: clip(s.agentWait.source, 80),
                reason: clip(s.agentWait.reason, 160),
                since: s.agentWait.since ?? null,
              }
            : (s.agentWait ?? null),
          waitEvaluated: s.agentWait !== undefined,
        };
      } catch (e) {
        return { ...t, title: clip(t.title, 200), error: errorResult(e) };
      }
    });
    return {
      ...inv.meta,
      task: normalizeWorktree(w, this.now()),
      terminals: shown,
      terminalsTruncated: terminals.length > 20,
    };
  }

  async send(input: unknown) {
    const { handle, text } = parse(sendSchema, input);
    // Read exact target immediately before sending. Never select current/active/all.
    const target = await this.adapter.show(handle);
    if (
      target.handle !== handle ||
      !target.connected ||
      target.writable !== true ||
      !target.agentIdentity ||
      target.agentIdentity === "unknown"
    ) {
      throw new BridgeError(
        "send_target_unavailable",
        "Exact target must be connected, writable, and identified as an agent; no input was sent.",
      );
    }
    let result;
    try {
      result = await this.adapter.send(handle, text);
      if (result.handle !== handle)
        throw new BridgeError("target_mismatch", "Unexpected receipt target.");
    } catch (error) {
      if (error instanceof BridgeError && error.code === "cli_missing") throw error;
      // A lost receipt may follow a successful mutation. Never automatically retry.
      throw new BridgeError(
        "send_outcome_unknown",
        "The send outcome could not be verified. Input may have been accepted. Inspect the target; do not automatically resend.",
      );
    }
    return {
      observedAt: new Date(this.now()).toISOString(),
      handle,
      accepted: result.accepted,
      delivery: result.accepted ? "accepted" : "refused",
      turnStarted: result.accepted && (result.prompt?.stages.includes("turn_started") ?? false),
      completion: "not_observed",
      retrySafe: false,
      bytesWritten: result.bytesWritten,
      refusedReason: clip(result.refusedReason, 100),
      receipt: result.prompt
        ? {
            requestId: clip(result.prompt.requestId, 256),
            stages: result.prompt.stages.slice(0, 10).map((s) => clip(s, 80)),
            provider: clip(result.prompt.provider, 80),
            observation: clip(result.prompt.observation, 80),
          }
        : null,
    };
  }
  async logs(input: unknown) {
    const o = parse(logsSchema, input);
    const log = await this.adapter.logs(o.handle, o.limit, o.cursor);
    // A huge individual line is bounded too. Report exactly when the upstream cursor skips clipped text.
    const all = log.tail.slice(0, o.limit).join("\n");
    const tail = all.slice(0, o.maxChars);
    const outputClipped = all.length > o.maxChars || log.tail.length > o.limit;
    return {
      fetchedAt: new Date(this.now()).toISOString(),
      handle: log.handle,
      status: log.status,
      text: tail,
      source: log.source ?? "unknown",
      truncated: log.truncated,
      limited: log.limited ?? false,
      outputClipped,
      cursorAdvancesPastOmittedText: outputClipped,
      nextCursor: log.nextCursor,
      oldestCursor: log.oldestCursor ?? null,
      latestCursor: log.latestCursor ?? null,
      cursorUsableForHistory: log.source === "stream",
    };
  }
}
export const MAX_RESPONSE_BYTES = 256 * 1024;
export function serialize(value: unknown): string {
  const output = JSON.stringify(value);
  if (Buffer.byteLength(output) > MAX_RESPONSE_BYTES)
    throw new BridgeError("response_limit", "Response exceeded 256 KiB; retry with a lower limit.");
  return output;
}
