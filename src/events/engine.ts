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
const finiteTime = z.number().int().nonnegative().max(8640000000000000);
const bounded = z.string().min(1).max(512);
const eventSchema = z
  .object({
    eventId: bounded,
    name: z.enum(eventNames),
    timestamp: z.string().datetime(),
    cursor: z.null(),
    data: z
      .object({
        target: targetSchema,
        turnId: bounded,
        state: z.enum(["done", "waiting", "blocked"]),
        outcome: z.string().max(32).optional(),
      })
      .strict(),
  })
  .strict();
const subscriptionSchema = z
  .object({
    id: bounded,
    owner: bounded,
    name: z.enum(eventNames),
    target: targetSchema,
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
export const subscribeSchema = z
  .object({
    name: z.enum(eventNames),
    arguments: targetSchema,
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
  .strict();
export const unsubscribeSchema = z
  .object({
    name: z.enum(eventNames),
    arguments: targetSchema,
    delivery: z.object({ mode: z.literal("webhook"), url: z.string().max(4096) }).strict(),
  })
  .strict();
export interface Store {
  /** A production adapter must atomically persist before resolving; no file adapter is enabled here. */
  load(): Promise<string | null>;
  save(sealedState: string): Promise<void>;
}
export type Authorize = (owner: string, target: Target) => Promise<boolean>;
export type EngineOptions = {
  store: Store;
  key: Buffer;
  post: Post;
  authorize: Authorize;
  allowedCallbackHosts: readonly string[];
  now?: () => number;
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
        } catch {
          throw new EventError("callback_verification_failed");
        }
        let echoed: unknown;
        try {
          echoed = (JSON.parse(reply.body) as { challenge?: unknown }).challenge;
        } catch {
          /* fixed error below */
        }
        if (
          reply.status < 200 ||
          reply.status >= 300 ||
          this.now() - started > 10000 ||
          this.now() < started ||
          !equalChallenge(echoed, challenge)
        )
          throw new EventError("callback_verification_failed");
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
        expiresAt: now + (p.ttlMs ?? 3600000),
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
