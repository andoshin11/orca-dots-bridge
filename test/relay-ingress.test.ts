import { createHmac, randomUUID, webcrypto } from "node:crypto";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { createRelayIngress, createRelayServer } from "../src/events/relay-ingress.js";
import { diagnosticStages, type DiagnosticStage } from "../src/events/preflight-diagnostics.js";

const key = Buffer.alloc(32, 7);
const nowMs = 1791417600000;
const status = {
  type: "agent.status.changed",
  kind: "done",
  worktreeId: "wt_fixture",
  paneKey: "tab_1:leaf_1",
  tabId: "tab_1",
  leafId: "leaf_1",
  state: "done",
  mainAgent: { state: "done", stateStartedAt: nowMs - 1000 },
  receivedAt: nowMs,
};

/** Mirrors orca-agent-status-relay src/sign.mjs: `msg_<uuid>`, whole seconds, `v1,` + base64 HMAC. */
function sign(message: unknown, options: { id?: string; seconds?: number; key?: Buffer } = {}) {
  const id = options.id ?? `msg_${randomUUID()}`;
  const timestamp = String(options.seconds ?? Math.floor(nowMs / 1000));
  const body = JSON.stringify(message);
  const signature = createHmac("sha256", options.key ?? key)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return {
    body,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
    } as IncomingHttpHeaders,
  };
}
function ingressFixture(now = () => nowMs) {
  const onStatus = vi.fn();
  const stages: DiagnosticStage[] = [];
  const ingress = createRelayIngress({
    key,
    onStatus,
    now,
    diagnostic: (stage) => stages.push(stage),
  });
  return { ingress, onStatus, stages };
}

