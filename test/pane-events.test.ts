import { afterEach, expect, it, vi } from "vite-plus/test";
import { EventEngine } from "../src/events/engine.js";
import { digest } from "../src/events/model.js";
import {
  createPaneDescriber,
  paneTargetSchema,
  relayMessageSchema,
  relayStatusSchema,
  samePaneTarget,
  type PaneTarget,
  type RelayStatus,
} from "../src/events/pane-contract.js";
import { createRelayHub, PaneEventsRpc, paneCatalog } from "../src/events/pane-rpc.js";
import type { DiagnosticStage } from "../src/events/preflight-diagnostics.js";

const target: PaneTarget = {
  executionHostId: "local",
  worktreeId: "wt_pane",
  terminalHandle: "term_pane",
  paneKey: "tab_1:leaf_1",
  incarnationId: "inc_1",
};
const sessionTarget = { ...target, launchId: "launch", providerSessionId: "session" };
const delivery = {
  mode: "webhook",
  url: "https://receiver.example.com/one-private-path",
  secret: `whsec_${Buffer.alloc(32, 7).toString("base64")}`,
};
const params = { name: "orca.pane_activity", arguments: target, delivery };
const t0 = 100000;

function status(kind: RelayStatus["kind"], startedAt = t0 + 100, extra: Partial<RelayStatus> = {}) {
  return {
    type: "agent.status.changed",
    kind,
    worktreeId: target.worktreeId,
    paneKey: target.paneKey,
    tabId: "tab_1",
    leafId: "leaf_1",
    state: kind,
    mainAgent: { state: kind, stateStartedAt: startedAt },
    receivedAt: t0 + 500,
    ...extra,
  } satisfies RelayStatus;
}

// ---- pane-contract ----

it("accepts only strict local pane targets", () => {
  expect(paneTargetSchema.parse(target)).toEqual(target);
  expect(() => paneTargetSchema.parse(sessionTarget)).toThrow();
  expect(() => paneTargetSchema.parse({ ...target, executionHostId: "remote" })).toThrow();
  expect(() => paneTargetSchema.parse({ ...target, incarnationId: undefined })).toThrow();
  expect(() => paneTargetSchema.parse({ ...target, paneKey: " tab:leaf" })).toThrow();
  expect(() => paneTargetSchema.parse({ ...target, paneKey: "" })).toThrow();
});

it.each(["worktreeId", "terminalHandle", "paneKey", "incarnationId"] as const)(
  "samePaneTarget compares %s",
  (field) => {
    expect(samePaneTarget(target, { ...target })).toBe(true);
    expect(samePaneTarget(target, { ...target, [field]: "other" })).toBe(false);
  },
);

it("parses relay messages strictly", () => {
  expect(relayStatusSchema.parse(status("done"))).toEqual(status("done"));
  expect(
    relayStatusSchema.parse(status("done", 1, { worktreeId: null, mainAgent: null })),
  ).toBeTruthy();
  expect(relayMessageSchema.parse({ type: "relay.test", sentAt: 1 })).toEqual({
    type: "relay.test",
    sentAt: 1,
  });
  for (const bad of [
    { ...status("done"), extra: 1 },
    { ...status("done"), kind: "idle" },
    { ...status("done"), receivedAt: Number.POSITIVE_INFINITY },
    { ...status("done"), mainAgent: { state: "done", stateStartedAt: 1, text: "x" } },
    { ...status("done"), paneKey: "" },
    { type: "unknown" },
  ])
    expect(relayMessageSchema.safeParse(bad).success).toBe(false);
});

const terminal = (extra: Record<string, unknown> = {}) => ({
  handle: "term_pane",
  worktreeId: "wt_pane",
  tabId: "tab_1",
  leafId: "leaf_1",
  incarnationId: "inc_1",
  ...extra,
});
const envelope = (result: unknown) => JSON.stringify({ ok: true, result });

it("describes a pane through `orca terminal show` and builds paneKey from tab and leaf", async () => {
  const run = vi.fn(async () => envelope({ terminal: terminal({ extra: "ignored" }) }));
  await expect(createPaneDescriber(run)("term_pane")).resolves.toEqual(target);
  expect(run).toHaveBeenCalledExactlyOnceWith(["terminal", "show", "--terminal", "term_pane"]);
  for (const executionHostId of [undefined, null, "local"])
    await expect(
      createPaneDescriber(async () => envelope({ terminal: terminal({ executionHostId }) }))(
        "term_pane",
      ),
    ).resolves.toEqual(target);
});

