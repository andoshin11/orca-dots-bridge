import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

// Only fixed enums and saturated counters cross this boundary; never pass request data.
export const diagnosticStages = [
  "initialized",
  "running",
  "stopped",
  "http_arrived",
  "http_boundary_rejected",
  "oauth_metadata_absent",
  "http_route_rejected",
  "http_body_limit",
  "endpoint_unavailable",
  "http_exception",
  "mcp_arrived",
  "auth_accepted",
  "auth_rejected",
  "json_invalid",
  "envelope_invalid",
  "method_discover",
  "method_tools_list",
  "method_events_list",
  "method_subscribe",
  "method_unsubscribe",
  "method_other",
  "version_current",
  "version_missing",
  "version_other",
  "protocol_without_dispatch",
  "protocol_exception",
  "response_2xx",
  "response_4xx",
  "response_5xx",
  "response_other",
  "rpc_error",
  "rpc_dispatch",
  "rpc_rejected",
  "list_schema_rejected",
  "method_rejected",
  "subscribe_schema_rejected",
  "event_name_rejected",
  "target_schema_rejected",
  "schema_name",
  "schema_arguments",
  "schema_delivery",
  "schema_ttl",
  "schema_cursor",
  "schema_extra",
  "schema_other",
  "signing_key_rejected",
  "callback_syntax_rejected",
  "target_mismatch",
  "candidate_changed",
  "candidate_review_requested",
  "candidate_repeated",
  "candidate_displayed",
  "candidate_display_failed",
  "subscription_denied",
  "approval_schema_rejected",
  "approval_expired",
  "approval_owner_mismatch",
  "approval_target_mismatch",
  "approval_url_match",
  "approval_url_mismatch",
  "runtime_target_changed",
  "challenge_attempted",
  "challenge_succeeded",
  "challenge_failed",
  "challenge_transport_failed",
  "challenge_response_rejected",
  "challenge_blocked",
  "subscription_created",
  "subscription_refreshed",
  "subscription_removed",
  "subscription_request_succeeded",
  "subscription_request_rejected",
  "monitoring_start_attempted",
  "monitoring_started",
  "monitoring_stopped",
  "monitoring_start_failed",
  "event_send_attempted",
  "event_send_succeeded",
  "event_send_failed",
  "event_send_blocked",
  "cleanup_failed",
  "verification_scope_accepted",
  "notification_approval_waiting",
  "notification_approval_accepted",
  "notification_activation_rejected",
  "notification_activated",
  "callback_dns_not_found",
  "callback_request_invalid",
  "callback_dns_temporary",
  "callback_dns_other",
  "callback_dns_empty",
  "callback_address_rejected",
  "callback_tls_hostname",
  "callback_tls_validity",
  "callback_tls_trust",
  "callback_tls_protocol",
  "callback_timeout",
  "callback_cancelled",
  "callback_socket_refused",
  "callback_socket_permission",
  "callback_socket_reset",
  "callback_socket_unreachable",
  "callback_http_parse",
  "callback_response_truncated",
  "callback_response_limit",
  "callback_unknown_failure",
  "callback_redirect_rejected",
  "callback_policy_blocked",
  "callback_payload_limit",
  "challenge_http_auth_rejected",
  "challenge_http_rate_limited",
  "challenge_http_4xx",
  "challenge_http_5xx",
  "challenge_http_other",
  "challenge_reply_late",
  "challenge_clock_invalid",
  "challenge_json_invalid",
  "challenge_echo_missing",
  "challenge_echo_mismatch",
  "relay_arrived",
  "relay_signature_rejected",
  "relay_replay_rejected",
  "relay_schema_rejected",
  "relay_test_received",
  "relay_status_received",
  "pane_status_queued",
] as const;
export type DiagnosticStage = (typeof diagnosticStages)[number];
export type DiagnosticRecord = (stage: DiagnosticStage) => void;

export function createPreflightDiagnostics(path: string): DiagnosticRecord {
  const parent = lstatSync(dirname(path));
  if (
    !isAbsolute(path) ||
    !parent.isDirectory() ||
    parent.uid !== process.getuid?.() ||
    parent.mode & 0o077
  )
    throw new Error("diagnostics_unavailable");
  const counts = Object.fromEntries(diagnosticStages.map((stage) => [stage, 0]));
  let sequence = 0;
  let inode = 0;
  const persist = (lastStage: DiagnosticStage, initial = false) => {
    const data = JSON.stringify({ version: 1, sequence, lastStage, counts });
    const temporary = initial ? path : `${path}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      if (!initial) {
        const current = lstatSync(path);
        if (
          !current.isFile() ||
          current.ino !== inode ||
          current.uid !== process.getuid?.() ||
          current.mode & 0o077
        )
          throw new Error("diagnostics_unavailable");
      }
      fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(fd, data);
      inode = fstatSync(fd).ino;
      closeSync(fd);
      fd = undefined;
      if (!initial) renameSync(temporary, path);
    } catch {
      if (fd !== undefined) closeSync(fd);
      if (!initial) {
        try {
          unlinkSync(temporary);
        } catch {
          /* no unbounded error details */
        }
      }
      throw new Error("diagnostics_unavailable");
    }
  };
  counts.initialized = 1;
  persist("initialized", true);
  return (stage) => {
    if (!diagnosticStages.includes(stage)) throw new Error("diagnostics_invalid_stage");
    counts[stage] = Math.min(1000000, counts[stage]! + 1);
    sequence = Math.min(1000000, sequence + 1);
    persist(stage);
  };
}
