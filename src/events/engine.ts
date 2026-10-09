import type { DiagnosticRecord } from "./preflight-diagnostics.js";
import { deliveryFailureStage } from "./delivery-diagnostics.js";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import { digest, eventNames, projectObservation, targetSchema, type Target } from "./model.js";
import {
  callbackUrl,
  equalChallenge,
  EventError,
  headersFor,
  signingKey,
  type Post,
} from "./webhook.js";
import { notificationTargetSchema, type NotificationTarget } from "./orca-contract.js";
import { externalOrcaEventSchema } from "./orca-adapter.js";
import { paneTargetSchema, type PaneTarget } from "./pane-contract.js";
const engineTargetSchema = z.union([targetSchema, notificationTargetSchema, paneTargetSchema]);
const engineEventNames = [
  ...eventNames,
  "orca.monitoring_interrupted",
  "orca.session_activity",
  "orca.pane_activity",
] as const;
export type EngineTarget = Target | NotificationTarget | PaneTarget;
const finiteTime = z.number().int().nonnegative().max(8640000000000000);
const bounded = z.string().min(1).max(512);
const legacyEventSchema = z
  .object({
    eventId: bounded,
    name: z.enum(engineEventNames),
    timestamp: z.string().datetime(),
    cursor: z.null(),
    data: z
      .object({
        target: engineTargetSchema,
        turnId: bounded,
        state: z.enum(["done", "waiting", "blocked"]),
        outcome: z.string().max(32).optional(),
      })
      .strict(),
  })
  .strict();
const sessionActivitySchema = z
  .object({
    eventId: bounded,
    name: z.literal("orca.session_activity"),
    timestamp: z.string().datetime(),
    cursor: z.null(),
    data: z
      .object({
        subscriptionId: bounded,
        freshness: z.literal("receipt_only"),
        kind: z.enum(["turn_finished", "input_required", "monitoring_interrupted"]),
        outcome: z.literal("unconfirmed").optional(),
        reason: z.string().max(64).optional(),
      })
      .strict(),
  })
  .strict()
  .refine((e) =>
    e.data.kind === "turn_finished"
      ? e.data.outcome === "unconfirmed" && e.data.reason === undefined
      : e.data.kind === "monitoring_interrupted"
        ? e.data.reason !== undefined && e.data.outcome === undefined
        : e.data.outcome === undefined && e.data.reason === undefined,
  );
/** Pane-scoped activity from the relay plugin: no session, turn or sequence proof. */
const paneActivitySchema = z
  .object({
    eventId: bounded,
    name: z.literal("orca.pane_activity"),
    timestamp: z.string().datetime(),
    cursor: z.null(),
    data: z
      .object({
        subscriptionId: bounded,
        freshness: z.literal("receipt_only"),
        assurance: z.literal("pane_only"),
        kind: z.enum(["turn_finished", "input_required", "monitoring_interrupted"]),
        outcome: z.literal("unconfirmed").optional(),
        reason: z.string().max(64).optional(),
      })
      .strict(),
  })
  .strict()
  .refine((e) =>
    e.data.kind === "turn_finished"
      ? e.data.outcome === "unconfirmed" && e.data.reason === undefined
      : e.data.kind === "monitoring_interrupted"
        ? e.data.reason !== undefined && e.data.outcome === undefined
        : e.data.outcome === undefined && e.data.reason === undefined,
  );
const monitoredActivitySchema = z.union([sessionActivitySchema, paneActivitySchema]);
const eventSchema = z.union([
  legacyEventSchema,
  externalOrcaEventSchema,
  sessionActivitySchema,
  paneActivitySchema,
]);
const subscriptionSchema = z
  .object({
    id: bounded,
    owner: bounded,
    name: z.enum(engineEventNames),
    target: engineTargetSchema,
    url: z.string().max(4096),
    secret: z.string().max(100),
    previous: z
      .object({ secret: z.string().max(100), until: finiteTime })
      .strict()
      .optional(),
    createdAt: finiteTime,
    expiresAt: finiteTime,
    verifiedUntil: finiteTime,
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    subscriptions: z.array(subscriptionSchema).max(16),
    pending: z
      .array(
        z
          .object({
            subId: bounded,
            event: eventSchema,
            body: z.string().max(262144),
            attempts: z.number().int().min(0).max(5),
            nextAt: finiteTime,
          })
          .strict(),
      )
      .max(128),
    seen: z.array(z.object({ subId: bounded, eventId: bounded }).strict()).max(2048),
  })
  .strict();
