import { z } from "zod";
import { callbackApprovalSchema } from "./events/callback-preflight.js";
import { notificationTargetSchema } from "./events/orca-contract.js";
import { callbackUrl } from "./events/webhook.js";
import { digest } from "./events/model.js";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const inputSchema = z
  .object({
    candidate: callbackApprovalSchema,
    target: notificationTargetSchema,
    policyExpiresAt: z.number().int().positive(),
    privateUrl: z.string().min(1).max(16384),
    reviewedHost: z.string().min(1).max(253),
    verificationBasis: z.enum(["independent", "bounded_protocol_test"]),
    challengeConfirmation: z.string(),
    eventsConfirmation: z.string(),
  })
  .strict();
/** Local syntax/hash check only: never resolves DNS, reads keys or sends a request. */
export function approvePrivateCandidate(raw: unknown, now = Date.now()) {
  const p = inputSchema.parse(raw);
  const url = callbackUrl(p.privateUrl, [p.candidate.host]);
  if (
    p.reviewedHost !== p.candidate.host ||
    p.challengeConfirmation !== `確認通信を承認 ${p.candidate.host}` ||
    p.eventsConfirmation !== `通知送信を承認 ${p.candidate.host}` ||
    digest(url.href) !== p.candidate.urlHash ||
    digest(p.target) !== p.candidate.targetHash
  ) {
    throw new Error("approval_identity_mismatch");
  }
  const expiresAt = Math.min(p.policyExpiresAt, p.candidate.expiresAt);
  if (expiresAt - now < 2000 || expiresAt - now > 600000) throw new Error("approval_expired");
  return { ...p.candidate, expiresAt };
}
async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (Buffer.byteLength(input) > 65536) throw new Error("approval_input_limit");
  }
  const approved = approvePrivateCandidate(JSON.parse(input));
  input = "";
  process.stdout.write(JSON.stringify(approved));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main().catch(() => {
    process.stderr.write("承認入力が一致しないか期限切れのため、送信せず停止しました。\n");
    process.exitCode = 1;
  });
}
