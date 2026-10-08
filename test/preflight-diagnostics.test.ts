import { afterEach, expect, it, vi } from "vitest";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPreflightDiagnostics,
  diagnosticStages,
  type DiagnosticStage,
} from "../src/events/preflight-diagnostics.js";
import { createCallbackPreflight } from "../src/events/callback-preflight.js";
import { createLoopbackServer } from "../src/events/loopback-server.js";
import { request as httpRequest } from "node:http";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const target = {
  executionHostId: "local",
  worktreeId: "fixture-private",
  terminalHandle: "term_fixture",
  paneKey: "pane",
  incarnationId: "generation",
  launchId: "launch",
  providerSessionId: "session",
};
const key = Buffer.alloc(32, 7);
const params = {
  name: "orca.session_activity",
  arguments: target,
  delivery: {
    mode: "webhook",
    url: "https://receiver.example.com/private-path?secret=never-record",
    secret: `whsec_${Buffer.alloc(32, 8).toString("base64")}`,
  },
  cursor: null,
};
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "synthetic-diagnostics-"));
  directories.push(directory);
  chmodSync(directory, 0o700);
  const path = join(directory, "preflight-diagnostics.json");
  const diagnostic = createPreflightDiagnostics(path);
  const review = vi.fn();
  let now = 100000;
  const endpoint = createCallbackPreflight({
    target,
    serviceKey: key,
    expiresAt: 700000,
    now: () => now,
    review,
    diagnostic,
  });
  const snapshot = () => JSON.parse(readFileSync(path, "utf8"));
  async function send(
    method: string,
    input: unknown = {},
    options: { auth?: string; version?: string; body?: string } = {},
  ) {
    const body =
      options.body ??
      JSON.stringify({
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
      });
    return endpoint.fetch(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: options.auth ?? `Bearer ${key.toString("base64url")}`,
          "MCP-Protocol-Version": options.version ?? "2026-07-28",
          "Mcp-Method": method,
        },
        body,
      }),
    );
  }
  return {
    directory,
    path,
    diagnostic,
    endpoint,
    review,
    snapshot,
    send,
    expire: () => {
      now = 700000;
    },
  };
}
it("persists fixed-only counters atomically, rejects overwrites, symlinks and non-private storage", () => {
  const f = fixture();
  f.diagnostic("running");
  f.diagnostic("method_subscribe");
  f.diagnostic("stopped");
  const saved = f.snapshot();
  expect(Object.keys(saved).sort()).toEqual(["counts", "lastStage", "sequence", "version"]);
  expect(saved.counts.method_subscribe).toBe(1);
  expect(saved.lastStage).toBe("stopped");
  expect(Object.keys(saved.counts)).toEqual([...diagnosticStages]);
  expect(lstatSync(f.path).mode & 0o777).toBe(0o600);
  expect(readdirSync(f.directory)).toEqual(["preflight-diagnostics.json"]);
  expect(() => createPreflightDiagnostics(f.path)).toThrow("diagnostics_unavailable");
  const link = join(f.directory, "link.json");
  symlinkSync(f.path, link);
  expect(() => createPreflightDiagnostics(link)).toThrow("diagnostics_unavailable");
  chmodSync(f.directory, 0o755);
  expect(() => createPreflightDiagnostics(join(f.directory, "another.json"))).toThrow(
    "diagnostics_unavailable",
  );
});
it("records authentication, method and protocol failures without retaining untrusted values", async () => {
  const f = fixture();
  expect(
    (await f.send("events/subscribe", params, { auth: "Bearer private-never-record" })).status,
  ).toBe(401);
  await f.send("events/list");
  await f.send("events/subscribe", params, { version: "1900-01-01" });
  await f.send("private-method-never-record", {});
  await f.send("events/subscribe", {}, { body: "invalid-private-json" });
  expect(f.snapshot().counts.auth_rejected).toBe(1);
  expect(f.snapshot().counts.method_events_list).toBe(1);
  expect(f.snapshot().counts.version_other).toBe(1);
  expect(f.snapshot().counts.protocol_without_dispatch).toBeGreaterThan(0);
  expect(f.snapshot().counts.json_invalid).toBe(1);
  f.expire();
  expect((await f.send("events/list")).status).toBe(401);
  f.endpoint.close();
  expect((await f.send("events/list")).status).toBe(401);
  const text = readFileSync(f.path, "utf8");
  for (const secret of [
    "private-never-record",
    "private-method",
    "invalid-private",
    key.toString("base64url"),
    params.delivery.secret,
    params.delivery.url,
    target.worktreeId,
  ])
    expect(text).not.toContain(secret);
});
it("distinguishes every preflight rejection and records only one review", async () => {
  const f = fixture();
  const cases: [string, unknown, DiagnosticStage][] = [
    ["events/list", { cursor: "private-cursor" }, "list_schema_rejected"],
    ["events/unsubscribe", {}, "method_rejected"],
    ["events/subscribe", { ...params, privateExtra: "never-record" }, "schema_extra"],
    ["events/subscribe", { ...params, name: "private-name" }, "schema_name"],
    ["events/subscribe", { ...params, arguments: {} }, "schema_arguments"],
    ["events/subscribe", { ...params, delivery: {} }, "schema_delivery"],
    ["events/subscribe", { ...params, ttlMs: "private-ttl" }, "schema_ttl"],
    ["events/subscribe", { ...params, cursor: "private-cursor" }, "schema_cursor"],
    ["events/subscribe", { ...params, name: "orca.turn_finished" }, "event_name_rejected"],
    [
      "events/subscribe",
      {
        ...params,
        arguments: {
          hostId: "host",
          worktreeId: "work",
          paneKey: "pane",
          terminalHandle: "term_test",
          sessionId: "session",
          generation: "gen",
        },
      },
      "target_schema_rejected",
    ],
    [
      "events/subscribe",
      { ...params, delivery: { ...params.delivery, secret: "private-invalid" } },
      "signing_key_rejected",
    ],
    [
      "events/subscribe",
      { ...params, delivery: { ...params.delivery, url: "http://receiver.example.com" } },
      "callback_syntax_rejected",
    ],
    [
      "events/subscribe",
      { ...params, arguments: { ...target, launchId: "changed" } },
      "target_mismatch",
    ],
  ];
  for (const [method, input, stage] of cases) {
    const before = f.snapshot().counts[stage];
    await f.send(method, input);
    expect(f.snapshot().counts[stage], stage).toBe(before + 1);
    expect(f.review).not.toHaveBeenCalled();
  }
  await f.send("events/subscribe", params);
  await f.send("events/subscribe", params);
  await f.send("events/subscribe", {
    ...params,
    delivery: { ...params.delivery, url: "https://receiver.example.com/changed" },
  });
  expect(f.review).toHaveBeenCalledTimes(1);
  expect(f.snapshot().counts.candidate_review_requested).toBe(1);
  expect(f.snapshot().counts.candidate_repeated).toBe(1);
  expect(f.snapshot().counts.candidate_changed).toBe(1);
  expect(f.snapshot().counts.subscription_denied).toBe(2);
  expect(readFileSync(f.path, "utf8")).not.toContain("never-record");
});
it("fails closed before review if the diagnostic file is replaced", async () => {
  const f = fixture();
  rmSync(f.path);
  writeFileSync(f.path, "private-replacement");
  chmodSync(f.path, 0o644);
  await expect(f.send("events/subscribe", params)).rejects.toThrow("diagnostics_unavailable");
  expect(f.review).not.toHaveBeenCalled();
  expect(readFileSync(f.path, "utf8")).toBe("private-replacement");
});

