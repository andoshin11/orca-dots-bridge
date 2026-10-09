import { expect, it } from "vite-plus/test";
import { assertCallbackApproval } from "../src/events/callback-preflight.js";
import { digest } from "../src/events/model.js";

const sessionTarget = {
  executionHostId: "local",
  worktreeId: "fixture",
  terminalHandle: "term_test",
  paneKey: "tab:leaf",
  incarnationId: "generation",
  launchId: "launch",
  providerSessionId: "session",
};
const paneTarget = {
  executionHostId: "local",
  worktreeId: "fixture",
  terminalHandle: "term_test",
  paneKey: "tab:leaf",
  incarnationId: "generation",
};
const url = "https://receiver.example.com/one";
const now = 1_000_000;
const delivery = {
  mode: "webhook",
  url,
  secret: `whsec_${Buffer.alloc(32, 8).toString("base64")}`,
};
const approvalFor = (target: unknown) => ({
  host: "receiver.example.com",
  urlHash: digest(new URL(url).href),
  owner: "service:trial-service-v1",
  targetHash: digest(target),
  expiresAt: now + 60_000,
});
const owner = "service:trial-service-v1";

it("approves a pane subscription against a pane-target approval", () => {
  expect(() =>
    assertCallbackApproval(
      approvalFor(paneTarget),
      owner,
      { name: "orca.pane_activity", arguments: paneTarget, delivery },
      now,
    ),
  ).not.toThrow();
});

it("keeps approving session subscriptions as before", () => {
  expect(() =>
    assertCallbackApproval(
      approvalFor(sessionTarget),
      owner,
      { name: "orca.session_activity", arguments: sessionTarget, delivery },
      now,
    ),
  ).not.toThrow();
});

it("rejects a session target under the pane event name and the reverse at the subscribe schema", () => {
  const stages: string[] = [];
  expect(() =>
    assertCallbackApproval(
      approvalFor(sessionTarget),
      owner,
      { name: "orca.pane_activity", arguments: sessionTarget, delivery },
      now,
      (stage) => stages.push(stage),
    ),
  ).toThrow();
  expect(() =>
    assertCallbackApproval(
      approvalFor(paneTarget),
      owner,
      { name: "orca.session_activity", arguments: paneTarget, delivery },
      now,
      (stage) => stages.push(stage),
    ),
  ).toThrow();
  expect(stages).toEqual([
    "subscribe_schema_rejected",
    "schema_arguments",
    "subscribe_schema_rejected",
    "schema_arguments",
  ]);
});

it("still rejects any other event name", () => {
  expect(() =>
    assertCallbackApproval(
      approvalFor(sessionTarget),
      owner,
      { name: "orca.turn_finished", arguments: sessionTarget, delivery },
      now,
    ),
  ).toThrow("invalid_params");
});
