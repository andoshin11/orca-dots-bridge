import type { DiagnosticRecord } from "./preflight-diagnostics.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { EventEngine, subscribeSchema, unsubscribeSchema } from "./engine.js";
import { digest } from "./model.js";
import {
  isPaneEventName,
  paneTargetSchema,
  samePaneTarget,
  type PaneEventName,
  type PaneDescriber,
  type PaneTarget,
  type RelayStatus,
} from "./pane-contract.js";
import { EventError } from "./webhook.js";

/** Fan-out from the relay listener to whichever pane stream is watching. */
export function createRelayHub() {
  const listeners = new Map<string, Set<(status: RelayStatus) => void>>();
  // Arrow properties so callers can pass `hub.watch` / `hub.publish` detached.
  return {
    publish: (status: RelayStatus) => {
      for (const listener of listeners.get(status.paneKey) ?? []) listener(status);
    },
    watch: (paneKey: string, listener: (status: RelayStatus) => void) => {
      const set = listeners.get(paneKey) ?? new Set();
      set.add(listener);
      listeners.set(paneKey, set);
      return () => {
        set.delete(listener);
        // Only drop the entry this watcher created; a later watch may own a new set.
        if (set.size === 0 && listeners.get(paneKey) === set) listeners.delete(paneKey);
      };
    },
  };
}
export type PaneEventSource = {
  watch: ReturnType<typeof createRelayHub>["watch"];
  describe: PaneDescriber;
};

export const paneCatalog = [
  {
    name: "orca.pane_activity",
    description:
      "Observe one Orca pane's turn end (success unconfirmed), input wait, or monitoring interruption, as reported by the orca-agent-status-relay plugin. Pane-scoped only: a new agent session inside the same pane is not distinguished, and missed or dropped events are not detected. Report a received observation, never assert a newly ended turn.",
    delivery: ["webhook"],
    inputSchema: {
      type: "object",
      properties: {
        executionHostId: { const: "local" },
        worktreeId: { type: "string", minLength: 1, maxLength: 4096 },
        terminalHandle: { type: "string", minLength: 1, maxLength: 4096 },
        paneKey: { type: "string", minLength: 1, maxLength: 4096 },
        incarnationId: { type: "string", minLength: 1, maxLength: 4096 },
      },
      required: ["executionHostId", "worktreeId", "terminalHandle", "paneKey", "incarnationId"],
      additionalProperties: false,
    },
    payloadSchema: {
      type: "object",
      properties: {
        subscriptionId: { type: "string" },
        freshness: { const: "receipt_only" },
        assurance: { const: "pane_only" },
        kind: { enum: ["turn_finished", "input_required", "monitoring_interrupted"] },
        outcome: { const: "unconfirmed" },
        reason: { type: "string" },
      },
      required: ["subscriptionId", "kind", "freshness", "assurance"],
      additionalProperties: false,
    },
  },
];

/**
 * Serves events/list, events/subscribe and events/unsubscribe for pane targets.
 * Events come from relay messages, and every event re-reads the pane identity
 * through the Orca CLI before it is queued.
 */
