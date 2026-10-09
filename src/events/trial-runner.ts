import {
  createTwoPhaseEndpoint,
  verificationScopeSchema,
  validateVerificationScope,
} from "./two-phase-endpoint.js";
import { createPreflightDiagnostics } from "./preflight-diagnostics.js";
import { createLoopbackServer } from "./loopback-server.js";
import { callbackApprovalSchema, assertCallbackApproval } from "./callback-preflight.js";
import { openAtomicStore } from "./file-store.js";
import { createMacKeychain } from "./keychain.js";
import {
  createServiceNotificationEndpoint,
  paneMonitor,
  sessionMonitor,
} from "./service-endpoint.js";
import { createRuntimeEventTransport } from "./runtime-transport.js";
import { createRelayIngress, createRelayServer } from "./relay-ingress.js";
import { createRelayHub } from "./pane-rpc.js";
import { createPaneDescriber, paneTargetSchema } from "./pane-contract.js";
import { createRunner } from "../adapter.js";
import { limitTrialVerification } from "./trial-verification-budget.js";
import { createPost } from "./webhook.js";
import { notificationTargetSchema, sameNotificationTarget } from "./orca-contract.js";
import { z } from "zod";
export const trialConfigSchema = z
  .object({
    directory: z.string().min(1),
    diagnosticsPath: z.string().min(1).optional(),
    target: notificationTargetSchema,
    runtime: z.object({ endpoint: z.string().min(1), runtimeId: z.string().min(1) }).strict(),
    callbackApproval: callbackApprovalSchema,
    port: z.number().int().min(1024).max(65535).default(8787),
  })
  .strict();
export const twoPhaseTrialConfigSchema = trialConfigSchema
  .omit({ callbackApproval: true })
  .extend({ verificationScope: verificationScopeSchema });
/** Pane monitoring fed by orca-agent-status-relay; needs no instrumented runtime or token. */
export const relayTwoPhaseTrialConfigSchema = z
  .object({
    source: z.literal("relay"),
    directory: z.string().min(1),
    diagnosticsPath: z.string().min(1).optional(),
    target: paneTargetSchema,
    relayPort: z.number().int().min(1024).max(65535),
    port: z.number().int().min(1024).max(65535).default(8787),
    verificationScope: verificationScopeSchema,
  })
  .strict()
  .refine((c) => c.relayPort !== c.port, { message: "relay_port_conflict" });