it.each([
  ["a different handle", { terminal: terminal({ handle: "term_other" }) }, "target_unavailable"],
  ["a remote host", { terminal: terminal({ executionHostId: "ssh:box" }) }, "target_unavailable"],
  [
    "a missing incarnationId",
    { terminal: terminal({ incarnationId: undefined }) },
    "schema_changed",
  ],
  ["a missing leafId", { terminal: terminal({ leafId: undefined }) }, "schema_changed"],
  ["no terminal", {}, "schema_changed"],
])("rejects a describe result with %s", async (_name, result, code) => {
  await expect(
    createPaneDescriber(async () => envelope(result))("term_pane"),
  ).rejects.toMatchObject({ code });
});

it("surfaces Orca failures and invalid output from the runner", async () => {
  await expect(
    createPaneDescriber(async () =>
      JSON.stringify({ ok: false, error: { code: "terminal_not_found" } }),
    )("term_pane"),
  ).rejects.toMatchObject({ code: "terminal_not_found" });
  await expect(createPaneDescriber(async () => "not json")("term_pane")).rejects.toMatchObject({
    code: "invalid_json",
  });
  await expect(
    createPaneDescriber(async () => {
      throw new Error("spawn failed");
    })("term_pane"),
  ).rejects.toThrow("spawn failed");
});

// ---- hub ----

it("fans a status out only to watchers of its paneKey and stops after unwatch", () => {
  const hub = createRelayHub();
  const a = vi.fn(),
    b = vi.fn(),
    other = vi.fn();
  const stopA = hub.watch(target.paneKey, a);
  hub.watch(target.paneKey, b);
  hub.watch("tab_2:leaf_2", other);
  hub.publish(status("done"));
  expect(a).toHaveBeenCalledExactlyOnceWith(status("done"));
  expect(b).toHaveBeenCalledOnce();
  expect(other).not.toHaveBeenCalled();
  stopA();
  stopA();
  hub.publish(status("done"));
  expect(a).toHaveBeenCalledOnce();
  expect(b).toHaveBeenCalledTimes(2);
  expect(() => hub.publish(status("done", 1, { paneKey: "nobody:home" }))).not.toThrow();
});

// ---- PaneEventsRpc ----

function memoryStore() {
  let blob: string | null = null;
  return {
    load: async () => blob,
    save: async (value: string) => {
      blob = value;
    },
  };
}
const clean: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of clean.splice(0)) await close();
  vi.useRealTimers();
});
type Sent = { url: string; headers: Record<string, string>; body: any };
async function rpcFixture() {
  const sent: Sent[] = [];
  const stages: DiagnosticStage[] = [];
  let current: PaneTarget = target;
  let failDescribe = false;
  let describeCalls = 0;
  const describe = vi.fn(async () => {
    describeCalls++;
    if (failDescribe) throw new Error("synthetic describe failure");
    return current;
  });
  const hub = createRelayHub();
  const engine = await EventEngine.open({
    now: () => t0,
    key: Buffer.alloc(32, 4),
    store: memoryStore(),
    allowedCallbackHosts: ["receiver.example.com"],
    authorize: async (owner, value) => owner === "owner" && digest(value) === digest(target),
    post: async (url, headers, body) => {
      sent.push({ url, headers, body: JSON.parse(body) });
      return { status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) };
    },
  });
  const rpc = new PaneEventsRpc(
    engine,
    { watch: hub.watch, describe },
    () => t0,
    600000,
    (stage) => stages.push(stage),
  );
  clean.push(() => rpc.close());
  const events = () => sent.filter((s) => s.body.type !== "verification").map((s) => s.body);
  return {
    rpc,
    hub,
    describe,
    sent,
    stages,
    events,
    engine,
    setCurrent: (value: PaneTarget) => {
      current = value;
    },
    failDescribe: () => {
      failDescribe = true;
    },
    describeCalls: () => describeCalls,
    subscribe: (input: unknown = params, owner = "owner") =>
      rpc.dispatch(owner, "events/subscribe", input),
    unsubscribe: () =>
      rpc.dispatch("owner", "events/unsubscribe", {
        name: params.name,
        arguments: target,
        delivery: { mode: "webhook", url: delivery.url },
      }),
    settle: async (expected: number) => {
      await vi.waitFor(() => expect(events()).toHaveLength(expected));
    },
  };
}

it("lists the pane catalog entry only", async () => {
  const f = await rpcFixture();
  const result = (await f.rpc.dispatch("owner", "events/list", {})) as { events: any[] };
  expect(result.events.map((e) => e.name)).toEqual(["orca.pane_activity"]);
  expect(result.events).toEqual(paneCatalog);
  expect(result.events[0].description).toContain("Pane-scoped only");
  await expect(f.rpc.dispatch("owner", "events/list", { cursor: "x" })).rejects.toThrow();
  await expect(f.rpc.dispatch("", "events/list", {})).rejects.toThrow("unauthorized");
  await expect(f.rpc.dispatch("owner", "tools/list", {})).rejects.toThrow("method_not_found");
});

