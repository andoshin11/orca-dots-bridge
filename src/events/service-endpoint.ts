import { EventError } from "./webhook.js";
import type { DiagnosticRecord } from "./preflight-diagnostics.js";
import { EventEngine, type EngineOptions } from "./engine.js";
import { createServiceKeyResolver } from "./service-key.js";
import { createSessionMcpHttpEntry } from "./http-entry.js";
import { SessionEventsRpc, type OrcaEventTransport } from "./session-rpc.js";
import { notificationTargetSchema, sameNotificationTarget } from "./orca-contract.js";
/** A single target and finite lifetime are server policy, not caller claims. */
export async function createServiceNotificationEndpoint(options: {
  target: unknown;
  keyId: string;
  serviceKey: Buffer;
  expiresAt: number;
  engine: Omit<EngineOptions, "authorize">;
  transport: OrcaEventTransport;
  diagnostic?: DiagnosticRecord;
  deferMonitoring?: boolean;
  onVerified?: (owner: string, params: unknown) => void;
  beforeSubscribe?: (owner: string, params: unknown, signal?: AbortSignal) => void | Promise<void>;
}) {
  const target = notificationTargetSchema.parse(options.target);
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
      const parsed = notificationTargetSchema.safeParse(value);
      return (
        !lifetime.signal.aborted &&
        now() < options.expiresAt &&
        owner === auth.owner &&
        parsed.success &&
        sameNotificationTarget(target, parsed.data)
      );
    },
  }).catch((error: unknown) => {
    clearTimeout(expiryTimer);
    lifetime.abort();
    auth.revoke();
    throw error;
  });
  const rpc = new SessionEventsRpc(
    engine,
    options.transport,
    now,
    remaining,
    options.expiresAt,
    true,
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