export class PaneEventsRpc {
  private streams = new Map<string, { owner: string; stop: () => Promise<void> }>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(
    private engine: EventEngine,
    private source: PaneEventSource,
    private now = Date.now,
    private maxTtlMs = 3600000,
    private diagnostic?: DiagnosticRecord,
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
      return { events: structuredClone(paneCatalog) };
    }
    if (method === "events/unsubscribe") {
      const p = unsubscribeSchema.parse(params);
      paneTargetSchema.parse(p.arguments);
      await this.engine.unsubscribeMatching(owner, p);
      const key = this.identity(owner, p);
      const stream = this.streams.get(key);
      if (stream?.owner === owner) {
        await stream.stop();
        this.streams.delete(key);
      }
      return {};
    }
    if (method !== "events/subscribe") throw new EventError("method_not_found");
    const p = subscribeSchema.parse(params);
    if (!isPaneEventName(p.name)) throw new EventError("invalid_params");
    const target = paneTargetSchema.parse(p.arguments);
    const ttlMs = Math.min(p.ttlMs ?? this.maxTtlMs, this.maxTtlMs);
    if (ttlMs < 2000) throw new EventError("invalid_params");
    const result = await this.engine.subscribe(owner, { ...p, ttlMs });
    if (this.closed) {
      await this.engine.unsubscribe(owner, result.id);
      throw new EventError("runtime_unavailable");
    }
    const key = this.identity(owner, p);
    const previous = this.streams.get(key);
    if (previous) {
      await previous.stop();
      this.streams.delete(key);
    }
    try {
      this.diagnostic?.("monitoring_start_attempted");
      const stream = await this.startStream(owner, result.id, target, p.name);
      if (this.closed) {
        await stream.stop();
        throw new EventError("runtime_unavailable");
      }
      this.diagnostic?.("monitoring_started");
      this.streams.set(key, stream);
      return { ...result };
    } catch (error) {
      this.diagnostic?.("monitoring_start_failed");
      await this.engine.unsubscribe(owner, result.id);
      throw error;
    }
  }
  private async startStream(
    owner: string,
    subscriptionId: string,
    target: PaneTarget,
    name: PaneEventName,
  ) {
    // The pane must still be the one the caller approved before any event is accepted.
    let current: PaneTarget;
    try {
      current = await this.source.describe(target.terminalHandle);
    } catch {
      throw new EventError("runtime_unavailable");
    }
    if (!samePaneTarget(current, target)) {
      this.diagnostic?.("runtime_target_changed");
      throw new EventError("runtime_target_changed");
    }
    let active = true;
    let stopped = false;
    let pending = 0;
    let events: Promise<unknown> = Promise.resolve();
    const streamAttempt = randomUUID();
    const markStopped = () => {
      if (!stopped) {
        stopped = true;
        this.diagnostic?.("monitoring_stopped");
      }
    };
    // `reserved` is for the interruption notice: it always gets a slot, so a
    // stream that stops for its own reasons (backlog, failed ingest) is never silent.
    const enqueue = (work: () => Promise<unknown>, reserved = false) => {
      if (!reserved && pending >= 16) {
        fail("queue_limit");
        return;
      }
      pending++;
      events = events
        .then(work)
        .catch(() => fail("ingest_failed"))
        .finally(() => {
          pending--;
        });
    };
    const ingest = async (event: unknown) => {
      if (await this.engine.ingestSession(owner, subscriptionId, target, event))
        await this.engine.deliver();
    };
    const activity = (
      eventId: string,
      timestamp: number,
      data:
        | { kind: "turn_finished"; outcome: "unconfirmed" }
        | { kind: "input_required" }
        | { kind: "monitoring_interrupted"; reason: string },
    ) => ({
      eventId,
      name,
      timestamp: new Date(timestamp).toISOString(),
      cursor: null,
      data: {
        subscriptionId: digest(subscriptionId),
        freshness: "receipt_only",
        assurance: "pane_only",
        ...data,
      },
    });
    const fail = (reason: string) => {
      if (!active) return;
      active = false;
      markStopped();
      unwatch();
      enqueue(
        () =>
          ingest(
            activity(digest([subscriptionId, streamAttempt, "interruption"]), this.now(), {
              kind: "monitoring_interrupted",
              reason,
            }),
          ),
        true,
      );
    };
    const onStatus = (status: RelayStatus) => {
      if (!active) return;
      if (status.worktreeId !== null && status.worktreeId !== target.worktreeId) {
        fail("identity_changed");
        return;
      }
      const data =
        status.kind === "done"
          ? ({ kind: "turn_finished", outcome: "unconfirmed" } as const)
          : status.kind === "waiting" || status.kind === "blocked"
            ? ({ kind: "input_required" } as const)
            : undefined;
      // A single-kind subscription only hears its own kind.
      if (!data || (name !== "orca.pane_activity" && name !== `orca.pane_${data.kind}`)) return;
      const eventId = digest([
        subscriptionId,
        status.paneKey,
        status.kind,
        status.mainAgent?.stateStartedAt ?? status.receivedAt,
      ]);
      enqueue(async () => {
        if (!active) return;
        let now: PaneTarget;
        try {
          now = await this.source.describe(target.terminalHandle);
        } catch {
          fail("target_unavailable");
          return;
        }
        // Monitoring may have stopped while the Orca CLI was answering.
        if (!active) return;
        if (!samePaneTarget(now, target)) {
          fail("identity_changed");
          return;
        }
        this.diagnostic?.("pane_status_queued");
        await ingest(activity(eventId, status.receivedAt, data));
      });
    };
    const unwatch = this.source.watch(target.paneKey, onStatus);
    const retryTimer = setInterval(() => {
      void this.engine
        .deliver()
        .then(async () => {
          if (!(await this.engine.hasSubscription(owner, subscriptionId))) await stop();
        })
        .catch(() => fail("delivery_failed"));
    }, 1000);
    const stop = async () => {
      active = false;
      markStopped();
      unwatch();
      clearInterval(retryTimer);
      await events;
    };
    return { owner, stop };
  }
  /**
   * Re-attaches monitoring for subscriptions persisted by a previous process; safe to
   * call repeatedly. A pane that now holds something else loses its subscription (the
   * subscriber's next refresh then fails and it can subscribe again); one that cannot be
   * read right now is retried on the next call.
   */
  resume() {
    const operation = this.queue.then(async () => {
      let resumed = 0;
      for (const s of await this.engine.listSubscriptions()) {
        if (this.closed) break;
        const target = paneTargetSchema.safeParse(s.target);
        if (!isPaneEventName(s.name) || !target.success) continue;
        const key = this.identity(s.owner, {
          name: s.name,
          arguments: s.target,
          delivery: { url: s.url },
        });
        if (this.streams.has(key)) continue;
        try {
          this.streams.set(key, await this.startStream(s.owner, s.id, target.data, s.name));
          resumed++;
        } catch (error) {
          // A pane that now holds something else is gone for good. If Orca is just
          // not reachable yet (e.g. right after login), keep it for the next attempt.
          if (error instanceof EventError && error.code === "runtime_target_changed")
            await this.engine.unsubscribe(s.owner, s.id);
        }
      }
      return resumed;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  /** Stops all monitoring and removes every subscription (notifications turned off). */
  dropAll() {
    const operation = this.queue.then(async () => {
      for (const s of this.streams.values()) await s.stop();
      this.streams.clear();
      const subscriptions = await this.engine.listSubscriptions();
      for (const s of subscriptions) await this.engine.unsubscribe(s.owner, s.id);
      return subscriptions.length;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  private identity(
    owner: string,
    p: { name: string; arguments: unknown; delivery: { url: string } },
  ) {
    return digest([owner, new URL(p.delivery.url).href, p.name, p.arguments]);
  }
  async close() {
    this.closed = true;
    await this.queue;
    for (const s of this.streams.values()) await s.stop();
    this.streams.clear();
  }
}