it("turns done into turn_finished receipt_only/pane_only, delivered once", async () => {
  const f = await rpcFixture();
  const subscription = (await f.subscribe()) as { id: string };
  expect(f.stages).toEqual(["monitoring_start_attempted", "monitoring_started"]);
  f.hub.publish(status("done", t0 + 100));
  await f.settle(1);
  const event = f.events()[0];
  expect(event).toMatchObject({
    name: "orca.pane_activity",
    cursor: null,
    timestamp: new Date(t0 + 500).toISOString(),
    data: {
      subscriptionId: digest(subscription.id),
      kind: "turn_finished",
      outcome: "unconfirmed",
      freshness: "receipt_only",
      assurance: "pane_only",
    },
  });
  expect(event.data).not.toHaveProperty("reason");
  expect(event.eventId).toBe(digest([subscription.id, target.paneKey, "done", t0 + 100]));
  expect(f.stages).toContain("pane_status_queued");
  // Same stateStartedAt, later receivedAt: the engine's seen set swallows it.
  f.hub.publish(status("done", t0 + 100, { receivedAt: t0 + 900 }));
  f.hub.publish(status("blocked", t0 + 200));
  await f.settle(2);
  expect(f.events().map((e) => e.data.kind)).toEqual(["turn_finished", "input_required"]);
  // A new stateStartedAt is a new turn end.
  f.hub.publish(status("done", t0 + 300));
  await f.settle(3);
  expect(f.events()[2].data.kind).toBe("turn_finished");
});

it.each(["waiting", "blocked"] as const)("turns %s into input_required", async (kind) => {
  const f = await rpcFixture();
  await f.subscribe();
  f.hub.publish(status(kind));
  await f.settle(1);
  expect(f.events()[0].data).toMatchObject({
    kind: "input_required",
    freshness: "receipt_only",
    assurance: "pane_only",
  });
  expect(f.events()[0].data).not.toHaveProperty("outcome");
});

it("falls back to receivedAt for the event id when mainAgent is null", async () => {
  const f = await rpcFixture();
  const subscription = (await f.subscribe()) as { id: string };
  f.hub.publish(status("done", 0, { mainAgent: null, receivedAt: t0 + 700 }));
  f.hub.publish(status("done", 0, { mainAgent: null, receivedAt: t0 + 700 }));
  f.hub.publish(status("done", 0, { mainAgent: null, receivedAt: t0 + 800 }));
  await f.settle(2);
  expect(f.events()[0].eventId).toBe(digest([subscription.id, target.paneKey, "done", t0 + 700]));
});

it("ignores working status and statuses for another pane", async () => {
  const f = await rpcFixture();
  await f.subscribe();
  const before = f.describeCalls();
  f.hub.publish(status("working"));
  f.hub.publish(status("done", t0 + 100, { paneKey: "tab_9:leaf_9" }));
  f.hub.publish(status("waiting", t0 + 200, { paneKey: "tab_9:leaf_9" }));
  // Barrier: the real status after the ignored ones is the first thing delivered.
  f.hub.publish(status("waiting", t0 + 300));
  await f.settle(1);
  expect(f.events()[0].data.kind).toBe("input_required");
  expect(f.describeCalls()).toBe(before + 1);
});

it("accepts a status without a worktreeId", async () => {
  const f = await rpcFixture();
  await f.subscribe();
  f.hub.publish(status("done", t0 + 100, { worktreeId: null }));
  await f.settle(1);
  expect(f.events()[0].data.kind).toBe("turn_finished");
});

it("stops with identity_changed when the relay reports another worktree", async () => {
  const f = await rpcFixture();
  await f.subscribe();
  f.hub.publish(status("done", t0 + 100, { worktreeId: "wt_other" }));
  await f.settle(1);
  expect(f.events()[0].data).toMatchObject({
    kind: "monitoring_interrupted",
    reason: "identity_changed",
    freshness: "receipt_only",
    assurance: "pane_only",
  });
  expect(f.stages).toContain("monitoring_stopped");
  const calls = f.describeCalls();
  f.hub.publish(status("done", t0 + 200));
  await new Promise((r) => setTimeout(r, 20));
  expect(f.events()).toHaveLength(1);
  expect(f.describeCalls()).toBe(calls);
});

