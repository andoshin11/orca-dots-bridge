import { expect, it, vi } from "vitest";
import { approvePrivateCandidate } from "../src/notification-approval-check.js";
import { digest } from "../src/events/model.js";
import { limitTrialVerification } from "../src/events/trial-verification-budget.js";
const target = {
  executionHostId: "local",
  worktreeId: "fixture",
  terminalHandle: "term_fixture",
  paneKey: "pane",
  incarnationId: "gen",
  launchId: "launch",
  providerSessionId: "session",
};
const privateUrl = "https://receiver.example.com/private?opaque=synthetic";
const candidate = {
  host: "receiver.example.com",
  urlHash: digest(privateUrl),
  owner: "service:trial-service-v1",
  targetHash: digest(target),
  expiresAt: 700000,
};
const input = {
  candidate,
  target,
  policyExpiresAt: 600000,
  privateUrl,
  reviewedHost: candidate.host,
  verificationBasis: "bounded_protocol_test",
  challengeConfirmation: `確認通信を承認 ${candidate.host}`,
  eventsConfirmation: `通知送信を承認 ${candidate.host}`,
};
it("requires exact private URL, explicit challenge and conditional event approval, and clamps to original expiry", () => {
  const result = approvePrivateCandidate(input, 100000);
  expect(result.expiresAt).toBe(600000);
  expect(JSON.stringify(result)).not.toContain("opaque");
  for (const patch of [
    { privateUrl: privateUrl + "changed" },
    { reviewedHost: "other.example.com" },
    { target: { ...target, incarnationId: "replacement" } },
    { challengeConfirmation: "" },
    { challengeConfirmation: `APPROVE CHALLENGE ${candidate.host}` },
    { challengeConfirmation: `確認通信を承認　${candidate.host}` },
    { eventsConfirmation: `通知送信を承認 ${candidate.host}追加` },
    { eventsConfirmation: "" },
    { verificationBasis: "guess" },
    { candidate: { ...candidate, owner: "other" } },
    { policyExpiresAt: 99999 },
  ])
    expect(() => approvePrivateCandidate({ ...input, ...patch }, 100000)).toThrow();
  expect(() => approvePrivateCandidate(input, 600000)).toThrow("approval_expired");
});
it("allows at most one challenge including failure, and never sends after expiry", async () => {
  let now = 100;
  const send = vi
    .fn()
    .mockRejectedValueOnce(new Error("synthetic_failure"))
    .mockResolvedValue({ status: 200, body: "{}" });
  const post = limitTrialVerification(send, 200, () => now);
  const challenge = JSON.stringify({ type: "verification", challenge: "synthetic" });
  await expect(post(privateUrl, {}, challenge)).rejects.toThrow("synthetic_failure");
  await expect(post(privateUrl, {}, challenge)).rejects.toThrow("callback_approval_required");
  expect(send).toHaveBeenCalledTimes(1);
  now = 200;
  await expect(post(privateUrl, {}, JSON.stringify({ eventId: "synthetic" }))).rejects.toThrow(
    "callback_approval_required",
  );
  expect(send).toHaveBeenCalledTimes(1);
});
