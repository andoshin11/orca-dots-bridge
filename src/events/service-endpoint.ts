import { EventError } from "./webhook.js";
import type { DiagnosticRecord } from "./preflight-diagnostics.js";
import { EventEngine, type EngineOptions } from "./engine.js";
import { createServiceKeyResolver } from "./service-key.js";
import { createSessionMcpHttpEntry } from "./http-entry.js";
import { SessionEventsRpc, type OrcaEventTransport } from "./session-rpc.js";
import { notificationTargetSchema, sameNotificationTarget } from "./orca-contract.js";
import { PaneEventsRpc, type PaneEventSource } from "./pane-rpc.js";
import { paneTargetSchema, samePaneTarget } from "./pane-contract.js";

type MonitorRpc = {
  dispatch(owner: string, method: string, params: unknown): Promise<Record<string, unknown>>;
  activateDeferred(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
};
/** What the endpoint monitors: the target shape and the event source behind it. */
export type NotificationMonitor = {
  eventName: "orca.session_activity" | "orca.pane_activity";
  /** Throws when the value is not this monitor's target shape. */
  parseTarget(value: unknown): unknown;
  sameTarget(a: unknown, b: unknown): boolean;
  /** Reads the target's current identity from its source of truth. */
  describe(terminalHandle: string): Promise<unknown>;
  createRpc(
    engine: EventEngine,
    now: () => number,
    maxTtlMs: number,
    expiresAt: number,
    diagnostic: DiagnosticRecord | undefined,
    deferMonitoring: boolean | undefined,
  ): MonitorRpc;
};
/** Session monitoring over the instrumented Orca runtime RPC (strict identity). */
export function sessionMonitor(
  transport: OrcaEventTransport & { describe?: (handle: string) => Promise<unknown> },
): NotificationMonitor {
  return {
    eventName: "orca.session_activity",
    parseTarget: (value) => notificationTargetSchema.parse(value),
    sameTarget: (a, b) =>
      sameNotificationTarget(notificationTargetSchema.parse(a), notificationTargetSchema.parse(b)),
    describe: async (handle) => {
      if (!transport.describe) throw new EventError("runtime_unavailable");
      return transport.describe(handle);
    },
    createRpc: (engine, now, maxTtlMs, expiresAt, diagnostic, deferMonitoring) =>
      new SessionEventsRpc(
        engine,
        transport,
        now,
        maxTtlMs,
        expiresAt,
        true,
        diagnostic,
        deferMonitoring,
      ),
  };
}
/** Pane monitoring over orca-agent-status-relay messages (pane-scoped identity only). */
export function paneMonitor(source: PaneEventSource): NotificationMonitor {
  return {
    eventName: "orca.pane_activity",
    parseTarget: (value) => paneTargetSchema.parse(value),
    sameTarget: (a, b) => samePaneTarget(paneTargetSchema.parse(a), paneTargetSchema.parse(b)),
    describe: (handle) => source.describe(handle),
    createRpc: (engine, now, maxTtlMs, expiresAt, diagnostic, deferMonitoring) =>
      new PaneEventsRpc(
        engine,
        source,
        now,
        maxTtlMs,
        expiresAt,
        true,
        diagnostic,
        deferMonitoring,
      ),
  };
}
/** A single target and finite lifetime are server policy, not caller claims. */
export async function createServiceNotificationEndpoint(options: {
  target: unknown;
  keyId: string;
  serviceKey: Buffer;
  expiresAt: number;
  engine: Omit<EngineOptions, "authorize">;
  /** Session monitoring over the runtime RPC; ignored when `monitor` is given. */
  transport?: OrcaEventTransport;
  monitor?: NotificationMonitor;
  diagnostic?: DiagnosticRecord;
  deferMonitoring?: boolean;
  onVerified?: (owner: string, params: unknown) => void;
  beforeSubscribe?: (owner: string, params: unknown, signal?: AbortSignal) => void | Promise<void>;
}) {
  if (!options.monitor && !options.transport) throw new Error("monitor_required");
  const monitor = options.monitor ?? sessionMonitor(options.transport!);
  const target = monitor.parseTarget(options.target);
  const now = options.engine.now ?? Date.now;
  const remaining = options.expiresAt - now();
  if (remaining < 2000 || remaining > 600000) throw new Error("invalid_trial_lifetime");
  const auth = createServiceKeyResolver({
    keyId: options.keyId,
    secret: options.serviceKey,
    expiresAt: options.expiresAt,
    now,
  });
  const lifetime = new AbortController();
  const expiryTimer = setTimeout(() => lifetime.abort(), remaining);
  expiryTimer.unref();
  const assertActive = () => {
    if (lifetime.signal.aborted || now() >= options.expiresAt)
      throw new EventError("request_cancelled");
  };
  const engine = await EventEngine.open({
    ...options.engine,
    expiresAt: options.expiresAt,
    post: async (url, headers, body) => {
      assertActive();
      const reply = await options.engine.post(url, headers, body, lifetime.signal);
      assertActive();
      return reply;
    },
    authorize: async (owner, value) => {
      let matches = false;
      try {
        matches = monitor.sameTarget(target, value);
      } catch {
        matches = false;
      }
      return (
        !lifetime.signal.aborted && now() < options.expiresAt && owner === auth.owner && matches
      );
    },
  }).catch((error: unknown) => {
    clearTimeout(expiryTimer);
    lifetime.abort();
    auth.revoke();
    throw error;
  });
  const rpc = monitor.createRpc(
    engine,
    now,
    remaining,
    options.expiresAt,
    options.diagnostic,
    options.deferMonitoring,
  );
  const cancel = () => lifetime.abort();
  const requests = new Set<AbortSignal>();
  lifetime.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(expiryTimer);
      auth.revoke();
      for (const signal of requests) signal.removeEventListener("abort", cancel);
      requests.clear();
      void rpc.close().catch(() => undefined);
    },
    { once: true },
  );
  return {
    fetch: createSessionMcpHttpEntry(
      {
        dispatch: async (owner, method, params, signal, operationSignal) => {
          try {
            if (method === "events/subscribe") {
              assertActive();
              if (signal?.aborted || operationSignal?.aborted) {
                cancel();
                assertActive();
              }
              if (signal) {
                requests.add(signal);
                signal.addEventListener("abort", cancel, { once: true });
              }
              operationSignal?.addEventListener("abort", cancel, { once: true });
              await options.beforeSubscribe?.(owner, params, lifetime.signal);
              assertActive();
            }
            const result = await rpc.dispatch(owner, method, params);
            if (method === "events/subscribe") {
              assertActive();
              options.diagnostic?.("subscription_request_succeeded");
              options.onVerified?.(owner, params);
            }
            return result;
          } catch (error) {
            if (method === "events/subscribe")
              options.diagnostic?.("subscription_request_rejected");
            throw error;
          } finally {
            // The SDK also aborts handler context during normal response teardown.
            // Only a pending subscribe belongs to that context; an established
            // webhook subscription must outlive its successful HTTP exchange.
            operationSignal?.removeEventListener("abort", cancel);
          }
        },
      },
      auth.resolve,
      options.diagnostic,
    ),
    activate: async () => {
      if (!options.deferMonitoring) throw new EventError("activation_rejected");
      assertActive();
      const result = await rpc.activateDeferred();
      assertActive();
      return result;
    },
    close: async () => {
      cancel();
      auth.revoke();
      await rpc.close();
    },
  };
}
