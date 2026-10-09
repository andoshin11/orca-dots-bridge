import { z } from "zod";
import { BridgeError } from "../errors.js";
import { unwrap, type Runner } from "../adapter.js";
import { identity } from "./orca-contract.js";

/**
 * A pane-scoped target. Unlike NotificationTarget it carries no provider
 * session, launch or authority epoch: the events that feed it come from the
 * orca-agent-status-relay plugin, and stock Orca's plugin events do not
 * expose those. `incarnationId` is the strongest identity the official CLI
 * reports; it changes when the pane's PTY is replaced, but not when a new
 * agent session starts inside the same PTY.
 */
export const paneTargetSchema = z
  .object({
    executionHostId: z.literal("local"),
    worktreeId: identity,
    terminalHandle: identity,
    paneKey: identity,
    incarnationId: identity,
  })
  .strict();
export type PaneTarget = z.infer<typeof paneTargetSchema>;
export function samePaneTarget(a: PaneTarget, b: PaneTarget): boolean {
  return (
    a.executionHostId === b.executionHostId &&
    a.worktreeId === b.worktreeId &&
    a.terminalHandle === b.terminalHandle &&
    a.paneKey === b.paneKey &&
    a.incarnationId === b.incarnationId
  );
}

const agentState = z.enum(["working", "blocked", "waiting", "done"]);
const time = z.number().finite().nonnegative().max(8640000000000000);
/** Body of one orca-agent-status-relay v0.1 status message. */
export const relayStatusSchema = z
  .object({
    type: z.literal("agent.status.changed"),
    kind: agentState,
    worktreeId: identity.nullable(),
    paneKey: identity,
    tabId: identity.nullable(),
    leafId: identity.nullable(),
    state: agentState,
    mainAgent: z
      .object({
        state: agentState,
        outcome: z.string().max(256).optional(),
        stateStartedAt: z.number().finite(),
      })
      .strict()
      .nullable(),
    receivedAt: time,
  })
  .strict();
export type RelayStatus = z.infer<typeof relayStatusSchema>;
export const relayMessageSchema = z.discriminatedUnion("type", [
  relayStatusSchema,
  z.object({ type: z.literal("relay.test"), sentAt: time }).strict(),
]);

const paneTerminalSchema = z.object({
  terminal: z.object({
    handle: identity,
    worktreeId: identity,
    tabId: identity,
    leafId: identity,
    incarnationId: identity,
    executionHostId: z.string().nullable().optional(),
  }),
});
export type PaneDescriber = (terminalHandle: string) => Promise<PaneTarget>;
/**
 * Reads a terminal's current pane identity through the official Orca CLI.
 * paneKey is `<tabId>:<leafId>`, the same pair the relay plugin reports.
 */
export function createPaneDescriber(run: Runner): PaneDescriber {
  return async (terminalHandle) => {
    const parsed = paneTerminalSchema.safeParse(
      unwrap(await run(["terminal", "show", "--terminal", terminalHandle])),
    );
    if (!parsed.success)
      throw new BridgeError("schema_changed", "Orca terminal identity is incompatible.");
    const t = parsed.data.terminal;
    if (t.handle !== terminalHandle || (t.executionHostId ?? "local") !== "local")
      throw new BridgeError("target_unavailable", "The terminal is not a local Orca pane.");
    return paneTargetSchema.parse({
      executionHostId: "local",
      worktreeId: t.worktreeId,
      terminalHandle: t.handle,
      paneKey: `${t.tabId}:${t.leafId}`,
      incarnationId: t.incarnationId,
    });
  };
}