it("re-describes before queueing and reports identity_changed when the pane was replaced", async () => {
  const f = await rpcFixture();
  await f.subscribe();
  f.setCurrent({ ...target, incarnationId: "inc_2" });
  f.hub.publish(status("done", t0 + 100));
  await f.settle(1);
  expect(f.events()[0].data).toMatchObject({
    kind: "monitoring_interrupted",
    reason: "identity_changed",
  });
  expect(f.events().some((e) => e.data.kind === "turn_finished")).toBe(false);
  expect(f.stages).not.toContain("pane_status_queued");
  f.hub.publish(status("waiting", t0 + 200));
  await new Promise((r) => setTimeout(r, 20));
  expect(f.events()).toHaveLength(1);
});

it("reports target_unavailable when describing fails after monitoring started", async () => {
  const f = await rpcFixture();
  await f.subscribe();
  f.failDescribe();
  f.hub.publish(status("done", t0 + 100));
  await f.settle(1);
  expect(f.events()[0].data).toMatchObject({
    kind: "monitoring_interrupted",
    reason: "target_unavailable",
  });
});

it("refuses to start monitoring when the pane differs or cannot be described", async () => {
  const changed = await rpcFixture();
  changed.setCurrent({ ...target, incarnationId: "inc_2" });
  await expect(changed.subscribe()).rejects.toThrow("runtime_target_changed");
  expect(changed.stages).toContain("runtime_target_changed");
  expect(changed.stages).toContain("monitoring_start_failed");
  const down = await rpcFixture();
  down.failDescribe();
  await expect(down.subscribe()).rejects.toThrow("runtime_unavailable");
  // Neither left a live subscription behind.
  for (const f of [changed, down]) {
    f.hub.publish(status("done"));
    await new Promise((r) => setTimeout(r, 20));
    expect(f.events()).toHaveLength(0);
  }
});

it("stops delivering after unsubscribe", async () => {
  const f = await rpcFixture();
  await f.subscribe();
  f.hub.publish(status("done", t0 + 100));
  await f.settle(1);
  await f.unsubscribe();
  expect(f.stages).toContain("monitoring_stopped");
  const calls = f.describeCalls();
  f.hub.publish(status("waiting", t0 + 200));
  await new Promise((r) => setTimeout(r, 20));
  expect(f.events()).toHaveLength(1);
  expect(f.describeCalls()).toBe(calls);
});

it("stops delivering after close and rejects later calls", async () => {
  const f = await rpcFixture();
  await f.subscribe();
  await f.rpc.close();
  f.hub.publish(status("done", t0 + 100));
  await new Promise((r) => setTimeout(r, 20));
  expect(f.events()).toHaveLength(0);
  await expect(f.subscribe()).rejects.toThrow("runtime_unavailable");
});

it("rejects other event names and targets of another shape before any callback traffic", async () => {
  const f = await rpcFixture();
  // A pane target under the session event name fails the subscribe schema itself.
  await expect(f.subscribe({ ...params, name: "orca.session_activity" })).rejects.toThrow(
    "event_target_mismatch",
  );
  await expect(f.subscribe({ ...params, name: "orca.turn_finished" })).rejects.toThrow();
  await expect(f.subscribe({ ...params, arguments: sessionTarget })).rejects.toThrow();
  await expect(
    f.subscribe({ ...params, arguments: { ...target, executionHostId: "remote" } }),
  ).rejects.toThrow();
  await expect(f.subscribe({ ...params, ttlMs: 1000 })).rejects.toThrow("invalid_params");
  await expect(f.subscribe(params, "")).rejects.toThrow("unauthorized");
  expect(f.sent).toHaveLength(0);
  expect(f.describe).not.toHaveBeenCalled();
});

it("treats the same request as idempotent and verifies the callback once", async () => {
  const f = await rpcFixture();
  const first = await f.subscribe();
  expect(await f.subscribe()).toEqual(first);
  expect(f.sent.filter((s) => s.body.type === "verification")).toHaveLength(1);
});

