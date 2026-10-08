import { describe, expect, it } from "vite-plus/test";
import { OrcaNotificationAdapter } from "../src/events/orca-adapter.js";
const target = {
  executionHostId: "local" as const,
  worktreeId: "folder:/private/path with spaces",
  terminalHandle: "term_fixture",
  paneKey: "pane",
  incarnationId: "gen",
  launchId: "launch",
  providerSessionId: "session",
};
const accepted = {
  version: 2,
  subscriptionId: "sub",
  target,
  authorityEpoch: "epoch",
  baselineSequence: 0,
  expiresAt: 2000,
  replayCursor: null,
};
const event = {
  version: 2,
  target,
  authorityEpoch: "epoch",
  sequence: 1,
  eventId: "event",

  occurredAt: 1000,
  kind: "input_required",
};
describe("Orca notification adapter", () => {
  it("redacts internal location and emits stable opaque identifiers", () => {
    const a = new OrcaNotificationAdapter(accepted, target, () => 1000);
    const output = a.accept(event);
    expect(output?.name).toBe("orca.input_waiting");
    expect(JSON.stringify(output)).not.toContain("/private/");
    expect(output?.data).not.toHaveProperty("target");
    expect(a.accept(event)).toBeNull();
    expect(new OrcaNotificationAdapter(accepted, target, () => 1000).accept(event)).toEqual(output);
  });
  it.each(Object.keys(target))("stops on mismatched %s", (key) => {
    const a = new OrcaNotificationAdapter(accepted, target, () => 1000);
    expect(a.accept({ ...event, target: { ...target, [key]: "other" } })).toBeNull();
    expect(a.accept(event)).toBeNull();
  });
  it("stops on gaps, epoch change, unknown version, malformed data or expiry", () => {
    for (const bad of [
      { ...event, sequence: 2 },
      { ...event, authorityEpoch: "new" },
      { ...event, version: 99 },
      { state: "done", paneKey: "pane" },
    ]) {
      const a = new OrcaNotificationAdapter(accepted, target, () => 1000);
      expect(a.accept(bad)).toBeNull();
      expect(a.accept(event)).toBeNull();
    }
    let now = 1000;
    const a = new OrcaNotificationAdapter(accepted, target, () => now);
    now = 2000;
    expect(a.accept(event)).toBeNull();
  });
  it("requires a valid finite handshake and an explicit unconfirmed finish outcome", () => {
    expect(
      () => new OrcaNotificationAdapter({ ...accepted, replayCursor: "old" }, target),
    ).toThrow();
    const a = new OrcaNotificationAdapter(accepted, target, () => 1000);
    expect(a.accept({ ...event, kind: "turn_finished" })).toBeNull();
    const b = new OrcaNotificationAdapter(accepted, target, () => 1000);
    expect(
      b.accept({ ...event, kind: "turn_finished", outcome: "unconfirmed" })?.data.outcome,
    ).toBe("unconfirmed");
  });
});

it("keeps monitoring interruption separate from turn completion, including expiry", () => {
  let now = 1000;
  const a = new OrcaNotificationAdapter(accepted, target, () => now);
  now = 2000;
  expect(
    a.accept({ ...event, kind: "monitoring_interrupted", reason: "expired", occurredAt: now }),
  ).toMatchObject({ name: "orca.monitoring_interrupted", data: { reason: "expired" } });
  expect(a.status()).toEqual({ state: "interrupted", reason: "expired" });
});
it("reports local expiration even when the host sends nothing", () => {
  let now = 1000;
  const a = new OrcaNotificationAdapter(accepted, target, () => now);
  now = 2000;
  expect(a.status()).toEqual({ state: "interrupted", reason: "expired" });
});
