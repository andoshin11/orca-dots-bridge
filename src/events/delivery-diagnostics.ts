import { EventError } from "./webhook.js";
import type { DiagnosticRecord, DiagnosticStage } from "./preflight-diagnostics.js";
const stages: Record<string, DiagnosticStage> = {
  dns_not_found: "callback_dns_not_found",
  request_invalid: "callback_request_invalid",
  dns_temporary: "callback_dns_temporary",
  dns_other: "callback_dns_other",
  dns_empty: "callback_dns_empty",
  address_rejected: "callback_address_rejected",
  tls_hostname: "callback_tls_hostname",
  tls_validity: "callback_tls_validity",
  tls_trust: "callback_tls_trust",
  tls_protocol: "callback_tls_protocol",
  timeout: "callback_timeout",
  cancelled: "callback_cancelled",
  socket_refused: "callback_socket_refused",
  socket_permission: "callback_socket_permission",
  socket_reset: "callback_socket_reset",
  socket_unreachable: "callback_socket_unreachable",
  http_parse: "callback_http_parse",
  response_truncated: "callback_response_truncated",
  response_limit: "callback_response_limit",
};
export function deliveryFailureStage(error: unknown): DiagnosticStage {
  let stage: DiagnosticStage = "callback_unknown_failure";
  if (error instanceof EventError) {
    const reason =
      error.reason ??
      (
        {
          delivery_cancelled: "cancelled",
          response_limit: "response_limit",
          dns_failed: "dns_other",
        } as Record<string, string>
      )[error.code];
    if (reason && Object.hasOwn(stages, reason)) stage = stages[reason]!;
    else if (error.code === "redirect_rejected") stage = "callback_redirect_rejected";
    else if (error.code === "callback_rejected") stage = "callback_address_rejected";
    else if (error.code === "callback_approval_required") stage = "callback_policy_blocked";
    else if (error.code === "payload_limit") stage = "callback_payload_limit";
  }
  return stage;
}
export function recordDeliveryFailure(error: unknown, record?: DiagnosticRecord) {
  record?.(deliveryFailureStage(error));
}