it("lets the engine reject malformed or foreign-name pane events", async () => {
  const f = await rpcFixture();
  const { id } = (await f.subscribe()) as { id: string };
  const base = {
    eventId: "e1",
    name: "orca.pane_activity",
    timestamp: new Date(t0 + 1).toISOString(),
    cursor: null,
  };
  const data = {
    subscriptionId: "s",
    freshness: "receipt_only",
    assurance: "pane_only",
  };
  const ingest = (event: unknown) => f.engine.ingestSession("owner", id, target, event);
  // turn_finished must say outcome unconfirmed
  expect(await ingest({ ...base, data: { ...data, kind: "turn_finished" } })).toBe(false);
  // monitoring_interrupted must carry a reason
  expect(await ingest({ ...base, data: { ...data, kind: "monitoring_interrupted" } })).toBe(false);
  // input_required must not carry an outcome
  expect(
    await ingest({ ...base, data: { ...data, kind: "input_required", outcome: "unconfirmed" } }),
  ).toBe(false);
  // strong-assurance claims are not expressible for a pane event
  expect(
    await ingest({ ...base, data: { ...data, assurance: "session", kind: "input_required" } }),
  ).toBe(false);
  // a session-named event does not belong to a pane subscription
  expect(
    await ingest({
      ...base,
      name: "orca.session_activity",
      data: { ...data, kind: "input_required" },
    }),
  ).toBe(false);
  // another target is not this subscription's target
  expect(
    await f.engine.ingestSession(
      "owner",
      id,
      { ...target, incarnationId: "other" },
      { ...base, data: { ...data, kind: "input_required" } },
    ),
  ).toBe(false);
  expect(await ingest({ ...base, data: { ...data, kind: "input_required" } })).toBe(true);
  expect(await ingest({ ...base, data: { ...data, kind: "input_required" } })).toBe(false);
});

// ---- end to end through PaneEventsRpc ----

it("end to end: delivered once, then interrupted when the pane is replaced", async () => {
  const f = await rpcFixture();
  const subscribed = (await f.subscribe()) as { id: string };
  expect(subscribed.id).toMatch(/^sub_/);

  f.hub.publish(status("done", t0 + 100));
  await f.settle(1);
  const delivered = f.sent.filter((s) => s.body.type !== "verification")[0]!;
  expect(delivered.url).toBe(delivery.url);
  expect(delivered.headers["webhook-signature"]).toMatch(/^v1,/);
  expect(delivered.body).toMatchObject({
    name: "orca.pane_activity",
    data: {
      subscriptionId: digest(subscribed.id),
      kind: "turn_finished",
      outcome: "unconfirmed",
      freshness: "receipt_only",
      assurance: "pane_only",
    },
  });

  // The same status again is not posted twice; the next distinct one arrives right after it.
  f.hub.publish(status("done", t0 + 100));
  f.hub.publish(status("waiting", t0 + 200));
  await f.settle(2);
  expect(f.events().map((e) => e.data.kind)).toEqual(["turn_finished", "input_required"]);

  // A replaced PTY (new incarnationId) interrupts monitoring, and monitoring then stops.
  f.setCurrent({ ...target, incarnationId: "inc_2" });
  f.hub.publish(status("waiting", t0 + 300));
  await f.settle(3);
  expect(f.events()[2]).toMatchObject({
    name: "orca.pane_activity",
    data: { kind: "monitoring_interrupted", reason: "identity_changed", assurance: "pane_only" },
  });
  f.setCurrent(target);
  f.hub.publish(status("done", t0 + 400));
  await new Promise((r) => setTimeout(r, 20));
  expect(f.events()).toHaveLength(3);
});

it("reports queue_limit instead of stopping silently when the backlog overflows", async () => {
  const f = await rpcFixture();
  await f.subscribe();
  const release: Array<() => void> = [];
  // Every per-event identity check hangs, as with an unresponsive Orca CLI.
  f.describe.mockImplementation(
    () => new Promise<PaneTarget>((resolve) => release.push(() => resolve(target))),
  );
  for (let i = 0; i < 17; i++) f.hub.publish(status("done", t0 + 100 + i));
  expect(f.stages).toContain("monitoring_stopped");
  while (release.length > 0) release.shift()!();
  await new Promise((r) => setTimeout(r, 30));
  // Only the interruption is delivered; the backlog is discarded once monitoring stopped.
  expect(f.events()).toEqual([
    expect.objectContaining({
      name: "orca.pane_activity",
      data: expect.objectContaining({ kind: "monitoring_interrupted", reason: "queue_limit" }),
    }),
  ]);
  f.hub.publish(status("waiting", t0 + 900));
  await new Promise((r) => setTimeout(r, 20));
  expect(f.events()).toHaveLength(1);
});

it("reports ingest_failed when an event cannot be stored", async () => {
  const f = await rpcFixture();
  await f.subscribe();
  vi.spyOn(f.engine, "ingestSession").mockRejectedValueOnce(new Error("synthetic store failure"));
  f.hub.publish(status("done"));
  await new Promise((r) => setTimeout(r, 30));
  expect(f.events()).toEqual([
    expect.objectContaining({
      data: expect.objectContaining({ kind: "monitoring_interrupted", reason: "ingest_failed" }),
    }),
  ]);
});
