import { z } from "zod";
const identity = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      value.trim() === value &&
      !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
  );
export const notificationTargetSchema = z
  .object({
    executionHostId: z.literal("local"),
    worktreeId: identity,
    terminalHandle: identity,
    paneKey: identity,
    incarnationId: identity,
    launchId: identity,
    providerSessionId: identity,
  })
  .strict();
export type NotificationTarget = z.infer<typeof notificationTargetSchema>;
export const notificationSubscribeSchema = z
  .object({
    version: z.literal(2),
    target: notificationTargetSchema,
    ttlSeconds: z.number().int().min(1).max(3600),
  })
  .strict();
export const interruptionReasons = [
  "disconnected",
  "identity_changed",
  "authority_changed",
  "expired",
  "evidence_missing",
  "capacity",
  "cancelled",
] as const;
export type InterruptionReason = (typeof interruptionReasons)[number];
export const notificationEventSchema = z
  .object({
    version: z.literal(2),
    target: notificationTargetSchema,
    authorityEpoch: identity,
    sequence: z.number().int().positive().safe(),
    eventId: identity,
    occurredAt: z.number().int().nonnegative().max(8640000000000000),
    kind: z.enum(["input_required", "turn_finished", "monitoring_interrupted"]),
    outcome: z.literal("unconfirmed").optional(),
    reason: z.enum(interruptionReasons).optional(),
  })
  .strict()
  .refine((value) =>
    value.kind === "turn_finished"
      ? value.outcome === "unconfirmed" && value.reason === undefined
      : value.kind === "monitoring_interrupted"
        ? value.reason !== undefined && value.outcome === undefined
        : value.reason === undefined && value.outcome === undefined,
  );
export type NotificationEvent = z.infer<typeof notificationEventSchema>;
export const notificationAcceptedSchema = z
  .object({
    version: z.literal(2),
    subscriptionId: identity,
    target: notificationTargetSchema,
    authorityEpoch: identity,
    baselineSequence: z.literal(0),
    expiresAt: z.number().int().nonnegative().max(8640000000000000),
    replayCursor: z.null(),
  })
  .strict();
export type NotificationAccepted = z.infer<typeof notificationAcceptedSchema>;
export function sameNotificationTarget(a: NotificationTarget, b: NotificationTarget): boolean {
  return (
    a.executionHostId === b.executionHostId &&
    a.worktreeId === b.worktreeId &&
    a.terminalHandle === b.terminalHandle &&
    a.paneKey === b.paneKey &&
    a.incarnationId === b.incarnationId &&
    a.launchId === b.launchId &&
    a.providerSessionId === b.providerSessionId
  );
}

export const sessionNotificationUnsubscribeSchema = z
  .object({ subscriptionId: z.string().min(1).max(256) })
  .strict();

export const notificationDescribeSchema = z.object({ terminalHandle: identity }).strict();
