import { expect, test } from "vite-plus/test";
import { EventEngine, type EngineOptions } from "../src/events/engine.js";
import { createOwnerResolver } from "../src/events/auth.js";
import { eventRpc } from "../src/events/rpc.js";
import { projectObservation, type Target } from "../src/events/model.js";
import {
  callbackUrl,
  createPost,
  equalChallenge,
  EventError,
  headersFor,
  pinCallback,
  publicIPv4,
  signingKey,
  type Reply,
} from "../src/events/webhook.js";
const target: Target = {
  hostId: "host_fixture",
  worktreeId: "w_fixture",
  paneKey: "pane_fixture",
  terminalHandle: "term_fixture",
  sessionId: "session_fixture",
  generation: "generation_1",
};
const key = Buffer.alloc(32, 7),
  secret = `whsec_${key.toString("base64")}`,
  newSecret = `whsec_${Buffer.alloc(32, 8).toString("base64")}`;
const epoch = 1700000000000;
function input(extra: Record<string, unknown> = {}) {
  return {
    name: "orca.turn_finished",
    arguments: target,
    delivery: { mode: "webhook", url: "https://receiver.example.com/events", secret },
    ...extra,
  };
}
function observation(extra: Record<string, unknown> = {}) {
  return {
    target,
    turnId: "turn_fixture",
    transitionId: "transition_fixture",
    occurredAt: epoch,
    state: "done",
    isTurnEnd: true,
    restored: false,
    outcome: "completed",
    ...extra,
  };
}
async function fixture() {
  let clock = epoch,
    blob: string | null = null,
    allowed = true,
    failSave = false;
  let respond: (body: string) => Reply | Promise<Reply> = (body) => ({
    status: 200,
    body: JSON.stringify({ challenge: JSON.parse(body).challenge }),
  });
  const sent: { headers: Record<string, string>; body: string }[] = [];
  const options: EngineOptions = {
    key,
    store: {
      load: async () => blob,
      save: async (v) => {
        if (failSave) throw new Error("synthetic private path");
        blob = v;
      },
    },
    allowedCallbackHosts: ["receiver.example.com"],
    now: () => clock,
    authorize: async () => allowed,
    post: async (_url, headers, body) => {
      sent.push({ headers, body });
      return respond(body);
    },
  };
  return {
    engine: await EventEngine.open(options),
    options,
    sent,
    advance: (ms: number) => {
      clock += ms;
    },
    setReply: (fn: typeof respond) => {
      respond = fn;
    },
    revoke: () => {
      allowed = false;
    },
    sealed: () => blob!,
    failSave: (v: boolean) => {
      failSave = v;
    },
    tamper: () => {
      blob = blob!.slice(0, -8) + "AAAAAAAA";
    },
  };
}
test("session mapping requires occurrence identity and rejects pane reuse, missing proof and uncertain completion", () => {
  const e = projectObservation(observation(), target, epoch)!;
  expect(e.name).toBe("orca.turn_finished");
  expect(e.data).not.toHaveProperty("text");
  expect(
    projectObservation(
      { worktreeId: target.worktreeId, paneKey: target.paneKey, state: "done", receivedAt: epoch },
      target,
      epoch,
    ),
  ).toBeNull();
  for (const k of Object.keys(target) as (keyof Target)[])
    expect(
      projectObservation(observation({ target: { ...target, [k]: "other" } }), target, epoch),
    ).toBeNull();
  for (const patch of [
    { turnId: undefined },
    { transitionId: undefined },
    { restored: true },
    { isTurnEnd: false },
    { outcome: "unconfirmed" },
    { outcome: "interruption" },
    { state: "working" },
    { occurredAt: epoch + 6000 },
  ])
    expect(projectObservation(observation(patch), target, epoch)).toBeNull();
  expect(
    projectObservation(observation({ state: "waiting", isTurnEnd: false }), target, epoch)?.name,
  ).toBe("orca.input_waiting");
  expect(
    projectObservation(observation({ state: "blocked", isTurnEnd: false }), target, epoch)?.name,
  ).toBe("orca.input_waiting");
});
test("Standard Webhooks signature matches independent HMAC vector and binds exact bytes/time", () => {
  const body = '{"value":"synthetic"}';
  const headers = headersFor("evt_fixture", "sub_fixture", body, [secret], epoch);
  expect(headers["webhook-signature"]).toBe("v1,TvdafXpi/9d5xup5XXUg5Gwkx5DxKDZu4ESo5PuC34I=");
  expect(
    headersFor("evt_fixture", "sub_fixture", body + " ", [secret], epoch)["webhook-signature"],
  ).not.toBe(headers["webhook-signature"]);
  expect(
    headersFor("evt_fixture", "sub_fixture", body, [secret], epoch + 1000)["webhook-signature"],
  ).not.toBe(headers["webhook-signature"]);
  expect(() => headersFor("e", "s", "x".repeat(262145), [secret], epoch)).toThrow("payload_limit");
  for (const s of [
    "bad",
    `whsec_${Buffer.alloc(23).toString("base64")}`,
    `whsec_${Buffer.alloc(65).toString("base64")}`,
    secret.slice(0, -1),
  ])
    expect(() => signingKey(s)).toThrow("invalid_secret");
  expect(equalChallenge("abc", "abc")).toBe(true);
  expect(equalChallenge("abd", "abc")).toBe(false);
  expect(equalChallenge(null, "abc")).toBe(false);
});
test("callback policy blocks local/special destinations, credentials, redirects and DNS rebinding", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "172.31.0.1",
    "192.168.1.1",
    "192.0.0.8",
    "192.0.2.1",
    "192.88.99.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::ffff:127.0.0.1",
    "2001:4860:4860::8888",
  ])
    expect(publicIPv4(ip)).toBe(false);
  for (const url of [
    "http://receiver.example.com/x",
    "https://receiver.example.com:8443/x",
    "https://a:b@receiver.example.com/x",
    "https://receiver.example.com/x#secret",
    "https://other.example.com/x",
    "https://127.0.0.1/x",
  ])
    expect(() => callbackUrl(url, ["receiver.example.com"])).toThrow();
  await expect(
    pinCallback("https://receiver.example.com/x", ["receiver.example.com"], async () => [
      "93.184.216.34",
      "10.0.0.1",
    ]),
  ).rejects.toThrow("callback_rejected");
  let resolves = 0,
    calls = 0;
  const post = createPost(
    ["receiver.example.com"],
    async () => [++resolves === 1 ? "93.184.216.34" : "127.0.0.1"],
    async (p) => {
      calls++;
      expect(p).toEqual({
        hostname: "receiver.example.com",
        address: "93.184.216.34",
        path: "/x?a=1",
      });
      return { status: 200, body: "{}" };
    },
  );
  await post("https://receiver.example.com/x?a=1", {}, "{}");
  await expect(post("https://receiver.example.com/x?a=1", {}, "{}")).rejects.toThrow(
    "callback_rejected",
  );
  expect(calls).toBe(1);
  const redirected = createPost(
    ["receiver.example.com"],
    async () => ["93.184.216.34"],
    async () => ({ status: 302, body: "" }),
  );
  await expect(redirected("https://receiver.example.com/x", {}, "{}")).rejects.toThrow(
    "redirect_rejected",
  );
});
test("verification must echo a fresh challenge within deadline; no subscription after failure", async () => {
  for (const kind of ["mismatch", "expired", "redirect"]) {
    const f = await fixture();
    f.setReply((body) => {
      if (kind === "expired") f.advance(10001);
      return {
        status: kind === "redirect" ? 302 : 200,
        body: JSON.stringify({
          challenge: kind === "mismatch" ? "wrong" : JSON.parse(body).challenge,
        }),
      };
    });
    await expect(f.engine.subscribe("owner", input())).rejects.toThrow(
      "callback_verification_failed",
    );
    expect(await f.engine.ingest(observation())).toEqual({ queued: 0, duplicate: 0, rejected: 0 });
  }
});
test("idempotent subscription identity, owner separation, finite ttl and bounded verification cache", async () => {
  const f = await fixture();
  const first = await f.engine.subscribe("owner", input({ ttlMs: 1000 }));
  const reordered = Object.fromEntries(Object.entries(target).reverse());
  expect((await f.engine.subscribe("owner", input({ arguments: reordered }))).id).toBe(first.id);
  expect(f.sent).toHaveLength(1);
  f.advance(30000);
  await f.engine.subscribe("owner", input());
  f.advance(30001);
  await f.engine.subscribe("owner", input());
  expect(f.sent).toHaveLength(2);
  expect((await f.engine.subscribe("other", input())).id).not.toBe(first.id);
  await expect(f.engine.unsubscribe("other", first.id)).rejects.toThrow("subscription_not_found");
  await f.engine.unsubscribe("owner", first.id);
  const sub = await f.engine.subscribe("owner", input({ ttlMs: null }));
  expect(sub.refreshBefore).not.toBeNull();
});
test("encrypted persistence survives restart, deduplicates delivery and rejects tampering/wrong key", async () => {
  const f = await fixture();
  await f.engine.subscribe("owner", input());
  expect(await f.engine.ingest(observation())).toMatchObject({ queued: 1 });
  expect(f.sealed()).not.toContain(secret);
  expect(f.sealed()).not.toContain("receiver");
  const restarted = await EventEngine.open(f.options);
  expect(await restarted.ingest(observation())).toMatchObject({ duplicate: 1 });
  expect(await restarted.deliver()).toMatchObject({ accepted: 1 });
  expect(await restarted.ingest(observation())).toMatchObject({ duplicate: 1 });
  await expect(EventEngine.open({ ...f.options, key: Buffer.alloc(32, 9) })).rejects.toThrow(
    "state_unavailable",
  );
  f.tamper();
  await expect(EventEngine.open(f.options)).rejects.toThrow("state_unavailable");
});
test("retry retains event bytes/id, refreshes signature timestamp, bounds attempts and respects terminal status", async () => {
  const f = await fixture();
  await f.engine.subscribe("owner", input());
  await f.engine.ingest(observation());
  f.setReply(() => ({ status: 503, body: "" }));
  expect(await f.engine.deliver()).toMatchObject({ retried: 1 });
  expect(await f.engine.deliver()).toMatchObject({ retried: 0 });
  for (let i = 0; i < 4; i++) {
    f.advance(60000);
    await f.engine.deliver();
  }
  expect(f.sent).toHaveLength(6);
  f.advance(60000);
  await f.engine.deliver();
  expect(f.sent).toHaveLength(6);
  expect(f.sent[1]!.body).toBe(f.sent[2]!.body);
  expect(f.sent[1]!.headers["webhook-id"]).toBe(f.sent[2]!.headers["webhook-id"]);
  expect(f.sent[1]!.headers["webhook-timestamp"]).not.toBe(f.sent[2]!.headers["webhook-timestamp"]);
  for (const status of [410, 413, 401, 403, 400]) {
    const g = await fixture();
    await g.engine.subscribe("owner", input());
    await g.engine.ingest(observation());
    g.setReply(() => ({ status, body: "" }));
    expect(await g.engine.deliver()).toMatchObject({ stopped: 1 });
    g.advance(60000);
    await g.engine.deliver();
    expect(g.sent).toHaveLength(2);
  }
});
test("expiry, unsubscribe and revocation stop queued delivery", async () => {
  for (const kind of ["expiry", "unsubscribe", "revoke"]) {
    const f = await fixture();
    const sub = await f.engine.subscribe("owner", input({ ttlMs: 1000 }));
    await f.engine.ingest(observation());
    if (kind === "expiry") f.advance(1000);
    else if (kind === "unsubscribe") await f.engine.unsubscribe("owner", sub.id);
    else f.revoke();
    await f.engine.deliver();
    expect(f.sent).toHaveLength(1);
  }
});
test("key rotation dual-signs only during its bounded overlap", async () => {
  const f = await fixture();
  await f.engine.subscribe("owner", input());
  await f.engine.ingest(observation());
  await f.engine.subscribe(
    "owner",
    input({
      delivery: { mode: "webhook", url: "https://receiver.example.com/events", secret: newSecret },
    }),
  );
  await f.engine.deliver();
  expect(f.sent[2]!.headers["webhook-signature"]!.split(" ")).toHaveLength(2);
  f.advance(60001);
  await f.engine.ingest(observation({ transitionId: "next", occurredAt: epoch + 60001 }));
  await f.engine.deliver();
  expect(f.sent[3]!.headers["webhook-signature"]!.split(" ")).toHaveLength(1);
});
test("storm limits are explicit and concurrent ingestion cannot duplicate an event", async () => {
  const f = await fixture();
  await f.engine.subscribe("owner", input());
  const pair = await Promise.all([f.engine.ingest(observation()), f.engine.ingest(observation())]);
  expect(pair.map((x) => x.queued).reduce((a, b) => a + b)).toBe(1);
  let rejected = 0;
  for (let i = 1; i <= 30; i++)
    rejected += (await f.engine.ingest(observation({ transitionId: `t_${i}` }))).rejected;
  expect(rejected).toBe(15);
  await f.engine.deliver();
  expect(f.sent).toHaveLength(17);
});
test("failed persistence never permits delivery from unsaved queue state", async () => {
  const f = await fixture();
  await f.engine.subscribe("owner", input());
  f.failSave(true);
  await expect(f.engine.ingest(observation())).rejects.toThrow("state_unavailable");
  f.failSave(false);
  await f.engine.deliver();
  expect(f.sent).toHaveLength(1);
  await f.engine.ingest(observation());
  f.failSave(true);
  await expect(f.engine.deliver()).rejects.toThrow("state_unavailable");
  expect(f.sent).toHaveLength(1);
});
test("RPC takes owner only from verified transport auth; wrong audience, expiration and spoofed params fail", async () => {
  const f = await fixture();
  let valid = true;
  const resolve = createOwnerResolver(
    "https://issuer.example.com",
    "orca-events",
    async (token) =>
      token === "synthetic" && valid
        ? {
            issuer: "https://issuer.example.com",
            subject: "fixture",
            audience: ["orca-events"],
            expiresAt: epoch + 1000,
            scopes: ["orca:events"],
          }
        : null,
    () => epoch,
  );
  const rpc = eventRpc(f.engine, resolve);
  await expect(rpc("events/list", {}, undefined)).rejects.toMatchObject({ code: -32000 });
  expect(await rpc("events/list", {}, "Bearer synthetic")).toHaveProperty("events");
  await expect(
    rpc("events/subscribe", { ...input(), owner: "spoofed" }, "Bearer synthetic"),
  ).rejects.toMatchObject({ code: -32602 });
  await rpc("events/subscribe", input(), "Bearer synthetic");
  valid = false;
  await expect(rpc("events/list", {}, "Bearer synthetic")).rejects.toMatchObject({ code: -32000 });
  for (const patch of [
    { issuer: "other" },
    { audience: ["other"] },
    { expiresAt: epoch },
    { scopes: [] },
  ]) {
    const check = createOwnerResolver(
      "issuer",
      "audience",
      async () => ({
        issuer: "issuer",
        subject: "fixture",
        audience: ["audience"],
        expiresAt: epoch + 1000,
        scopes: ["orca:events"],
        ...patch,
      }),
      () => epoch,
    );
    await expect(check("Bearer synthetic")).rejects.toThrow("unauthorized");
  }
  f.setReply(() => {
    throw new EventError("synthetic_private_detail");
  });
  await expect(
    eventRpc(f.engine, async () => "owner")("events/subscribe", input(), "Bearer synthetic"),
  ).rejects.toMatchObject({ code: -32015, data: { reason: "challenge_failed" } });
});

