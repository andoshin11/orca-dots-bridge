import type { DiagnosticRecord } from "./preflight-diagnostics.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { EventEngine, subscribeSchema, unsubscribeSchema } from "./engine.js";
import { digest } from "./model.js";
import {
  isPaneEventName,
  paneTargetSchema,
  samePaneTarget,
  scopeTargetSchema,
  type PaneEventName,
  type PaneDescriber,
  type PaneInfo,
  type PaneTarget,
  type RelayStatus,
  type ScopeTarget,
} from "./pane-contract.js";
import { EventError } from "./webhook.js";
import { clip } from "../normalize.js";

/** Fan-out from the relay listener to whichever pane stream is watching. */
export function createRelayHub() {
  const listeners = new Map<string, Set<(status: RelayStatus) => void>>();
  const everyPane = new Set<(status: RelayStatus) => void>();
  // Arrow properties so callers can pass `hub.watch` / `hub.publish` detached.
  return {
    publish: (status: RelayStatus) => {
      for (const listener of listeners.get(status.paneKey) ?? []) listener(status);
      for (const listener of everyPane) listener(status);
    },
    /** Every status of every pane (scope subscriptions decide membership themselves). */
    watchAll: (listener: (status: RelayStatus) => void) => {
      everyPane.add(listener);
      return () => {
        everyPane.delete(listener);
      };
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
  /** Both needed for scope subscriptions; without them those are refused. */
  watchAll?: ReturnType<typeof createRelayHub>["watchAll"];
  resolve?: (status: Pick<RelayStatus, "worktreeId" | "paneKey">) => Promise<PaneInfo | null>;
};
const streamTargetSchema = z.union([paneTargetSchema, scopeTargetSchema]);
type StreamTarget = PaneTarget | ScopeTarget;
type Stream = { owner: string; stop: () => Promise<void>; isActive: () => boolean };
type ActivityData =
  | { kind: "turn_finished"; outcome: "unconfirmed" }
  | { kind: "input_required" }
  | { kind: "monitoring_interrupted"; reason: string };
/** Whether a scope covers a resolved pane. */
export function scopeCovers(scope: ScopeTarget, pane: PaneInfo) {
  return scope.scope === "all"
    ? true
    : scope.scope === "worktree"
      ? pane.worktreeId === scope.worktreeId
      : pane.repo === scope.repo;
}
/** Narrower scopes deliver first when several of one subscriber cover the same pane. */
const scopeRank = { worktree: 0, repo: 1, all: 2 } as const;
/** Panes remembered per delivered scope event, for summaries after delivery. */
const paneMemoryLimit = 64;

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
  private streams = new Map<string, Stream>();
  private panes = new Map<string, PaneInfo>();
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
  /** The pane a delivered scope event came from (recent deliveries only). */
  paneOf(eventId: string): PaneInfo | undefined {
    return this.panes.get(eventId);
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
      streamTargetSchema.parse(p.arguments);
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
    const target = streamTargetSchema.parse(p.arguments);
    if ("scope" in target && !(this.source.watchAll && this.source.resolve))
      throw new EventError("invalid_params");
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
      const stream = await this.startAny(owner, result.id, target, p.name);
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
  private startAny(
    owner: string,
    subscriptionId: string,
    target: StreamTarget,
    name: PaneEventName,
  ) {
    return "scope" in target
      ? this.startScopeStream(owner, subscriptionId, target, name)
      : this.startStream(owner, subscriptionId, target, name);
  }
  /**
   * The bounded event pump shared by pane and scope streams: a serial queue of at most
   * `limit` items, delivery retries every second, and a monitoring_interrupted notice
   * (always given a slot) when the stream stops for its own reasons.
   */
  private pump(
    owner: string,
    subscriptionId: string,
    target: StreamTarget,
    name: PaneEventName,
    limit: number,
  ) {
    let active = true;
    let stopped = false;
    let pending = 0;
    let events: Promise<unknown> = Promise.resolve();
    let unwatch = () => {};
    const streamAttempt = randomUUID();
    const markStopped = () => {
      if (!stopped) {
        stopped = true;
        this.diagnostic?.("monitoring_stopped");
      }
    };
    const enqueue = (work: () => Promise<unknown>, reserved = false) => {
      if (!reserved && pending >= limit) {
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
      data: ActivityData,
      pane?: Record<string, string>,
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
        ...(pane ? { pane } : {}),
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
    return {
      active: () => active,
      enqueue,
      ingest,
      activity,
      fail,
      /** Attaches the relay listener; call once. */
      watch: (detach: () => void) => {
        unwatch = detach;
      },
      stream: { owner, stop, isActive: () => active } satisfies Stream,
    };
  }
  /** The event for a relay status, or undefined when this event name does not carry it. */
  private dataFor(status: RelayStatus, name: PaneEventName): ActivityData | undefined {
    const data =
      status.kind === "done"
        ? ({ kind: "turn_finished", outcome: "unconfirmed" } as const)
        : status.kind === "waiting" || status.kind === "blocked"
          ? ({ kind: "input_required" } as const)
          : undefined;
    // A single-kind subscription only hears its own kind.
    if (!data || (name !== "orca.pane_activity" && name !== `orca.pane_${data.kind}`)) return;
    return data;
  }
  private async startStream(
    owner: string,
    subscriptionId: string,
    target: PaneTarget,
    name: PaneEventName,
  ): Promise<Stream> {
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
    const pump = this.pump(owner, subscriptionId, target, name, 16);
    const onStatus = (status: RelayStatus) => {
      if (!pump.active()) return;
      if (status.worktreeId !== null && status.worktreeId !== target.worktreeId) {
        pump.fail("identity_changed");
        return;
      }
      const data = this.dataFor(status, name);
      if (!data) return;
      const eventId = digest([
        subscriptionId,
        status.paneKey,
        status.kind,
        status.mainAgent?.stateStartedAt ?? status.receivedAt,
      ]);
      pump.enqueue(async () => {
        if (!pump.active()) return;
        let now: PaneTarget;
        try {
          now = await this.source.describe(target.terminalHandle);
        } catch {
          pump.fail("target_unavailable");
          return;
        }
        // Monitoring may have stopped while the Orca CLI was answering.
        if (!pump.active()) return;
        if (!samePaneTarget(now, target)) {
          pump.fail("identity_changed");
          return;
        }
        this.diagnostic?.("pane_status_queued");
        await pump.ingest(pump.activity(eventId, status.receivedAt, data));
      });
    };
    pump.watch(this.source.watch(target.paneKey, onStatus));
    return pump.stream;
  }
  /**
   * Monitoring for every pane a scope covers, including panes created later: each relay
   * status is resolved to its worktree, repo and terminal through a short-lived cached
   * inventory (never on the relay's request path) and checked against the scope then.
   */
  private async startScopeStream(
    owner: string,
    subscriptionId: string,
    scope: ScopeTarget,
    name: PaneEventName,
  ): Promise<Stream> {
    const { watchAll, resolve } = this.source;
    if (!watchAll || !resolve) throw new EventError("runtime_unavailable");
    const pump = this.pump(owner, subscriptionId, scope, name, 32);
    const onStatus = (status: RelayStatus) => {
      if (!pump.active()) return;
      const data = this.dataFor(status, name);
      if (!data) return;
      // Cheap check first: a worktree scope never needs the inventory for other worktrees.
      if (
        scope.scope === "worktree" &&
        status.worktreeId !== null &&
        status.worktreeId !== scope.worktreeId
      )
        return;
      const eventId = digest([
        subscriptionId,
        status.paneKey,
        status.kind,
        status.mainAgent?.stateStartedAt ?? status.receivedAt,
      ]);
      pump.enqueue(async () => {
        if (!pump.active()) return;
        let pane = await resolve(status).catch(() => null);
        if (!pump.active()) return;
        // Without the inventory, the relay's own worktree id still places the pane
        // for the scopes that do not need a repo name.
        if (!pane && status.worktreeId !== null && scope.scope !== "repo")
          pane = {
            paneKey: status.paneKey,
            worktreeId: status.worktreeId,
            repo: null,
            workspace: null,
            terminalHandle: null,
          };
        if (!pane) {
          this.diagnostic?.("scope_status_unresolved");
          return;
        }
        if (!scopeCovers(scope, pane)) return;
        if (!(await this.deliversFor(owner, subscriptionId, pane))) return;
        this.panes.set(eventId, pane);
        for (const key of this.panes.keys()) {
          if (this.panes.size <= paneMemoryLimit) break;
          this.panes.delete(key);
        }
        this.diagnostic?.("scope_status_queued");
        await pump.ingest(
          pump.activity(eventId, status.receivedAt, data, {
            worktreeId: pane.worktreeId,
            ...(pane.terminalHandle !== null ? { terminalHandle: pane.terminalHandle } : {}),
            ...(pane.repo ? { repo: clip(pane.repo, 200)! } : {}),
            ...(pane.workspace ? { workspace: clip(pane.workspace, 200)! } : {}),
          }),
        );
      });
    };
    pump.watch(watchAll(onStatus));
    return pump.stream;
  }
  /**
   * One delivery per pane event for one subscriber (owner, callback URL and event name):
   * an active pane subscription to that pane delivers it itself; otherwise the narrowest
   * active scope subscription covering it does (worktree, then repo, then all).
   */
  private async deliversFor(owner: string, subscriptionId: string, pane: PaneInfo) {
    const all = await this.engine.listSubscriptions();
    const self = all.find((s) => s.id === subscriptionId && s.owner === owner);
    if (!self) return false;
    const peers = all.filter(
      (s) =>
        s.id !== self.id &&
        s.owner === owner &&
        s.url === self.url &&
        s.name === self.name &&
        this.streams
          .get(
            this.identity(s.owner, { name: s.name, arguments: s.target, delivery: { url: s.url } }),
          )
          ?.isActive() === true,
    );
    for (const s of peers) {
      const t = paneTargetSchema.safeParse(s.target);
      if (t.success && t.data.paneKey === pane.paneKey && t.data.worktreeId === pane.worktreeId)
        return false;
    }
    const covering = [self, ...peers]
      .flatMap((s) => {
        const t = scopeTargetSchema.safeParse(s.target);
        return t.success && scopeCovers(t.data, pane)
          ? [{ id: s.id, rank: scopeRank[t.data.scope] }]
          : [];
      })
      .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
    return covering[0]?.id === subscriptionId;
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
        const target = streamTargetSchema.safeParse(s.target);
        if (!isPaneEventName(s.name) || !target.success) continue;
        const key = this.identity(s.owner, {
          name: s.name,
          arguments: s.target,
          delivery: { url: s.url },
        });
        if (this.streams.has(key)) continue;
        try {
          this.streams.set(key, await this.startAny(s.owner, s.id, target.data, s.name));
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
