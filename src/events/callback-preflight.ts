import { z } from "zod";
import { subscribeSchema } from "./engine.js";
import { digest } from "./model.js";
import { notificationTargetSchema, sameNotificationTarget } from "./orca-contract.js";
import { callbackUrl, signingKey, EventError } from "./webhook.js";
import { createServiceKeyResolver } from "./service-key.js";
import { createSessionMcpHttpEntry } from "./http-entry.js";
import { sessionCatalog } from "./session-rpc.js";
import type { DiagnosticRecord, DiagnosticStage } from "./preflight-diagnostics.js";

export const callbackApprovalSchema = z
  .object({
    host: z.string().min(1).max(253),
    urlHash: z.string().regex(/^[a-f0-9]{64}$/),
    owner: z.literal("service:trial-service-v1"),
    targetHash: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type CallbackApproval = z.infer<typeof callbackApprovalSchema>;

function checked<T>(
  diagnostic: DiagnosticRecord | undefined,
  stage: DiagnosticStage,
  action: () => T,
): T {
  try {
    return action();
  } catch (error) {
    diagnostic?.(stage);
    throw error;
  }
}
function inspect(owner: string, params: unknown, diagnostic?: DiagnosticRecord) {
  const parsed = subscribeSchema.safeParse(params);
  if (!parsed.success) {
    diagnostic?.("subscribe_schema_rejected");
    const fields: Record<string, DiagnosticStage> = {
      name: "schema_name",
      arguments: "schema_arguments",
      delivery: "schema_delivery",
      ttlMs: "schema_ttl",
      cursor: "schema_cursor",
    };
    const categories = new Set<DiagnosticStage>();
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      categories.add(
        issue.code === "unrecognized_keys"
          ? "schema_extra"
          : typeof field === "string" && Object.hasOwn(fields, field)
            ? fields[field]!
            : "schema_other",
      );
    }
    for (const category of categories) diagnostic?.(category);
    throw parsed.error;
  }
  const p = parsed.data;
  if (p.name !== "orca.session_activity") {
    diagnostic?.("event_name_rejected");
    throw new EventError("invalid_params");
  }
  const target = checked(diagnostic, "target_schema_rejected", () =>
    notificationTargetSchema.parse(p.arguments),
  );
  checked(diagnostic, "signing_key_rejected", () => signingKey(p.delivery.secret).fill(0));
  // Syntax check only: deriving a host here NEVER authorizes DNS, challenge or delivery.
  // This module has no sender, engine instance, runtime transport or storage.
  const url = checked(diagnostic, "callback_syntax_rejected", () =>
    callbackUrl(p.delivery.url, [new URL(p.delivery.url).hostname]),
  );
  return {
    target,
    url: url.href,
    host: url.hostname,
    urlHash: digest(url.href),
    owner,
    targetHash: digest(target),
  };
}

export function assertCallbackApproval(
  raw: unknown,
  owner: string,
  params: unknown,
  now = Date.now(),
  diagnostic?: DiagnosticRecord,
) {
  const approval = checked(diagnostic, "approval_schema_rejected", () =>
    callbackApprovalSchema.parse(raw),
  );
  const candidate = inspect(owner, params, diagnostic);
  if (now >= approval.expiresAt || approval.expiresAt - now > 600000) {
    diagnostic?.("approval_expired");
    throw new EventError("callback_approval_required");
  }
  if (candidate.owner !== approval.owner) {
    diagnostic?.("approval_owner_mismatch");
    throw new EventError("callback_approval_required");
  }
  if (candidate.targetHash !== approval.targetHash) {
    diagnostic?.("approval_target_mismatch");
    throw new EventError("callback_approval_required");
  }
  if (candidate.host !== approval.host || candidate.urlHash !== approval.urlHash) {
    diagnostic?.("approval_url_mismatch");
    throw new EventError("callback_approval_required");
  }
  diagnostic?.("approval_url_match");
}

/** Denies every subscription. Review is local only; never returns a subscription ID. */
export function createCallbackPreflight(options: {
  target: unknown;
  serviceKey: Buffer;
  expiresAt: number;
  now?: () => number;
  review: (url: string, approval: CallbackApproval) => void;
  diagnostic?: DiagnosticRecord;
}) {
  const now = options.now ?? Date.now;
  if (options.expiresAt <= now() || options.expiresAt - now() > 600000)
    throw new Error("invalid_preflight_lifetime");
  const target = notificationTargetSchema.parse(options.target);
  const auth = createServiceKeyResolver({
    keyId: "trial-service-v1",
    secret: options.serviceKey,
    expiresAt: options.expiresAt,
    now,
  });
  let candidateHash: string | undefined;
  return {
    fetch: createSessionMcpHttpEntry(
      {
        dispatch: async (owner, method, params) => {
          if (method === "events/list") {
            checked(options.diagnostic, "list_schema_rejected", () =>
              z
                .object({ cursor: z.null().optional() })
                .strict()
                .parse(params ?? {}),
            );
            return { events: structuredClone(sessionCatalog) };
          }
          if (method !== "events/subscribe") {
            options.diagnostic?.("method_rejected");
            throw new EventError("invalid_params");
          }
          const candidate = inspect(owner, params, options.diagnostic);
          if (!sameNotificationTarget(target, candidate.target)) {
            options.diagnostic?.("target_mismatch");
            throw new EventError("unauthorized");
          }
          if (candidateHash && candidateHash !== candidate.urlHash) {
            options.diagnostic?.("candidate_changed");
            throw new EventError("callback_approval_required");
          }
          if (!candidateHash) {
            options.diagnostic?.("candidate_review_requested");
            candidateHash = candidate.urlHash;
            options.review(candidate.url, {
              host: candidate.host,
              urlHash: candidate.urlHash,
              owner: "service:trial-service-v1",
              targetHash: candidate.targetHash,
              expiresAt: Math.min(now() + 600000, options.expiresAt),
            });
          } else options.diagnostic?.("candidate_repeated");
          options.diagnostic?.("subscription_denied");
          throw new EventError("callback_approval_required");
        },
      },
      auth.resolve,
      options.diagnostic,
    ),
    close: () => auth.revoke(),
  };
}
