import type { DiagnosticRecord } from "./preflight-diagnostics.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { EventEngine, subscribeSchema, unsubscribeSchema } from "./engine.js";
import { notificationTargetSchema, notificationAcceptedSchema } from "./orca-contract.js";
import { OrcaNotificationAdapter } from "./orca-adapter.js";
import { EventError } from "./webhook.js";
export interface OrcaEventTransport {
  open(
    method: "terminal.agentEvents.subscribe",
    params: unknown,
    receive: (frame: unknown) => void,
  ): Promise<() => Promise<void>>;
}
const frameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), subscription: z.unknown() }).strict(),
  z.object({ type: z.literal("event"), event: z.unknown() }).strict(),
  z.object({ type: z.literal("end") }).strict(),
]);
export const sessionCatalog = [
  {
    name: "orca.session_activity",
    description:
      "Observe one selected session's turn end (success unconfirmed), input wait, or monitoring interruption. Missing evidence stops monitoring; Report a received observation, never assert a newly ended turn: provider execution time and unmarked replay are not provable.",
    delivery: ["webhook"],
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        [
          "executionHostId",
          "worktreeId",
          "terminalHandle",
          "paneKey",
          "incarnationId",
          "launchId",
          "providerSessionId",
        ].map((key) => [
          key,
          key === "executionHostId"
            ? { const: "local" }
            : { type: "string", minLength: 1, maxLength: 4096 },
        ]),
      ),
      required: [
        "executionHostId",
        "worktreeId",
        "terminalHandle",
        "paneKey",
        "incarnationId",
        "launchId",
        "providerSessionId",
      ],
      additionalProperties: false,
    },
    payloadSchema: {
      type: "object",
      properties: {
        subscriptionId: { type: "string" },
        freshness: { const: "receipt_only" },
        kind: { enum: ["turn_finished", "input_required", "monitoring_interrupted"] },
        outcome: { const: "unconfirmed" },
        reason: { type: "string" },
      },
      required: ["subscriptionId", "kind", "freshness"],
      additionalProperties: false,
    },
  },
];
/** One process owns these streams; restart deliberately requires a new authenticated subscription. */
export class SessionEventsRpc {
  private streams = new Map<
    string,
    { owner: string; stop: () => Promise<void>; isActive: () => boolean }
  >();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private trialIdentity: string | undefined;
  private trialResult: Record<string, unknown> | undefined;
  private trialEnded = false;
  private deferred:
    | {
        owner: string;
        params: unknown;
        result: { id: string; refreshBefore: string; cursor: null; truncated: boolean };
      }
    | undefined;
  private activating = false;
  constructor(
    private engine: EventEngine,
    private transport: OrcaEventTransport,
    private now = Date.now,
    private maxTtlMs = 3600000,
    private expiresAt = Number.POSITIVE_INFINITY,
    private singleSubscription = false,
    private diagnostic?: DiagnosticRecord,
    private deferMonitoring = false,
  ) {}
  dispatch(owner: string, method: string, params: unknown): Promise<Record<string, unknown>> {
    const operation = this.queue.then(() => {
      if (this.closed) throw new EventError("runtime_unavailable");
      return this.run(owner, method, params);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  private async run(
    owner: string,
    method: string,
    params: unknown,
  ): Promise<Record<string, unknown>> {
    if (!owner) throw new EventError("unauthorized");
    if (method === "events/list") {
      z.object({ cursor: z.null().optional() })
        .strict()
        .parse(params ?? {});
      return { events: structuredClone(sessionCatalog) };
    }
    if (method === "events/unsubscribe") {
      const p = unsubscribeSchema.parse(params);
      notificationTargetSchema.parse(p.arguments);
      await this.engine.unsubscribeMatching(owner, p);
      if (
        this.deferred &&
        this.identity(owner, p) ===
          this.identity(this.deferred.owner, subscribeSchema.parse(this.deferred.params))
      )
        this.deferred = undefined;
      if (this.singleSubscription && this.trialIdentity) this.trialEnded = true;
      const key = this.identity(owner, p);
      const stream = this.streams.get(key);
      if (stream?.owner === owner) {
        await stream.stop();
        this.streams.delete(key);
      }
      return {};
    }
    if (method !== "events/subscribe") throw new EventError("method_not_found");
    if (this.deferMonitoring && !this.activating && (this.deferred || this.trialIdentity))
      throw new EventError("subscription_limit");
    const p = subscribeSchema.parse(params);
    if (p.name !== "orca.session_activity") throw new EventError("invalid_params");
    const target = notificationTargetSchema.parse(p.arguments);
    const ttlMs = Math.min(p.ttlMs ?? this.maxTtlMs, this.maxTtlMs, this.expiresAt - this.now());
    if (ttlMs < 2000) throw new EventError("invalid_params");
    const trialIdentity = digest([
      owner,
      new URL(p.delivery.url).href,
      p.name,
      target,
      p.delivery.secret,
    ]);
    if (this.singleSubscription) {
      if (this.trialEnded || (this.trialIdentity && trialIdentity !== this.trialIdentity))
        throw new EventError("subscription_limit");
      if (this.trialResult) {
        if (!this.streams.get(this.identity(owner, p))?.isActive())
          throw new EventError("runtime_unavailable");
        return { ...this.trialResult };
      }
    }
    const result =
      this.activating && this.deferred
        ? this.deferred.result
        : await this.engine.subscribe(owner, { ...p, ttlMs });
    if (this.closed || this.now() >= this.expiresAt) {
      await this.engine.unsubscribe(owner, result.id);
      throw new EventError("runtime_unavailable");
    }
    if (this.singleSubscription) this.trialIdentity = trialIdentity;
    if (this.deferMonitoring && !this.activating) {
      this.deferred = { owner, params: structuredClone(p), result };
      this.diagnostic?.("notification_approval_waiting");
      return result;
    }
    const key = this.identity(owner, p);
    const previous = this.streams.get(key);
    if (previous) {
      await previous.stop();
      this.streams.delete(key);
    }
    let adapter: OrcaNotificationAdapter | undefined;
    let active = true;
    let monitoringStarted = false;
    let monitoringStopped = false;
    const markStopped = () => {
      if (monitoringStarted && !monitoringStopped) {
        monitoringStopped = true;
        this.diagnostic?.("monitoring_stopped");
      }
    };
    let pending = 0;
    let events: Promise<unknown> = Promise.resolve();
    let retryTimer: ReturnType<typeof setInterval> | undefined;
    let grantedExpiry = result.refreshBefore;
    let stopTransport: (() => Promise<void>) | undefined;
    const streamAttempt = randomUUID();
    let readyResolve!: () => void;
    let readyReject!: (e: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    void ready.catch(() => undefined);
    const timeout = setTimeout(() => readyReject(new EventError("runtime_unavailable")), 5000);
    const stop = async () => {
      active = false;
      markStopped();
      adapter?.close();
      if (retryTimer) clearInterval(retryTimer);
      if (stopTransport) await stopTransport();
      await events;
    };
    const enqueue = (event: unknown) => {
      if (++pending > 16) {
        active = false;
        markStopped();
        adapter?.close("queue_limit");
        void stopTransport?.();
        return;
      }
      events = events
        .then(async () => {
          if (await this.engine.ingestSession(owner, result.id, target, event))
            await this.engine.deliver();
        })
        .catch(() => {
          active = false;
          markStopped();
          adapter?.close("delivery_failed");
          void stopTransport?.();
        })
        .finally(() => {
          pending--;
        });
    };
    const fail = (reason: string) => {
      if (!active) return;
      active = false;
      markStopped();
      adapter?.close(reason);
      readyReject(new EventError(reason));
      if (adapter)
        enqueue({
          eventId: digest([result.id, streamAttempt, "interruption"]),
          name: "orca.session_activity",
          timestamp: new Date(this.now()).toISOString(),
          cursor: null,
          data: {
            subscriptionId: digest(result.id),
            freshness: "receipt_only",
            kind: "monitoring_interrupted",
            reason,
          },
        });
      void stopTransport?.().catch(() => undefined);
    };
    const receive = (raw: unknown) => {
      if (!active) return;
      const frame = frameSchema.safeParse(raw);
      if (!frame.success) {
        fail("invalid_rpc_frame");
        return;
      }
      if (frame.data.type === "ready") {
        if (adapter) {
          fail("duplicate_ready");
          return;
        }
        try {
          adapter = new OrcaNotificationAdapter(frame.data.subscription, target, this.now);
          grantedExpiry = notificationAcceptedSchema
            .parse(frame.data.subscription)
            .expiresAt.toString();
          readyResolve();
        } catch {
          fail("invalid_rpc_handshake");
        }
        return;
      }
      if (frame.data.type === "end") {
        fail("disconnected");
        return;
      }
      if (!adapter) {
        fail("missing_ready");
        return;
      }
      const output = adapter.accept(frame.data.event);
      if (!output) {
        if (adapter.status().state === "interrupted")
          fail(adapter.status().reason ?? "invalid_event");
        return;
      }
      const kind =
        output.name === "orca.turn_finished"
          ? "turn_finished"
          : output.name === "orca.input_waiting"
            ? "input_required"
            : "monitoring_interrupted";
      enqueue({
        ...output,
        name: "orca.session_activity",
        data: { ...output.data, kind, freshness: "receipt_only" },
      });
      if (kind === "monitoring_interrupted") {
        active = false;
        markStopped();
        void stopTransport?.().catch(() => undefined);
      }
    };
    try {
      this.diagnostic?.("monitoring_start_attempted");
      stopTransport = await this.transport.open(
        "terminal.agentEvents.subscribe",
        { version: 2, target, ttlSeconds: Math.max(1, Math.floor(ttlMs / 1000) - 1) },
        receive,
      );
      await ready;
      if (!active || this.closed || this.now() >= this.expiresAt)
        throw new EventError("runtime_unavailable");
      monitoringStarted = true;
      this.diagnostic?.("monitoring_started");
      retryTimer = setInterval(() => {
        void this.engine
          .deliver()
          .then(async () => {
            if (!(await this.engine.hasSubscription(owner, result.id))) {
              await stop();
              this.streams.delete(key);
            }
          })
          .catch(() => fail("delivery_failed"));
      }, 1000);
      this.streams.set(key, { owner, stop, isActive: () => active });
      const response = { ...result, refreshBefore: new Date(Number(grantedExpiry)).toISOString() };
      if (this.singleSubscription) this.trialResult = response;
      return response;
    } catch (error) {
      this.diagnostic?.("monitoring_start_failed");
      await stop();
      await this.engine.unsubscribe(owner, result.id);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  activateDeferred() {
    const operation = this.queue.then(async () => {
      if (
        this.closed ||
        this.trialEnded ||
        !this.deferred ||
        this.activating ||
        this.now() >= this.expiresAt
      )
        throw new EventError("activation_rejected");
      const pending = this.deferred;
      if (!(await this.engine.hasSubscription(pending.owner, pending.result.id)))
        throw new EventError("activation_rejected");
      this.activating = true;
      try {
        return await this.run(pending.owner, "events/subscribe", pending.params);
      } catch (error) {
        await this.engine.unsubscribe(pending.owner, pending.result.id);
        throw error;
      } finally {
        this.deferred = undefined;
        this.activating = false;
      }
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  private identity(
    owner: string,
    p: { name: string; arguments: unknown; delivery: { url: string } },
  ) {
    // Same canonical identity as engine, independent of key order.
    return digest([owner, new URL(p.delivery.url).href, p.name, p.arguments]);
  }
  async close() {
    this.closed = true;
    await this.queue;
    for (const s of this.streams.values()) await s.stop();
    this.streams.clear();
    if (this.deferred) {
      await this.engine.unsubscribe(this.deferred.owner, this.deferred.result.id);
      this.deferred = undefined;
    }
  }
}
import { digest } from "./model.js";