export function startTwoPhaseTrial(
  raw: unknown,
  runtimeToken: string,
  review: (url: string) => void,
) {
  return startTrial(raw, runtimeToken, review);
}
/** Explicit invocation only. Caller obtains consent for real key reads, listener and callback traffic. */
export function startNotificationTrial(raw: unknown, runtimeToken: string) {
  return startTrial(raw, runtimeToken);
}
function isRelayConfig(raw: unknown) {
  return (
    typeof raw === "object" && raw !== null && (raw as { source?: unknown }).source === "relay"
  );
}
async function startTrial(raw: unknown, runtimeToken: string, review?: (url: string) => void) {
  const relay = review !== undefined && isRelayConfig(raw);
  const config = relay
    ? relayTwoPhaseTrialConfigSchema.parse(raw)
    : review
      ? twoPhaseTrialConfigSchema.parse(raw)
      : trialConfigSchema.parse(raw);
  const scope =
    "verificationScope" in config
      ? validateVerificationScope(
          config.verificationScope,
          config.target,
          Date.now(),
          relay ? (value) => paneTargetSchema.parse(value) : undefined,
        )
      : undefined;
  const callbackApproval = "callbackApproval" in config ? config.callbackApproval : undefined;
  const expiresAt = scope?.expiresAt ?? callbackApproval!.expiresAt;
  if (expiresAt - Date.now() < 2000) throw new Error("callback_approval_expired");
  // The relay source never talks to the runtime socket, so it must not be handed its token.
  if (relay ? runtimeToken : !runtimeToken)
    throw new Error(relay ? "runtime_token_unexpected" : "runtime_token_required");
  const diagnostic = config.diagnosticsPath
    ? createPreflightDiagnostics(config.diagnosticsPath)
    : undefined;
  const keys = createMacKeychain();
  const store = await openAtomicStore(config.directory);
  try {
    if ((await store.load()) !== null) throw new Error("trial_state_already_exists");
  } catch (error) {
    await store.close();
    throw error;
  }
  let encryptionKey: Buffer | undefined,
    serviceKey: Buffer | undefined,
    relayKey: Buffer | undefined;
  let relayServer: ReturnType<typeof createRelayServer> | undefined;
  let endpoint:
    | Awaited<ReturnType<typeof createServiceNotificationEndpoint>>
    | Awaited<ReturnType<typeof createTwoPhaseEndpoint>>
    | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined;
  let resolveFinished!: () => void;
  let rejectFinished!: (error: unknown) => void;
  const finished = new Promise<void>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });
  void finished.catch(() => undefined);
  const server = createLoopbackServer(
    config.port,
    () => (closing ? undefined : endpoint),
    diagnostic,
  );
  const close = () =>
    (closing ??= (async () => {
      if (timer) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (relayServer?.listening) {
        relayServer.closeAllConnections();
        await new Promise<void>((resolve) => relayServer!.close(() => resolve()));
      }
      try {
        await endpoint?.close();
      } finally {
        encryptionKey?.fill(0);
        serviceKey?.fill(0);
        relayKey?.fill(0);
        await store.close(true);
      }
    })().then(
      () => {
        try {
          diagnostic?.("stopped");
        } catch (error) {
          rejectFinished(error);
          throw error;
        }
        resolveFinished();
      },
      (error: unknown) => {
        try {
          diagnostic?.("cleanup_failed");
        } catch {
          /* Never expose diagnostic errors. */
        }
        rejectFinished(error);
        throw error;
      },
    ));
  try {
    encryptionKey = await keys.read("outbox-v1");
    serviceKey = await keys.read("service-v1");
    let monitor;
    let transport: ReturnType<typeof createRuntimeEventTransport> | undefined;
    if ("source" in config) {
      relayKey = await keys.read("relay-v1");
      const hub = createRelayHub();
      relayServer = createRelayServer(
        config.relayPort,
        createRelayIngress({
          key: relayKey,
          onStatus: (status) => hub.publish(status),
          diagnostic,
        }),
        diagnostic,
      );
      const listening = relayServer;
      await new Promise<void>((resolve, reject) => {
        listening.once("error", reject);
        listening.listen(config.relayPort, "127.0.0.1", () => {
          listening.off("error", reject);
          resolve();
        });
      });
      monitor = paneMonitor({
        watch: (paneKey, listener) => hub.watch(paneKey, listener),
        describe: createPaneDescriber(createRunner()),
      });
    } else {
      transport = createRuntimeEventTransport({ ...config.runtime, authToken: runtimeToken });
      monitor = sessionMonitor(transport);
    }
    endpoint = scope
      ? await createTwoPhaseEndpoint({
          scope,
          target: config.target,
          serviceKey,
          diagnostic,
          monitor,
          review: review!,
          engine: { diagnostic, key: encryptionKey, store, post: createPost([scope.host]) },
        })
      : await createServiceNotificationEndpoint({
          target: config.target,
          keyId: "trial-service-v1",
          serviceKey,
          expiresAt,
          diagnostic,
          beforeSubscribe: async (owner, params) => {
            assertCallbackApproval(callbackApproval!, owner, params, Date.now(), diagnostic);
            if (
              !transport ||
              !("runtime" in config) ||
              !sameNotificationTarget(
                await transport.describe(config.target.terminalHandle),
                notificationTargetSchema.parse(config.target),
              )
            ) {
              diagnostic?.("runtime_target_changed");
              throw new Error("runtime_target_changed");
            }
            assertCallbackApproval(callbackApproval!, owner, params, Date.now(), diagnostic);
          },
          engine: {
            diagnostic,
            key: encryptionKey,
            store,
            allowedCallbackHosts: [callbackApproval!.host],
            post: limitTrialVerification(
              createPost([callbackApproval!.host]),
              expiresAt,
              Date.now,
              diagnostic,
            ),
          },
          transport: transport!,
        });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    diagnostic?.("running");
    timer = setTimeout(
      () => {
        void close().catch(() => undefined);
      },
      Math.max(0, expiresAt - Date.now()),
    );
    return {
      close,
      finished,
      activate: async (input: unknown) => {
        if (!scope || closing || !endpoint) throw new Error("activation_rejected");
        try {
          return await (endpoint as Awaited<ReturnType<typeof createTwoPhaseEndpoint>>).activate(
            input,
          );
        } catch {
          await close();
          throw new Error("activation_rejected");
        }
      },
      deleteTrialKeys: async () => {
        await close();
        await keys.remove("service-v1");
        await keys.remove("outbox-v1");
      },
    };
  } catch {
    await close();
    throw new Error("trial_start_failed");
  }
}