it("distinguishes HTTP boundary, route, size, unavailable endpoint and internal errors while remaining live", async () => {
  const f = fixture();
  let endpoint: { fetch: (request: Request) => Promise<Response> } | undefined;
  const server = createLoopbackServer(0, () => endpoint, f.diagnostic);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_address");
  async function send(path = "/mcp", method = "POST", headers = {}, body = "{}") {
    return new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          hostname: "127.0.0.1",
          agent: false,
          port: address && typeof address !== "string" ? address.port : 0,
          path,
          method,
          headers: { host: "127.0.0.1:0", ...headers },
        },
        (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode ?? 0));
        },
      );
      request.once("error", reject);
      request.end(body);
    });
  }
  try {
    expect(await send("/mcp", "POST", { origin: "https://private-never-record.example" })).toBe(
      403,
    );
    expect(await send("/mcp", "POST", { host: "private-never-record.example" })).toBe(403);
    expect(await send("/.well-known/oauth-protected-resource", "GET")).toBe(404);
    expect(await send("/private-never-record")).toBe(403);
    // Node can close the over-limit request stream before the 413 reaches the client.
    await send("/mcp", "POST", {}, "x".repeat(262145)).then(
      (status) => expect(status).toBe(413),
      (error) => expect(error.code).toBe("ECONNRESET"),
    );
    expect(await send()).toBe(503);
    endpoint = {
      fetch: async () => {
        throw new Error("private-never-record");
      },
    };
    expect(await send()).toBe(500);
    endpoint = { fetch: async () => new Response("ok") };
    expect(await send()).toBe(200);
    const counts = f.snapshot().counts;
    expect(counts.http_arrived).toBe(8);
    expect(counts.http_boundary_rejected).toBe(2);
    for (const stage of [
      "oauth_metadata_absent",
      "http_route_rejected",
      "http_body_limit",
      "endpoint_unavailable",
      "http_exception",
    ])
      expect(counts[stage]).toBe(1);
    expect(readFileSync(f.path, "utf8")).not.toContain("private-never-record");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