type State = z.infer<typeof stateSchema>;
// The pane event name and the pane target shape only ever go together, so a
// pane-scoped subscription can never be created for a stricter target or the reverse.
const paneNameMatchesTarget = (value: { name: string; arguments: unknown }) =>
  (value.name === "orca.pane_activity") === paneTargetSchema.safeParse(value.arguments).success;
export const subscribeSchema = z
  .object({
    name: z.enum(engineEventNames),
    arguments: engineTargetSchema,
    delivery: z
      .object({
        mode: z.literal("webhook"),
        url: z.string().max(4096),
        secret: z.string().max(100),
      })
      .strict(),
    ttlMs: z.number().int().min(1000).max(86400000).nullable().optional(),
    cursor: z.null().optional(),
  })
  .strict()
  .refine(paneNameMatchesTarget, { message: "event_target_mismatch", path: ["arguments"] });
export const unsubscribeSchema = z
  .object({
    name: z.enum(engineEventNames),
    arguments: engineTargetSchema,
    delivery: z.object({ mode: z.literal("webhook"), url: z.string().max(4096) }).strict(),
  })
  .strict()
  .refine(paneNameMatchesTarget, { message: "event_target_mismatch", path: ["arguments"] });
export interface Store {
  /** A production adapter must atomically persist before resolving; no file adapter is enabled here. */
  load(): Promise<string | null>;
  save(sealedState: string): Promise<void>;
}
export type Authorize = (owner: string, target: EngineTarget) => Promise<boolean>;
export type EngineOptions = {
  diagnostic?: DiagnosticRecord;
  store: Store;
  key: Buffer;
  post: Post;
  authorize: Authorize;
  allowedCallbackHosts: readonly string[];
  now?: () => number;
  expiresAt?: number;
};
function seal(state: State, key: Buffer): string {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from("orca-events-state-v1"));
  const payload = Buffer.concat([cipher.update(JSON.stringify(state)), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), payload]).toString("base64");
}
function unseal(blob: string, key: Buffer): State {
  try {
    if (blob.length > 48000000) throw new Error();
    const bytes = Buffer.from(blob, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from("orca-events-state-v1"));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return stateSchema.parse(
      JSON.parse(
        Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"),
      ),
    );
  } catch {
    throw new EventError("state_unavailable");
  }
}
/** Serial, bounded outbox. Not connected to live MCP/Orca; callers supply trusted auth and atomic storage. */
export class EventEngine {
  private state: State;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private constructor(
    private readonly options: EngineOptions,
    state: State,
  ) {
    this.state = state;
    this.now = options.now ?? Date.now;
  }
  static async open(options: EngineOptions) {
    if (options.key.length !== 32) throw new EventError("invalid_storage_key");
    const blob = await options.store.load();
    return new EventEngine(
      options,
      blob ? unseal(blob, options.key) : { version: 1, subscriptions: [], pending: [], seen: [] },
    );
  }
  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      // Reload after every operation, including a failed persistence attempt. Never deliver unsaved state.
      const blob = await this.options.store.load();
      this.state = blob
        ? unseal(blob, this.options.key)
        : { version: 1, subscriptions: [], pending: [], seen: [] };
      this.expire();
      return operation();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
  private async persist() {
    try {
      await this.options.store.save(seal(this.state, this.options.key));
    } catch {
      throw new EventError("state_unavailable");
    }
  }
  private remove(id: string) {
    this.state.subscriptions = this.state.subscriptions.filter((s) => s.id !== id);
    this.state.pending = this.state.pending.filter((p) => p.subId !== id);
    this.state.seen = this.state.seen.filter((p) => p.subId !== id);
  }
  private expire() {
    for (const s of this.state.subscriptions) {
      if (s.expiresAt <= this.now()) this.remove(s.id);
      else if (s.previous && s.previous.until <= this.now()) delete s.previous;
    }
  }
  async subscribe(owner: string, input: unknown) {
    return this.serial(async () => {
      if (!owner || owner.length > 512) throw new EventError("unauthorized");
      const parsed = subscribeSchema.safeParse(input);
      if (!parsed.success) throw new EventError("invalid_params");
      const p = parsed.data;
      if (!(await this.options.authorize(owner, p.arguments))) throw new EventError("forbidden");
      const url = callbackUrl(p.delivery.url, this.options.allowedCallbackHosts).href;
      signingKey(p.delivery.secret);
      const id = `sub_${digest([owner, url, p.name, p.arguments])}`;
      const existing = this.state.subscriptions.find((s) => s.id === id);
      if (!existing && this.state.subscriptions.length >= 16)
        throw new EventError("subscription_limit");
      if (
        existing?.previous &&
        existing.previous.until > this.now() &&
        existing.secret !== p.delivery.secret
      )
        throw new EventError("rotation_busy");
      const cached = this.state.subscriptions.find(
        (s) =>
          s.owner === owner &&
          s.url === url &&
          s.secret === p.delivery.secret &&
          s.verifiedUntil > this.now(),
      );
      if (!cached) {
        const challenge = randomBytes(32).toString("base64url"),
          started = this.now();
        const body = JSON.stringify({ type: "verification", challenge });
        let reply;
        try {
          reply = await this.options.post(
            url,
            headersFor(
              `verify_${randomBytes(16).toString("hex")}`,
              id,
              body,
              [p.delivery.secret],
              this.now(),
            ),
            body,
          );
        } catch (error) {
          if (!(error instanceof EventError && error.code === "callback_approval_required"))
            this.options.diagnostic?.("challenge_failed");
          throw new EventError("callback_verification_failed", deliveryFailureStage(error));
        }
        let echoed: unknown;
        let validJson = true;
        try {
          const value: unknown = JSON.parse(reply.body);
          echoed =
            value !== null && typeof value === "object"
              ? (value as { challenge?: unknown }).challenge
              : undefined;
        } catch {
          validJson = false;
        }
        if (
          reply.status < 200 ||
          reply.status >= 300 ||
          this.now() - started > 10000 ||
          this.now() < started ||
          !equalChallenge(echoed, challenge)
        ) {
          const reason =
            reply.status === 401 || reply.status === 403
              ? "challenge_http_auth_rejected"
              : reply.status === 429
                ? "challenge_http_rate_limited"
                : reply.status >= 400 && reply.status < 500
                  ? "challenge_http_4xx"
                  : reply.status >= 500 && reply.status < 600
                    ? "challenge_http_5xx"
                    : reply.status < 200 || reply.status >= 300
                      ? "challenge_http_other"
                      : this.now() < started
                        ? "challenge_clock_invalid"
                        : this.now() - started > 10000
                          ? "challenge_reply_late"
                          : !validJson
                            ? "challenge_json_invalid"
                            : typeof echoed !== "string"
                              ? "challenge_echo_missing"
                              : "challenge_echo_mismatch";
          this.options.diagnostic?.(reason);
          this.options.diagnostic?.("challenge_response_rejected");
          this.options.diagnostic?.("challenge_failed");
          throw new EventError("callback_verification_failed", reason);
        }
        this.options.diagnostic?.("challenge_succeeded");
      }
      // Access can change while the verification request is in flight.
      if (!(await this.options.authorize(owner, p.arguments))) throw new EventError("forbidden");
      const now = this.now();
      const subscription = {
        id,
        owner,
        name: p.name,
        target: p.arguments,
        url,
        secret: p.delivery.secret,
        createdAt: existing?.createdAt ?? now,
        expiresAt: Math.min(now + (p.ttlMs ?? 3600000), this.options.expiresAt ?? Infinity),
        verifiedUntil: cached?.verifiedUntil ?? now + 60000,
        ...(existing && existing.secret !== p.delivery.secret
          ? { previous: { secret: existing.secret, until: now + 60000 } }
          : existing?.previous && existing.previous.until > now
            ? { previous: existing.previous }
            : {}),
      };
      this.state.subscriptions = this.state.subscriptions.filter((s) => s.id !== id);
      this.state.subscriptions.push(subscription);
      await this.persist();
      this.options.diagnostic?.(existing ? "subscription_refreshed" : "subscription_created");
      return {
        id,
        refreshBefore: new Date(subscription.expiresAt).toISOString(),
        cursor: null,
        truncated: false,
      };
    });
  }
  async unsubscribe(owner: string, id: string) {
    return this.serial(async () => {
      const found = this.state.subscriptions.find((s) => s.id === id);
      if (found && found.owner !== owner) throw new EventError("subscription_not_found");
      this.remove(id);
      await this.persist();
      if (found) this.options.diagnostic?.("subscription_removed");
      return {};
    });
  }
  async unsubscribeMatching(owner: string, input: unknown) {
    if (!owner || owner.length > 512) throw new EventError("unauthorized");
    const parsed = unsubscribeSchema.safeParse(input);
    if (!parsed.success) throw new EventError("invalid_params");
    const p = parsed.data;
    const url = callbackUrl(p.delivery.url, this.options.allowedCallbackHosts).href;
    return this.unsubscribe(owner, `sub_${digest([owner, url, p.name, p.arguments])}`);
  }
  async ingest(observation: unknown) {
    return this.serial(async () => {
      const result = { queued: 0, duplicate: 0, rejected: 0 };
      for (const s of this.state.subscriptions) {
        if (!(await this.options.authorize(s.owner, s.target))) {
          this.remove(s.id);
          continue;
        }
        if (!("hostId" in s.target)) continue;
        const event = projectObservation(observation, s.target, this.now());
        if (!event || event.name !== s.name || Date.parse(event.timestamp) < s.createdAt) continue;
        if (this.state.seen.some((p) => p.subId === s.id && p.eventId === event.eventId)) {
          result.duplicate++;
          continue;
        }
        if (
          this.state.pending.length >= 128 ||
          this.state.pending.filter((p) => p.subId === s.id).length >= 16 ||
          this.state.seen.length >= 2048
        ) {
          result.rejected++;
          continue;
        }
        const body = JSON.stringify(event);
        this.state.pending.push({ subId: s.id, event, body, attempts: 0, nextAt: this.now() });
        this.state.seen.push({ subId: s.id, eventId: event.eventId });
        result.queued++;
      }
      await this.persist();
      return result;
    });
  }
  /** A verified RPC stream is scoped to one owner and subscription, never broadcast. */
  async ingestSession(
    owner: string,
    id: string,
    target: NotificationTarget | PaneTarget,
    input: unknown,
  ) {
    return this.serial(async () => {
      const s = this.state.subscriptions.find((item) => item.id === id && item.owner === owner);
      const parsed = monitoredActivitySchema.safeParse(input);
      if (
        !s ||
        !parsed.success ||
        digest(s.target) !== digest(target) ||
        !(await this.options.authorize(owner, s.target))
      )
        return false;
      const event = parsed.data;
      if (
        event.name !== s.name ||
        Date.parse(event.timestamp) < s.createdAt ||
        this.state.seen.some((p) => p.subId === id && p.eventId === event.eventId)
      )
        return false;
      if (
        this.state.pending.length >= 128 ||
        this.state.pending.filter((p) => p.subId === id).length >= 16 ||
        this.state.seen.length >= 2048
      )
        throw new EventError("queue_limit");
      this.state.pending.push({
        subId: id,
        event,
        body: JSON.stringify(event),
        attempts: 0,
        nextAt: this.now(),
      });
      this.state.seen.push({ subId: id, eventId: event.eventId });
      await this.persist();
      return true;
    });
  }
  async hasSubscription(owner: string, id: string) {
    return this.serial(async () =>
      this.state.subscriptions.some(
        (s) => s.id === id && s.owner === owner && s.expiresAt > this.now(),
      ),
    );
  }
  /** One bounded delivery pass; no timer, daemon or implicit monitoring. */
  async deliver() {
    return this.serial(async () => {
      const result = { accepted: 0, retried: 0, stopped: 0 };
      for (const p of this.state.pending) {
        const s = this.state.subscriptions.find((s) => s.id === p.subId);
        if (!s || s.expiresAt <= this.now()) {
          this.remove(p.subId);
          continue;
        }
        if (!(await this.options.authorize(s.owner, s.target))) {
          this.remove(s.id);
          result.stopped++;
          continue;
        }
        if (p.nextAt > this.now()) continue;
        if (p.attempts >= 5) {
          this.state.pending = this.state.pending.filter((v) => v !== p);
          result.stopped++;
          continue;
        }
        p.attempts++;
        p.nextAt = this.now() + Math.min(60000, 1000 * 2 ** (p.attempts - 1));
        await this.persist(); // Reserve attempt before I/O, including after restart.
        let status = 0,
          permanent = false;
        try {
          const secrets = [s.secret];
          if (s.previous && s.previous.until > this.now()) secrets.push(s.previous.secret);
          status = (
            await this.options.post(
              s.url,
              headersFor(p.event.eventId, s.id, p.body, secrets, this.now()),
              p.body,
            )
          ).status;
        } catch (error) {
          permanent =
            error instanceof EventError &&
            ["callback_rejected", "redirect_rejected", "payload_limit"].includes(error.code);
        }
        if (status >= 200 && status < 300) {
          this.state.pending = this.state.pending.filter((v) => v !== p);
          result.accepted++;
        } else if ([401, 403, 410].includes(status) || permanent) {
          this.remove(s.id);
          result.stopped++;
        } else if (
          status === 413 ||
          (status >= 400 && status < 500 && status !== 429) ||
          p.attempts >= 5
        ) {
          this.state.pending = this.state.pending.filter((v) => v !== p);
          result.stopped++;
        } else result.retried++;
        await this.persist();
      }
      await this.persist();
      return result;
    });
  }
}
