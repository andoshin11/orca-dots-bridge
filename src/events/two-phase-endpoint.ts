import { z } from "zod";
import { digest } from "./model.js";
import { subscribeSchema, type EngineOptions } from "./engine.js";
import { assertCallbackApproval, type CallbackApproval } from "./callback-preflight.js";
import { callbackUrl, EventError } from "./webhook.js";
import { notificationTargetSchema, sameNotificationTarget } from "./orca-contract.js";
import { createServiceNotificationEndpoint } from "./service-endpoint.js";
import { limitTrialVerification } from "./trial-verification-budget.js";
import type { OrcaEventTransport } from "./session-rpc.js";
import type { DiagnosticRecord } from "./preflight-diagnostics.js";

export const verificationScopeSchema = z
  .object({
    host: z
      .string()
      .min(1)
      .max(253)
      .regex(/^[a-z0-9.-]+$/),
    owner: z.literal("service:trial-service-v1"),
    targetHash: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.number().int().positive(),
    domainConfirmation: z.string(),
    confirmation: z.string(),
    accountBasis: z.enum(["independent", "bounded_protocol_test"]),
  })
  .strict()
  .superRefine((s, ctx) => {
    try {
      const u = callbackUrl(`https://${s.host}/`, [s.host]);
      if (u.hostname !== s.host) throw new Error();
    } catch {
      ctx.addIssue({ code: "custom", message: "invalid_scope" });
    }
    if (
      s.domainConfirmation !== `送信先ドメインを確認 ${s.host}` ||
      s.confirmation !== `確認通信1回のみを承認 ${s.host}`
    )
      ctx.addIssue({ code: "custom", message: "invalid_scope" });
  });
export function validateVerificationScope(raw: unknown, target: unknown, now = Date.now()) {
  const scope = verificationScopeSchema.parse(raw);
  if (
    digest(notificationTargetSchema.parse(target)) !== scope.targetHash ||
    scope.expiresAt - now < 2000 ||
    scope.expiresAt - now > 600000
  )
    throw new EventError("verification_scope_invalid");
  return scope;
}
const activationSchema = z
  .object({
    privateUrl: z.string().min(1).max(4096),
    confirmation: z.string(),
    accountBasis: z.enum(["independent", "bounded_protocol_test"]),
  })
  .strict();
/** Separate explicit verification consent and later exact-URL event consent.
 * This entry is never enabled by the legacy runner. No reusable activation grant is persisted.
 */
export async function createTwoPhaseEndpoint(options: {
  scope: unknown;
  target: unknown;
  serviceKey: Buffer;
  engine: Omit<EngineOptions, "authorize" | "allowedCallbackHosts">;
  transport: OrcaEventTransport & { describe: (handle: string) => Promise<unknown> };
  diagnostic?: DiagnosticRecord;
  review: (url: string) => void;
}) {
  const now = options.engine.now ?? Date.now;
  const target = notificationTargetSchema.parse(options.target);
  const scope = validateVerificationScope(options.scope, target, now());
  // Never resume an old verified subscription or its event outbox after process restart.
  if ((await options.engine.store.load()) !== null)
    throw new EventError("trial_state_already_exists");
  let phase: "fresh" | "verifying" | "waiting" | "activating" | "active" | "closed" = "fresh";
  let input: z.infer<typeof subscribeSchema> | undefined;
  let approval: CallbackApproval | undefined;
  const valid = () => {
    if (phase === "closed" || now() >= scope.expiresAt) throw new EventError("trial_expired");
  };
  const revalidate = async () => {
    valid();
    if (
      !sameNotificationTarget(
        target,
        notificationTargetSchema.parse(await options.transport.describe(target.terminalHandle)),
      )
    )
      throw new EventError("runtime_target_changed");
    valid();
  };
  const post = limitTrialVerification(
    options.engine.post,
    scope.expiresAt,
    now,
    options.diagnostic,
  );
  const endpoint = await createServiceNotificationEndpoint({
    target,
    keyId: "trial-service-v1",
    serviceKey: options.serviceKey,
    expiresAt: scope.expiresAt,
    diagnostic: options.diagnostic,
    deferMonitoring: true,
    transport: options.transport,
    beforeSubscribe: async (owner, raw) => {
      valid();
      if (phase !== "fresh") throw new EventError("subscription_limit");
      phase = "verifying"; // Consume even a failed first admission; no concurrent replacement.
      const parsed = subscribeSchema.parse(raw);
      if (
        owner !== scope.owner ||
        parsed.name !== "orca.session_activity" ||
        !sameNotificationTarget(target, notificationTargetSchema.parse(parsed.arguments))
      )
        throw new EventError("unauthorized");
      callbackUrl(parsed.delivery.url, [scope.host]);
      input = parsed;
      await revalidate();
      options.diagnostic?.("verification_scope_accepted");
    },
    onVerified: () => {
      valid();
      if (!input || phase !== "verifying") throw new EventError("subscription_limit");
      phase = "waiting";
      try {
        options.review(new URL(input.delivery.url).href);
      } catch {
        phase = "closed";
        void endpoint.close();
        throw new EventError("review_failed");
      }
    },
    engine: {
      ...options.engine,
      diagnostic: options.diagnostic ?? options.engine.diagnostic,
      allowedCallbackHosts: [scope.host],
      post: async (url, headers, body, signal) => {
        valid();
        if (!input || url !== new URL(input.delivery.url).href)
          throw new EventError("callback_approval_required");
        if (JSON.parse(body).type === "verification") {
          if (phase !== "verifying") throw new EventError("callback_approval_required");
        } else {
          if (phase !== "active" && phase !== "activating")
            throw new EventError("callback_approval_required");
          assertCallbackApproval(approval, scope.owner, input, now(), options.diagnostic);
        }
        return post(url, headers, body, signal);
      },
    },
  });
  return {
    fetch: endpoint.fetch,
    activate: async (raw: unknown) => {
      try {
        valid();
        if (phase !== "waiting" || !input) throw new EventError("activation_rejected");
        phase = "activating"; // Reserve synchronously before any await.
        const value = activationSchema.parse(raw);
        const url = callbackUrl(value.privateUrl, [scope.host]);
        if (value.confirmation !== `通知送信を承認 ${scope.host}`)
          throw new EventError("activation_rejected");
        approval = {
          host: scope.host,
          owner: scope.owner,
          targetHash: scope.targetHash,
          expiresAt: scope.expiresAt,
          urlHash: digest(url.href),
        };
        assertCallbackApproval(approval, scope.owner, input, now(), options.diagnostic);
        await revalidate();
        assertCallbackApproval(approval, scope.owner, input, now(), options.diagnostic);
        options.diagnostic?.("notification_approval_accepted");
        const result = await endpoint.activate();
        valid();
        phase = "active";
        options.diagnostic?.("notification_activated");
        return result;
      } catch {
        phase = "closed";
        approval = undefined;
        options.diagnostic?.("notification_activation_rejected");
        await endpoint.close();
        throw new EventError("activation_rejected");
      }
    },
    close: async () => {
      phase = "closed";
      approval = undefined;
      input = undefined;
      await endpoint.close();
    },
  };
}
