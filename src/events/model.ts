import { createHash } from "node:crypto";
import { z } from "zod";
const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9_.:@/-]+$/);
export const targetSchema = z
  .object({
    hostId: id,
    worktreeId: id,
    paneKey: id,
    terminalHandle: id.regex(/^term_[a-zA-Z0-9_-]+$/),
    sessionId: id,
    generation: id,
  })
  .strict();
export type Target = z.infer<typeof targetSchema>;
export const eventNames = ["orca.turn_finished", "orca.input_waiting"] as const;
export type EventName = (typeof eventNames)[number];
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export const sameTarget = (a: Target, b: Target) => canonical(a) === canonical(b);
const observationSchema = z
  .object({
    target: targetSchema,
    turnId: id,
    transitionId: id,
    occurredAt: z.number().int().nonnegative(),
    state: z.enum(["working", "blocked", "waiting", "done"]),
    restored: z.boolean(),
    isTurnEnd: z.boolean(),
    outcome: z.enum(["completed", "error", "interruption", "unconfirmed"]).optional(),
  })
  .strict();
export type Event = {
  eventId: string;
  name: EventName;
  timestamp: string;
  cursor: null;
  data: { target: Target; turnId: string; state: "done" | "waiting" | "blocked"; outcome?: string };
};
/** Input MUST be stamped by a trusted source adapter at occurrence, not enriched by a later pane lookup.
 * Raw Orca 1.4.220 plugin payloads intentionally fail: they lack session/turn/generation proof. */
export function projectObservation(raw: unknown, selected: Target, now: number): Event | null {
  const result = observationSchema.safeParse(raw);
  if (!result.success) return null;
  const o = result.data;
  if (!sameTarget(o.target, selected) || o.restored || o.occurredAt > now + 5000) return null;
  let name: EventName;
  if (o.state === "done") {
    if (!o.isTurnEnd || !o.outcome || ["interruption", "unconfirmed"].includes(o.outcome))
      return null;
    name = "orca.turn_finished";
  } else if (o.state === "waiting" || o.state === "blocked") name = "orca.input_waiting";
  else return null;
  return {
    eventId: `evt_${digest([o.target, o.turnId, o.transitionId, name])}`,
    name,
    timestamp: new Date(o.occurredAt).toISOString(),
    cursor: null,
    data: {
      target: o.target,
      turnId: o.turnId,
      state: o.state,
      ...(o.state === "done" && o.outcome ? { outcome: o.outcome } : {}),
    },
  };
}