test("protocol unsubscribe uses original identity, is idempotent and cannot remove another owner", async () => {
  const f = await fixture();
  const rpc = eventRpc(f.engine, async (auth) => {
    if (!auth) throw new EventError("unauthorized");
    return auth;
  });
  await rpc("events/subscribe", input(), "owner");
  await f.engine.ingest(observation());
  const stop = {
    name: "orca.turn_finished",
    arguments: target,
    delivery: { mode: "webhook", url: "https://receiver.example.com/events" },
  };
  expect(await rpc("events/unsubscribe", stop, "other")).toEqual({});
  expect(await f.engine.deliver()).toMatchObject({ accepted: 1 });
  expect(await rpc("events/unsubscribe", stop, "owner")).toEqual({});
  expect(await rpc("events/unsubscribe", stop, "owner")).toEqual({});
  expect(await f.engine.ingest(observation({ transitionId: "after_stop" }))).toMatchObject({
    queued: 0,
  });
});
test("out-of-order source events retain occurrence time; event filters exclude other names and old history", async () => {
  const f = await fixture();
  await f.engine.subscribe("owner", input({ name: "orca.input_waiting" }));
  expect(await f.engine.ingest(observation())).toMatchObject({ queued: 0 });
  expect(
    await f.engine.ingest(observation({ state: "waiting", occurredAt: epoch - 1 })),
  ).toMatchObject({ queued: 0 });
  f.advance(3000);
  await f.engine.ingest(
    observation({ state: "waiting", occurredAt: epoch + 2000, transitionId: "second" }),
  );
  await f.engine.ingest(
    observation({ state: "blocked", occurredAt: epoch + 1000, transitionId: "first" }),
  );
  await f.engine.deliver();
  expect(f.sent).toHaveLength(3);
  expect(JSON.parse(f.sent[1]!.body).timestamp).toBe(new Date(epoch + 2000).toISOString());
  expect(JSON.parse(f.sent[2]!.body).timestamp).toBe(new Date(epoch + 1000).toISOString());
});
test("Node HTTPS sender pins lookup and TLS hostname, enforces timeout and never follows redirect", async () => {
  const { EventEmitter } = await import("node:events");
  const { createNodePinnedSend } = await import("../src/events/webhook.js");
  type Request = typeof import("node:https").request;
  let count = 0;
  const fake = ((
    options: import("node:https").RequestOptions,
    callback: (response: unknown) => void,
  ) => {
    count++;
    expect(options).toMatchObject({
      hostname: "receiver.example.com",
      servername: "receiver.example.com",
      agent: false,
      rejectUnauthorized: true,
      family: 4,
      port: 443,
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    const resolve = options.lookup as (
      h: string,
      o: object,
      cb: (e: unknown, a: string, f: number) => void,
    ) => void;
    resolve("receiver.example.com", {}, (_e, address, family) => {
      expect(address).toBe("93.184.216.34");
      expect(family).toBe(4);
    });
    const req = new EventEmitter() as import("node:events").EventEmitter & {
      end: (b: string) => void;
    };
    req.end = () => {
      const response = Object.assign(new EventEmitter(), { statusCode: 302 });
      callback(response);
      queueMicrotask(() => response.emit("end"));
    };
    return req;
  }) as unknown as Request;
  const post = createPost(
    ["receiver.example.com"],
    async () => ["93.184.216.34"],
    createNodePinnedSend(fake),
  );
  await expect(post("https://receiver.example.com/x", {}, "{}")).rejects.toThrow(
    "redirect_rejected",
  );
  expect(count).toBe(1);
});
