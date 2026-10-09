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
import {
  createServiceNotificationEndpoint,
  paneMonitor,
  sessionMonitor,
} from "../src/events/service-endpoint.js";
import {
  createTwoPhaseEndpoint,
  validateVerificationScope,
} from "../src/events/two-phase-endpoint.js";
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
const serviceKey = Buffer.alloc(32, 3);
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
type Sent = { url: string; body: any };
async function rpcFixture(
  options: { single?: boolean; defer?: boolean; describeAtStart?: PaneTarget } = {},
) {
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
    post: async (url, _headers, body) => {
      sent.push({ url, body: JSON.parse(body) });
      return { status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) };
    },
  });
  const rpc = new PaneEventsRpc(
    engine,
    { watch: hub.watch, describe },
    () => t0,
    600000,
    700000,
    options.single ?? true,
    (stage) => stages.push(stage),
    options.defer ?? false,
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
  const f = await rpcFixture({ single: false });
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

it("keeps a single subscription: same request is idempotent, another callback is refused", async () => {
  const f = await rpcFixture();
  const first = await f.subscribe();
  expect(await f.subscribe()).toEqual(first);
  await expect(
    f.subscribe({ ...params, delivery: { ...delivery, url: "https://receiver.example.com/two" } }),
  ).rejects.toThrow("subscription_limit");
  expect(f.sent.filter((s) => s.body.type === "verification")).toHaveLength(1);
  await f.unsubscribe();
  await expect(f.subscribe()).rejects.toThrow("subscription_limit");
});

it("defers monitoring until activateDeferred", async () => {
  const f = await rpcFixture({ defer: true });
  await expect(f.rpc.activateDeferred()).rejects.toThrow("activation_rejected");
  const first = (await f.subscribe()) as { id: string };
  expect(f.stages).toContain("notification_approval_waiting");
  expect(f.stages).not.toContain("monitoring_started");
  f.hub.publish(status("done", t0 + 100));
  await new Promise((r) => setTimeout(r, 20));
  expect(f.events()).toHaveLength(0);
  expect(f.describe).not.toHaveBeenCalled();
  await expect(f.subscribe()).rejects.toThrow("subscription_limit");
  const activated = (await f.rpc.activateDeferred()) as { id: string };
  expect(activated.id).toBe(first.id);
  expect(f.stages).toContain("monitoring_started");
  f.hub.publish(status("done", t0 + 200));
  await f.settle(1);
  await expect(f.rpc.activateDeferred()).rejects.toThrow("activation_rejected");
});

it("removes a deferred subscription on close without ever monitoring", async () => {
  const f = await rpcFixture({ defer: true });
  const first = (await f.subscribe()) as { id: string };
  await f.rpc.close();
  expect(await f.engine.hasSubscription("owner", first.id)).toBe(false);
  expect(f.stages).not.toContain("monitoring_started");
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

// ---- monitors and endpoints ----

it("exposes the event name and target shape of each monitor", () => {
  const pane = paneMonitor({ watch: createRelayHub().watch, describe: async () => target });
  const session = sessionMonitor({ open: async () => async () => {} });
  expect(pane.eventName).toBe("orca.pane_activity");
  expect(session.eventName).toBe("orca.session_activity");
  expect(pane.parseTarget(target)).toEqual(target);
  expect(() => pane.parseTarget(sessionTarget)).toThrow();
  expect(() => session.parseTarget(target)).toThrow();
  expect(session.parseTarget(sessionTarget)).toEqual(sessionTarget);
  expect(pane.sameTarget(target, { ...target })).toBe(true);
  expect(pane.sameTarget(target, { ...target, incarnationId: "other" })).toBe(false);
  expect(() => pane.sameTarget(target, sessionTarget)).toThrow();
  expect(session.sameTarget(sessionTarget, { ...sessionTarget })).toBe(true);
  expect(() => session.sameTarget(sessionTarget, target)).toThrow();
});

it("sessionMonitor.describe needs a transport that can describe", async () => {
  await expect(
    sessionMonitor({ open: async () => async () => {} }).describe("term_pane"),
  ).rejects.toThrow("runtime_unavailable");
  const describe = vi.fn(async () => sessionTarget);
  await expect(
    sessionMonitor({ open: async () => async () => {}, describe }).describe("term_pane"),
  ).resolves.toEqual(sessionTarget);
  expect(describe).toHaveBeenCalledWith("term_pane");
});

const engineBase = (post: (url: string, headers: any, body: string) => any, now: () => number) => ({
  now,
  key: Buffer.alloc(32, 4),
  store: memoryStore(),
  allowedCallbackHosts: ["receiver.example.com"],
  post,
});
const echoPost = async (_url: string, _headers: unknown, body: string) => echo(body);
const echo = (body: string) => ({
  status: 200,
  body: JSON.stringify({ challenge: JSON.parse(body).challenge }),
});
function mcp(fetch: (request: Request) => Promise<Response>) {
  return async (method: string, input: unknown = {}, bearer = serviceKey.toString("base64url")) => {
    const response = await fetch(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": method,
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: {
            ...(input as object),
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      }),
    );
    return { status: response.status, json: (await response.json().catch(() => undefined)) as any };
  };
}

it("requires a monitor or transport, and a monitor-matching target", async () => {
  const engine = engineBase(echoPost, () => t0);
  const base = { keyId: "k", serviceKey, expiresAt: 700000, engine };
  await expect(createServiceNotificationEndpoint({ ...base, target })).rejects.toThrow(
    "monitor_required",
  );
  const pane = paneMonitor({ watch: createRelayHub().watch, describe: async () => target });
  await expect(
    createServiceNotificationEndpoint({ ...base, target: sessionTarget, monitor: pane }),
  ).rejects.toThrow();
  // A pane target handed to the session path (legacy `transport`) is rejected.
  await expect(
    createServiceNotificationEndpoint({
      ...base,
      target,
      transport: { open: async () => async () => {} },
    }),
  ).rejects.toThrow();
  await expect(
    createServiceNotificationEndpoint({
      ...base,
      target,
      monitor: sessionMonitor({ open: async () => async () => {} }),
    }),
  ).rejects.toThrow();
  const endpoint = await createServiceNotificationEndpoint({ ...base, target, monitor: pane });
  await endpoint.close();
});

it("a monitor takes precedence over a legacy transport", async () => {
  const open = vi.fn(async () => async () => {});
  const hub = createRelayHub();
  const endpoint = await createServiceNotificationEndpoint({
    target,
    keyId: "k",
    serviceKey,
    expiresAt: 700000,
    engine: engineBase(echoPost, () => t0),
    transport: { open },
    monitor: paneMonitor({ watch: hub.watch, describe: async () => target }),
  });
  try {
    const call = mcp(endpoint.fetch);
    expect((await call("events/subscribe", params)).json.result.id).toMatch(/^sub_/);
    expect(open).not.toHaveBeenCalled();
  } finally {
    await endpoint.close();
  }
});

it("service endpoint serves the pane catalog and rejects session subscriptions and other targets", async () => {
  const sent: string[] = [];
  const hub = createRelayHub();
  const endpoint = await createServiceNotificationEndpoint({
    target,
    keyId: "k",
    serviceKey,
    expiresAt: 700000,
    engine: engineBase(
      (_u, _h, body) => {
        sent.push(body);
        return echo(body);
      },
      () => t0,
    ),
    monitor: paneMonitor({ watch: hub.watch, describe: async () => target }),
  });
  try {
    const call = mcp(endpoint.fetch);
    expect((await call("events/list", {}, "wrong")).status).toBe(401);
    expect((await call("events/list")).json.result.events.map((e: any) => e.name)).toEqual([
      "orca.pane_activity",
    ]);
    for (const bad of [
      { ...params, name: "orca.session_activity" },
      { ...params, arguments: { ...target, paneKey: "other:pane" } },
      { ...params, arguments: sessionTarget },
    ])
      expect((await call("events/subscribe", bad)).json).toHaveProperty("error");
    expect(sent).toHaveLength(0);
    expect((await call("events/subscribe", params)).json).toHaveProperty("result.id");
  } finally {
    await endpoint.close();
  }
});

// ---- two-phase end to end ----

const scope = {
  host: "receiver.example.com",
  owner: "service:trial-service-v1" as const,
  targetHash: digest(target),
  expiresAt: 700000,
  domainConfirmation: "送信先ドメインを確認 receiver.example.com",
  confirmation: "確認通信1回のみを承認 receiver.example.com",
  accountBasis: "bounded_protocol_test" as const,
};
const approval = {
  privateUrl: delivery.url,
  confirmation: "通知送信を承認 receiver.example.com",
  accountBasis: "bounded_protocol_test",
};
async function twoPhase() {
  const hub = createRelayHub();
  let current: PaneTarget = target;
  const describe = vi.fn(async () => current);
  const posts: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  let blob: string | null = null;
  const stages: DiagnosticStage[] = [];
  const review = vi.fn();
  const endpoint = await createTwoPhaseEndpoint({
    scope,
    target,
    serviceKey,
    review,
    diagnostic: (stage) => stages.push(stage),
    monitor: paneMonitor({ watch: hub.watch, describe }),
    engine: {
      now: () => t0,
      key: Buffer.alloc(32, 4),
      store: {
        load: async () => blob,
        save: async (value: string) => {
          blob = value;
        },
      },
      post: async (url, headers, body) => {
        posts.push({ url, headers, body: JSON.parse(body) });
        return echo(body);
      },
    },
  });
  clean.push(() => endpoint.close());
  return {
    endpoint,
    hub,
    describe,
    posts,
    stages,
    review,
    call: mcp(endpoint.fetch),
    change: (value: PaneTarget) => {
      current = value;
    },
    events: () => posts.filter((p) => p.body.type !== "verification"),
  };
}

type Harness = {
  call: ReturnType<typeof mcp>;
  hub: ReturnType<typeof createRelayHub>;
  events: () => Array<{ url: string; headers: Record<string, string>; body: any }>;
  change: (value: PaneTarget) => void;
  /** Starts monitoring: nothing for the service endpoint, the second consent for two-phase. */
  start: () => Promise<void>;
};
async function serviceHarness(): Promise<Harness> {
  const hub = createRelayHub();
  let current: PaneTarget = target;
  const posts: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const endpoint = await createServiceNotificationEndpoint({
    target,
    keyId: "k",
    serviceKey,
    expiresAt: 700000,
    monitor: paneMonitor({ watch: hub.watch, describe: async () => current }),
    engine: engineBase(
      async (url, headers, body) => {
        posts.push({ url, headers, body: JSON.parse(body) });
        return echo(body);
      },
      () => t0,
    ),
  });
  clean.push(() => endpoint.close());
  return {
    call: mcp(endpoint.fetch),
    hub,
    events: () => posts.filter((p) => p.body.type !== "verification"),
    change: (value) => {
      current = value;
    },
    start: async () => {},
  };
}
async function twoPhaseHarness(): Promise<Harness> {
  const f = await twoPhase();
  return {
    call: f.call,
    hub: f.hub,
    events: f.events,
    change: f.change,
    start: async () => {
      await f.endpoint.activate(approval);
    },
  };
}
async function scenario(f: Harness) {
  const subscribed = await f.call("events/subscribe", params);
  expect(subscribed.json.result.id).toMatch(/^sub_/);
  await f.start();

  f.hub.publish(status("done", t0 + 100));
  await vi.waitFor(() => expect(f.events()).toHaveLength(1));
  const delivered = f.events()[0]!;
  expect(delivered.url).toBe(delivery.url);
  expect(delivered.headers["webhook-signature"]).toMatch(/^v1,/);
  expect(delivered.body).toMatchObject({
    name: "orca.pane_activity",
    data: {
      subscriptionId: digest(subscribed.json.result.id),
      kind: "turn_finished",
      outcome: "unconfirmed",
      freshness: "receipt_only",
      assurance: "pane_only",
    },
  });

  // The same status again is not posted twice; the next distinct one arrives right after it.
  f.hub.publish(status("done", t0 + 100));
  f.hub.publish(status("waiting", t0 + 200));
  await vi.waitFor(() => expect(f.events()).toHaveLength(2));
  expect(f.events().map((p) => p.body.data.kind)).toEqual(["turn_finished", "input_required"]);

  // A replaced PTY (new incarnationId) interrupts monitoring, and monitoring then stops.
  f.change({ ...target, incarnationId: "inc_2" });
  f.hub.publish(status("waiting", t0 + 300));
  await vi.waitFor(() => expect(f.events()).toHaveLength(3));
  expect(f.events()[2]!.body).toMatchObject({
    name: "orca.pane_activity",
    data: { kind: "monitoring_interrupted", reason: "identity_changed", assurance: "pane_only" },
  });
  f.change(target);
  f.hub.publish(status("done", t0 + 400));
  await new Promise((r) => setTimeout(r, 20));
  expect(f.events()).toHaveLength(3);
}
it("end to end (service endpoint): delivered once, then interrupted when the pane is replaced", async () => {
  await scenario(await serviceHarness());
});
it("end to end (two-phase): verified, activated, delivered once, then interrupted", async () => {
  await scenario(await twoPhaseHarness());
});
it("end to end: unsubscribing stops delivery", async () => {
  const f = await serviceHarness();
  await f.call("events/subscribe", params);
  f.hub.publish(status("done", t0 + 100));
  await vi.waitFor(() => expect(f.events()).toHaveLength(1));
  const result = await f.call("events/unsubscribe", {
    name: params.name,
    arguments: target,
    delivery: { mode: "webhook", url: delivery.url },
  });
  expect(result.json).toHaveProperty("result");
  f.hub.publish(status("waiting", t0 + 200));
  await new Promise((r) => setTimeout(r, 20));
  expect(f.events()).toHaveLength(1);
});
it("two-phase verifies once and sends no event before the separate approval", async () => {
  const f = await twoPhase();
  const subscribed = await f.call("events/subscribe", params);
  expect(subscribed.json.result.id).toMatch(/^sub_/);
  expect(f.review).toHaveBeenCalledExactlyOnceWith(delivery.url);
  expect(f.posts.map((p) => p.body.type)).toEqual(["verification"]);
  f.hub.publish(status("done", t0 + 100));
  await new Promise((r) => setTimeout(r, 20));
  expect(f.events()).toHaveLength(0);
  expect(f.describe).toHaveBeenCalledTimes(1);
});

it("two-phase rejects an orca.session_activity subscription against a pane monitor without callback traffic", async () => {
  const f = await twoPhase();
  const rejected = await f.call("events/subscribe", { ...params, name: "orca.session_activity" });
  expect(rejected.json).toHaveProperty("error");
  expect(f.posts).toHaveLength(0);
  expect(f.review).not.toHaveBeenCalled();
  // The first admission is consumed even when it failed.
  expect((await f.call("events/subscribe", params)).json).toHaveProperty("error");
  expect(f.posts).toHaveLength(0);
});

it("two-phase refuses a session-shaped subscription target and a wrong service key", async () => {
  const f = await twoPhase();
  expect(
    (await f.call("events/subscribe", { ...params, arguments: sessionTarget })).json,
  ).toHaveProperty("error");
  expect((await f.call("events/subscribe", params, "wrong")).status).toBe(401);
  expect(f.posts).toHaveLength(0);
});

it("two-phase refuses a pane target for the session monitor and the reverse", async () => {
  const common = {
    scope,
    serviceKey,
    review: vi.fn(),
    engine: engineBase(echoPost, () => t0),
  };
  await expect(
    createTwoPhaseEndpoint({
      ...common,
      target,
      monitor: sessionMonitor({ open: async () => async () => {} }),
    }),
  ).rejects.toThrow();
  await expect(
    createTwoPhaseEndpoint({
      ...common,
      target,
      transport: { open: async () => async () => {}, describe: async () => sessionTarget },
    }),
  ).rejects.toThrow();
  await expect(createTwoPhaseEndpoint({ ...common, target })).rejects.toThrow("monitor_required");
  await expect(
    createTwoPhaseEndpoint({
      ...common,
      scope: { ...scope, targetHash: digest(sessionTarget) },
      target: sessionTarget,
      monitor: paneMonitor({ watch: createRelayHub().watch, describe: async () => target }),
    }),
  ).rejects.toThrow();
});

it("validateVerificationScope parses the target with the supplied parser", () => {
  expect(() => validateVerificationScope(scope, target, t0)).toThrow();
  expect(validateVerificationScope(scope, target, t0, (v) => paneTargetSchema.parse(v))).toEqual(
    scope,
  );
  expect(() =>
    validateVerificationScope(scope, { ...target, incarnationId: "x" }, t0, (v) =>
      paneTargetSchema.parse(v),
    ),
  ).toThrow("verification_scope_invalid");
  expect(() =>
    validateVerificationScope(scope, target, scope.expiresAt - 1000, (v) =>
      paneTargetSchema.parse(v),
    ),
  ).toThrow("verification_scope_invalid");
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