it("computes the Standard Webhooks signature the same way as an independent WebCrypto implementation", async () => {
  const id = "msg_vector",
    seconds = 1791417600,
    body = JSON.stringify({ type: "relay.test", sentAt: nowMs });
  const independent = await webcrypto.subtle.importKey(
    "raw",
    new Uint8Array(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = Buffer.from(
    await webcrypto.subtle.sign(
      "HMAC",
      independent,
      Buffer.from(`${id}.${seconds}.${body}`, "utf8"),
    ),
  ).toString("base64");
  // Same value computed once with `openssl dgst -sha256 -mac HMAC` over `<id>.<timestamp>.<body>`.
  expect(expected).toBe("EHsWymUf6WJKrzv5XAQcQx8eEVPQCgFsFQHnzPVyfGA=");
  const signed = sign({ type: "relay.test", sentAt: nowMs }, { id, seconds });
  expect(signed.headers["webhook-signature"]).toBe(`v1,${expected}`);
  const f = ingressFixture();
  expect(f.ingress.accept(signed.headers, signed.body)).toBe(204);
});

it("requires a 32-byte key (the 24-byte Standard Webhooks sample key is refused)", () => {
  const onStatus = vi.fn();
  expect(() =>
    createRelayIngress({
      key: Buffer.from("MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "base64"),
      onStatus,
    }),
  ).toThrow("invalid_relay_key");
  expect(() => createRelayIngress({ key: Buffer.alloc(31), onStatus })).toThrow(
    "invalid_relay_key",
  );
  expect(() => createRelayIngress({ key: Buffer.alloc(33), onStatus })).toThrow(
    "invalid_relay_key",
  );
});

it("accepts a signed status once, passes the parsed status on and reports diagnostics", () => {
  const f = ingressFixture();
  const { headers, body } = sign(status);
  expect(f.ingress.accept(headers, body)).toBe(204);
  expect(f.onStatus).toHaveBeenCalledExactlyOnceWith(status);
  expect(f.stages).toEqual(["relay_arrived", "relay_status_received"]);
  for (const stage of f.stages) expect(diagnosticStages).toContain(stage);
});

it("acknowledges relay.test without calling onStatus", () => {
  const f = ingressFixture();
  const { headers, body } = sign({ type: "relay.test", sentAt: nowMs });
  expect(f.ingress.accept(headers, body)).toBe(204);
  expect(f.onStatus).not.toHaveBeenCalled();
  expect(f.stages).toEqual(["relay_arrived", "relay_test_received"]);
});

it("signs the exact UTF-8 body string", () => {
  const f = ingressFixture();
  const { headers, body } = sign({ ...status, worktreeId: "wt_日本語" });
  expect(f.ingress.accept(headers, body)).toBe(204);
  expect(f.onStatus).toHaveBeenCalledOnce();
  const other = sign({ ...status, worktreeId: "wt_日本語" }, { id: "msg_other" });
  expect(f.ingress.accept(other.headers, other.body + " ")).toBe(401);
});

it.each(["webhook-id", "webhook-timestamp", "webhook-signature"])(
  "rejects a missing %s header with 401",
  (name) => {
    const f = ingressFixture();
    const { headers, body } = sign(status);
    delete headers[name];
    expect(f.ingress.accept(headers, body)).toBe(401);
    expect(f.onStatus).not.toHaveBeenCalled();
    expect(f.stages).toEqual(["relay_signature_rejected"]);
  },
);

it.each([
  ["empty id", { "webhook-id": "" }],
  ["oversized id", { "webhook-id": "m".repeat(257) }],
  ["non-numeric timestamp", { "webhook-timestamp": "1791417600.5" }],
  ["signed timestamp", { "webhook-timestamp": "-1791417600" }],
  ["empty timestamp", { "webhook-timestamp": "" }],
  ["13 digit timestamp", { "webhook-timestamp": "1791417600000" }],
  ["array header", { "webhook-id": ["a", "b"] }],
])("rejects malformed headers: %s", (_name, override) => {
  const f = ingressFixture();
  const { headers, body } = sign(status);
  expect(f.ingress.accept({ ...headers, ...override }, body)).toBe(401);
  expect(f.onStatus).not.toHaveBeenCalled();
});

it("enforces the 300 second timestamp window in both directions", () => {
  const seconds = Math.floor(nowMs / 1000);
  for (const [offset, expected] of [
    [-300, 204],
    [300, 204],
    [-301, 401],
    [301, 401],
  ] as const) {
    const f = ingressFixture();
    const { headers, body } = sign(status, { seconds: seconds + offset });
    expect(f.ingress.accept(headers, body)).toBe(expected);
    expect(f.onStatus).toHaveBeenCalledTimes(expected === 204 ? 1 : 0);
  }
});

it("rejects a wrong key, a changed id, a changed timestamp and a changed body", () => {
  const f = ingressFixture();
  const good = sign(status);
  const wrongKey = sign(status, { key: Buffer.alloc(32, 8) });
  expect(f.ingress.accept(wrongKey.headers, wrongKey.body)).toBe(401);
  expect(f.ingress.accept({ ...good.headers, "webhook-id": "msg_changed" }, good.body)).toBe(401);
  expect(
    f.ingress.accept(
      { ...good.headers, "webhook-timestamp": String(Math.floor(nowMs / 1000) + 1) },
      good.body,
    ),
  ).toBe(401);
  expect(f.ingress.accept(good.headers, good.body.replace("done", "wait"))).toBe(401);
  expect(f.onStatus).not.toHaveBeenCalled();
  expect(f.stages.filter((s) => s === "relay_signature_rejected")).toHaveLength(4);
});

it.each([
  [
    "a later valid entry after a bad one",
    (good: string) => `v1,${Buffer.alloc(32).toString("base64")} ${good}`,
  ],
  ["a bad entry after the valid one", (good: string) => `${good} v1,bad`],
  ["the literal v1,bad v1,good shape", (good: string) => `v1,bad ${good}`],
])("accepts a multi-signature header with %s", (_name, build) => {
  const f = ingressFixture();
  const { headers, body } = sign(status);
  headers["webhook-signature"] = build(headers["webhook-signature"] as string);
  expect(f.ingress.accept(headers, body)).toBe(204);
});

it.each([
  ["only bad entries", () => "v1,bad v1,worse"],
  ["unknown version", (good: string) => good.replace("v1,", "v2,")],
  ["empty value", () => "v1,"],
  ["no version separator", (good: string) => good.slice(3)],
  ["truncated signature", (good: string) => good.slice(0, -8)],
  ["empty header", () => ""],
])("rejects a signature header with %s", (_name, build) => {
  const f = ingressFixture();
  const { headers, body } = sign(status);
  headers["webhook-signature"] = build(headers["webhook-signature"] as string);
  expect(f.ingress.accept(headers, body)).toBe(401);
  expect(f.onStatus).not.toHaveBeenCalled();
});

it("answers 409 for a replayed webhook-id and does not deliver it again", () => {
  const f = ingressFixture();
  const { headers, body } = sign(status);
  expect(f.ingress.accept(headers, body)).toBe(204);
  expect(f.ingress.accept(headers, body)).toBe(409);
  expect(f.onStatus).toHaveBeenCalledOnce();
  expect(f.stages).toContain("relay_replay_rejected");
  // A different message with a fresh id is unaffected.
  const next = sign(status);
  expect(f.ingress.accept(next.headers, next.body)).toBe(204);
  expect(f.onStatus).toHaveBeenCalledTimes(2);
});

it("does not treat a forged replay as a replay (signature is checked first)", () => {
  const f = ingressFixture();
  const { headers, body } = sign(status);
  expect(f.ingress.accept(headers, body)).toBe(204);
  expect(f.ingress.accept(headers, body + " ")).toBe(401);
});

it("forgets an id once its tolerance window has passed", () => {
  let clock = nowMs;
  const f = ingressFixture(() => clock);
  const id = "msg_reused";
  const first = sign(status, { id });
  expect(f.ingress.accept(first.headers, first.body)).toBe(204);
  clock += 301_000;
  // Expired entries are purged when the next message is remembered.
  const other = sign(status, { seconds: Math.floor(clock / 1000) });
  expect(f.ingress.accept(other.headers, other.body)).toBe(204);
  const later = sign(status, { id, seconds: Math.floor(clock / 1000) });
  expect(f.ingress.accept(later.headers, later.body)).toBe(204);
  expect(f.onStatus).toHaveBeenCalledTimes(3);
});

it("answers 429 instead of growing the replay memory without bound", () => {
  const f = ingressFixture();
  let last = 0;
  for (let i = 0; i < 4097; i++) {
    const { headers, body } = sign({ type: "relay.test", sentAt: nowMs }, { id: `msg_${i}` });
    last = f.ingress.accept(headers, body);
    if (i < 4096) expect(last).toBe(204);
  }
  expect(last).toBe(429);
});

it.each([
  ["invalid JSON", "{not json"],
  ["a JSON string", '"hello"'],
  ["an unknown type", JSON.stringify({ type: "other" })],
  ["an extra property", JSON.stringify({ ...status, text: "secret" })],
  ["a missing field", JSON.stringify({ ...status, paneKey: undefined })],
  ["an unknown kind", JSON.stringify({ ...status, kind: "idle" })],
  ["an extra property on relay.test", JSON.stringify({ type: "relay.test", sentAt: 1, x: 1 })],
  ["a negative receivedAt", JSON.stringify({ ...status, receivedAt: -1 })],
])("answers 400 for a correctly signed message with %s", (_name, raw) => {
  const f = ingressFixture();
  const id = "msg_bad_body",
    timestamp = String(Math.floor(nowMs / 1000));
  const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${raw}`).digest("base64");
  expect(
    f.ingress.accept(
      { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` },
      raw,
    ),
  ).toBe(400);
  expect(f.onStatus).not.toHaveBeenCalled();
  expect(f.stages).toContain("relay_schema_rejected");
});

