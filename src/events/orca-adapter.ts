import { z } from "zod";
import { createHash } from "node:crypto";
import {
  notificationAcceptedSchema,
  notificationEventSchema,
  sameNotificationTarget,
  type NotificationAccepted,
  type NotificationTarget,
} from "./orca-contract.js";

export const externalOrcaEventSchema = z
  .object({
    eventId: z.string().min(1).max(512),
    name: z.enum(["orca.turn_finished", "orca.input_waiting", "orca.monitoring_interrupted"]),
    timestamp: z.string().datetime(),
    cursor: z.null(),
    data: z
      .object({
        subscriptionId: z.string().min(1).max(512),
        outcome: z.literal("unconfirmed").optional(),
        reason: z.string().max(64).optional(),
      })
      .strict(),
  })
  .strict()
  .refine((e) =>
    e.name === "orca.turn_finished"
      ? e.data.outcome === "unconfirmed" && e.data.reason === undefined
      : e.name === "orca.monitoring_interrupted"
        ? e.data.reason !== undefined && e.data.outcome === undefined
        : e.data.reason === undefined && e.data.outcome === undefined,
  );
export type ExternalOrcaEvent = z.infer<typeof externalOrcaEventSchema>;
export class OrcaNotificationAdapter {
  private accepted: NotificationAccepted;
  private sequence = 0;
  private closed = false;
  private stopReason: string | null = null;
  status() {
    if (!this.closed && this.now() >= this.accepted.expiresAt) this.close("expired");
    return { state: this.closed ? "interrupted" : "active", reason: this.stopReason };
  }
  constructor(
    raw: unknown,
    selected: NotificationTarget,
    private readonly now = Date.now,
  ) {
    this.accepted = notificationAcceptedSchema.parse(raw);
    if (!sameNotificationTarget(this.accepted.target, selected) || this.accepted.expiresAt <= now())
      throw new Error("notification_target_unavailable");
  }
  close(reason = "disconnected"): void {
    this.stopReason = reason;
    this.closed = true;
  }
  accept(raw: unknown): ExternalOrcaEvent | null {
    if (this.closed) return null;
    const parsed = notificationEventSchema.safeParse(raw);
    if (!parsed.success) {
      this.close("invalid_event");
      return null;
    }
    const e = parsed.data;
    if (this.now() >= this.accepted.expiresAt && e.kind !== "monitoring_interrupted") {
      this.close("expired");
      return null;
    }
    if (
      !sameNotificationTarget(e.target, this.accepted.target) ||
      e.authorityEpoch !== this.accepted.authorityEpoch
    ) {
      this.close("identity_changed");
      return null;
    }
    if (e.sequence <= this.sequence) return null;
    if (e.sequence !== this.sequence + 1 || e.occurredAt > this.now() + 5000) {
      this.close("stream_gap");
      return null;
    }
    this.sequence = e.sequence;
    if (e.kind === "monitoring_interrupted") this.close(e.reason);
    const opaque = (value: string) =>
      createHash("sha256")
        .update(JSON.stringify([this.accepted.subscriptionId, value]))
        .digest("hex");
    return {
      eventId: opaque(e.eventId),
      name:
        e.kind === "turn_finished"
          ? "orca.turn_finished"
          : e.kind === "input_required"
            ? "orca.input_waiting"
            : "orca.monitoring_interrupted",
      timestamp: new Date(e.occurredAt).toISOString(),
      cursor: null,
      data: {
        subscriptionId: opaque(this.accepted.subscriptionId),

        ...(e.outcome ? { outcome: e.outcome } : {}),
        ...(e.reason ? { reason: e.reason } : {}),
      },
    };
  }
}
