import { EventEngine } from "./engine.js";
import { eventNames, type Target } from "./model.js";
import { EventError } from "./webhook.js";
import { z } from "zod";
const field = { type: "string", minLength: 1, maxLength: 256, pattern: "^[a-zA-Z0-9_.:@/-]+$" };
const properties: Record<keyof Target, object> = {
  hostId: field,
  worktreeId: field,
  paneKey: field,
  terminalHandle: { ...field, pattern: "^term_[a-zA-Z0-9_-]+$" },
  sessionId: field,
  generation: field,
};
const targetJson = {
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
};
export const catalog = eventNames.map((name) => ({
  name,
  description:
    name === "orca.turn_finished"
      ? "One explicitly selected session finished a confirmed turn; not project completion."
      : "One explicitly selected session reports input or approval waiting.",
  delivery: ["webhook"],
  inputSchema: targetJson,
  payloadSchema: {
    type: "object",
    properties: {
      target: targetJson,
      turnId: field,
      state: { enum: ["done", "waiting", "blocked"] },
      outcome: { type: "string" },
    },
    required: ["target", "turnId", "state"],
    additionalProperties: false,
  },
}));
export class EventsRpcError extends Error {
  constructor(
    public readonly code: number,
    public readonly data: { reason: string },
  ) {
    super("Event request rejected");
  }
}
/** Framework-neutral adapter. `authorization` MUST come from HTTP transport, never params/_meta.
 * Intentionally unregistered in both current stdio entry points. */
export function eventRpc(
  engine: EventEngine,
  resolveOwner: (authorization: string | undefined) => Promise<string>,
) {
  return async (method: string, params: unknown, authorization: string | undefined) => {
    try {
      const owner = await resolveOwner(authorization);
      if (method === "events/list") {
        const p = z
          .object({ cursor: z.null().optional() })
          .strict()
          .safeParse(params ?? {});
        if (!p.success) throw new EventError("invalid_params");
        return { events: structuredClone(catalog) };
      }
      if (method === "events/subscribe") return await engine.subscribe(owner, params);
      if (method === "events/unsubscribe") return await engine.unsubscribeMatching(owner, params);
      throw new EventError("method_not_found");
    } catch (error) {
      const reason = error instanceof EventError ? error.code : "internal_error";
      const code =
        reason === "callback_verification_failed"
          ? -32015
          : reason === "invalid_params"
            ? -32602
            : reason === "method_not_found"
              ? -32601
              : -32000;
      throw new EventsRpcError(code, {
        reason: reason === "callback_verification_failed" ? "challenge_failed" : reason,
      });
    }
  };
}
