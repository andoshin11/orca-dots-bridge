import { EventError, type Post } from "./webhook.js";
import type { DiagnosticRecord } from "./preflight-diagnostics.js";
import { recordDeliveryFailure } from "./delivery-diagnostics.js";
/** One challenge attempt, including failure; event retries remain within the original deadline. */
export function limitTrialVerification(
  post: Post,
  expiresAt: number,
  now = Date.now,
  diagnostic?: DiagnosticRecord,
): Post {
  let attempted = false;
  return async (url, headers, body, signal) => {
    const verification = JSON.parse(body).type === "verification";
    if (signal?.aborted || now() >= expiresAt || (verification && attempted)) {
      diagnostic?.(verification ? "challenge_blocked" : "event_send_blocked");
      throw new EventError("callback_approval_required");
    }
    if (verification) attempted = true;
    diagnostic?.(verification ? "challenge_attempted" : "event_send_attempted");
    try {
      const result = await post(url, headers, body, signal);
      if (signal?.aborted || now() >= expiresAt) throw new EventError("callback_approval_required");
      if (!verification)
        diagnostic?.(
          result.status >= 200 && result.status < 300
            ? "event_send_succeeded"
            : "event_send_failed",
        );
      return result;
    } catch (error) {
      recordDeliveryFailure(error, diagnostic);
      diagnostic?.(verification ? "challenge_transport_failed" : "event_send_failed");
      throw error;
    }
  };
}