it("accepts a status with null worktree/tab/leaf/mainAgent and an optional outcome", () => {
  const f = ingressFixture();
  const minimal = { ...status, worktreeId: null, tabId: null, leafId: null, mainAgent: null };
  const a = sign(minimal);
  expect(f.ingress.accept(a.headers, a.body)).toBe(204);
  const b = sign({ ...status, mainAgent: { state: "done", outcome: "ok", stateStartedAt: 1 } });
  expect(f.ingress.accept(b.headers, b.body)).toBe(204);
  expect(f.onStatus).toHaveBeenCalledTimes(2);
});

// ---- HTTP listener ----

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function freePort() {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
async function listen(ingress: Parameters<typeof createRelayServer>[1]) {
  const port = await freePort();
  const stages: DiagnosticStage[] = [];
  const server = createRelayServer(port, ingress, (stage) => stages.push(stage));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { port, stages };
}
function send(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
) {
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "POST",
        path: options.path ?? "/relay",
        headers: { host: `127.0.0.1:${port}`, ...options.headers },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

it("serves POST /relay on loopback and returns the ingress status", async () => {
  const accept = vi.fn((_headers: IncomingHttpHeaders, _body: string) => 204);
  const { port } = await listen({ accept });
  expect(await send(port, { body: '{"a":"日本語"}', headers: { "webhook-id": "x" } })).toBe(204);
  expect(accept).toHaveBeenCalledOnce();
  expect(accept.mock.calls[0]![0]["webhook-id"]).toBe("x");
  expect(accept.mock.calls[0]![1]).toBe('{"a":"日本語"}');
  accept.mockReturnValueOnce(409);
  expect(await send(port, { body: "{}" })).toBe(409);
});

it("verifies a real signed request end to end through the listener", async () => {
  const f = ingressFixture();
  const { port } = await listen(f.ingress);
  const { headers, body } = sign(status);
  expect(await send(port, { headers: headers as Record<string, string>, body })).toBe(204);
  expect(f.onStatus).toHaveBeenCalledExactlyOnceWith(status);
  expect(await send(port, { headers: headers as Record<string, string>, body })).toBe(409);
});

it.each([
  ["a foreign Host", { host: "127.0.0.1:1" }],
  ["a hostname instead of the loopback address", { host: "localhost" }],
  ["a Host without the port", { host: "127.0.0.1" }],
  ["an Origin header", { origin: "https://example.com" }],
])("answers 403 without calling the ingress for %s", async (_name, headers) => {
  const accept = vi.fn(() => 204);
  const { port, stages } = await listen({ accept });
  expect(await send(port, { headers, body: "{}" })).toBe(403);
  expect(accept).not.toHaveBeenCalled();
  expect(stages).toContain("http_boundary_rejected");
});

it.each([
  ["GET /relay", { method: "GET", path: "/relay" }],
  ["PUT /relay", { method: "PUT", path: "/relay" }],
  ["POST /", { path: "/" }],
  ["POST /relay/", { path: "/relay/" }],
  ["POST /relay?x=1", { path: "/relay?x=1" }],
  ["POST /mcp", { path: "/mcp" }],
] as Array<[string, { method?: string; path: string }]>)(
  "answers 404 for %s",
  async (_name, options) => {
    const accept = vi.fn(() => 204);
    const { port, stages } = await listen({ accept });
    expect(
      await send(port, { ...options, body: options.method === "GET" ? undefined : "{}" }),
    ).toBe(404);
    expect(accept).not.toHaveBeenCalled();
    expect(stages).toContain("http_route_rejected");
  },
);

it("accepts a body of exactly 64 KiB and answers 413 above it", async () => {
  const accept = vi.fn(() => 204);
  const { port, stages } = await listen({ accept });
  expect(await send(port, { body: "x".repeat(65536) })).toBe(204);
  expect(accept).toHaveBeenCalledOnce();
  expect(await send(port, { body: "x".repeat(65537) }).catch(() => 413)).toBe(413);
  expect(accept).toHaveBeenCalledOnce();
  expect(stages).toContain("http_body_limit");
});

it("answers 500 and records http_exception when the ingress throws", async () => {
  const { port, stages } = await listen({
    accept: () => {
      throw new Error("boom");
    },
  });
  expect(await send(port, { body: "{}" })).toBe(500);
  expect(stages).toContain("http_exception");
});
