import { beforeAll, afterAll, afterEach, expect, it, vi } from "vitest";
import { createServer, request, type RequestOptions } from "node:https";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import { createNodePinnedSend, createPost } from "../src/events/webhook.js";
import { createTwoPhaseEndpoint } from "../src/events/two-phase-endpoint.js";
import { digest } from "../src/events/model.js";
import { verifyStandardWebhook } from "./fixtures/standard-webhook-receiver.js";
import type { TLSSocket } from "node:tls";
let dir: string, cert: Buffer, key: Buffer;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "synthetic-callback-tls-"));
  writeFileSync(
    join(dir, "openssl.cnf"),
    "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=receiver.example.com\n[ext]\nsubjectAltName=DNS:receiver.example.com\nbasicConstraints=critical,CA:TRUE\n",
  );
  execFileSync(
    "/usr/bin/openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-config",
      join(dir, "openssl.cnf"),
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  cert = readFileSync(join(dir, "cert.pem"));
  key = readFileSync(join(dir, "key.pem"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
const target = {
  executionHostId: "local" as const,
  worktreeId: "fixture",
  terminalHandle: "term_fixture",
  paneKey: "pane",
  incarnationId: "gen",
  launchId: "launch",
  providerSessionId: "session",
};
async function fixture(mode: string) {
  let received = 0;
  const sockets = new Set<Duplex>();
  const server = createServer({ key, cert }, (req, res) => {
    received++;
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (v) => {
      body += v;
    });
    req.on("end", () => {
      void (async () => {
        const value = await verifyStandardWebhook(
          Buffer.from(body),
          req.headers,
          Buffer.alloc(32, 7),
        );
        expect(value).toMatchObject({ type: "verification", challenge: expect.any(String) });
        expect(Object.keys(value as object).sort()).toEqual(["challenge", "type"]);
        expect(req.method).toBe("POST");
        expect(req.headers.host).toBe("receiver.example.com");
        expect(req.headers["content-type"]).toBe("application/json");
        expect(Number(req.headers["content-length"])).toBe(Buffer.byteLength(body));
        expect(req.headers["x-mcp-subscription-id"]).toMatch(/^sub_/);
        expect((req.socket as TLSSocket & { servername: string }).servername).toBe(
          "receiver.example.com",
        );
        if (mode === "hang") return;
        if (mode === "reset") {
          req.socket.destroy();
          return;
        }
        if (mode === "truncated") {
          res.writeHead(200, { "Content-Length": "10000" });
          res.write("{");
          setTimeout(() => res.destroy(), 10);
          return;
        }
        const statuses: Record<string, number> = {
          redirect: 302,
          auth: 401,
          forbidden: 403,
          rate: 429,
          client: 422,
          server: 503,
          other: 304,
        };
        res.writeHead(statuses[mode] ?? 200, { "Content-Type": "application/json" });
        res.end(
          mode === "large"
            ? "x".repeat(4097)
            : mode === "json"
              ? "PRIVATE_POISON"
              : mode === "missing"
                ? "{}"
                : JSON.stringify({
                    challenge: mode === "echo" ? "wrong" : JSON.parse(body).challenge,
                  }),
        );
      })().catch(() => {
        res.writeHead(400);
        res.end();
      });
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const port = (server.address() as { port: number }).port;
  // Only test destination/CA are overridden. The real https.request, handshake, SNI,
  // hostname validation, response parsing and AbortSignal remain active.
  const local = ((options: RequestOptions, cb: (response: IncomingMessage) => void) => {
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.servername).toBe("receiver.example.com");
    expect(options.agent).toBe(false);
    return request(
      {
        ...options,
        port,
        ca: mode === "untrusted" ? undefined : cert,
        servername: mode === "hostname" ? "wrong.example.com" : options.servername,
      },
      cb,
    );
  }) as typeof request;
  const stages: string[] = [],
    open = vi.fn();
  const expiresAt = Date.now() + 30000;
  const endpoint = await createTwoPhaseEndpoint({
    target,
    serviceKey: Buffer.alloc(32, 3),
    scope: {
      host: "receiver.example.com",
      owner: "service:trial-service-v1",
      targetHash: digest(target),
      expiresAt,
      domainConfirmation: "送信先ドメインを確認 receiver.example.com",
      confirmation: "確認通信1回のみを承認 receiver.example.com",
      accountBasis: "bounded_protocol_test",
    },
    diagnostic: (s) => stages.push(s),
    review: vi.fn(),
    transport: { describe: async () => target, open },
    engine: {
      key: Buffer.alloc(32, 4),
      store: { load: async () => null, save: async () => {} },
      post: createPost(
        ["receiver.example.com"],
        async () => ["8.8.8.8"],
        (pinned, headers, body, signal) => {
          expect(pinned.address).toBe("8.8.8.8");
          // Redirect the validated synthetic IP only; preserve production lookup callback.
          return createNodePinnedSend(local)(
            { ...pinned, address: "127.0.0.1" },
            headers,
            body,
            signal,
          );
        },
      ),
    },
  });
  closers.push(endpoint.close);
  const params = {
    name: "orca.session_activity",
    arguments: target,
    delivery: {
      mode: "webhook",
      url: "https://receiver.example.com/PRIVATE_POISON",
      secret: "whsec_" + Buffer.alloc(32, 7).toString("base64"),
    },
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  };
  const subscribe = async () => {
    const response = await endpoint.fetch(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "events/subscribe",
          authorization: "Bearer " + Buffer.alloc(32, 3).toString("base64url"),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "events/subscribe", params }),
      }),
    );
    return response.json() as Promise<{
      result?: { id: string };
      error?: { code: number; data?: { reason: string } };
    }>;
  };
  return { subscribe, stages, open, received: () => received };
}
it("keeps the pinned direct TLS route despite ambient proxy variables", async () => {
  for (const name of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ])
    vi.stubEnv(name, "http://127.0.0.1:9");
  vi.stubEnv("NODE_USE_ENV_PROXY", "1");
  const f = await fixture("normal");
  expect((await f.subscribe()).result?.id).toMatch(/^sub_/);
  expect(f.received()).toBe(1);
});
it.each([
  ["normal", "challenge_succeeded"],
  ["untrusted", "callback_tls_trust"],
  ["hostname", "callback_tls_hostname"],
  ["reset", "callback_socket_reset"],
  ["truncated", "callback_response_truncated"],
  ["large", "callback_response_limit"],
  ["redirect", "callback_redirect_rejected"],
  ["auth", "challenge_http_auth_rejected"],
  ["forbidden", "challenge_http_auth_rejected"],
  ["rate", "challenge_http_rate_limited"],
  ["client", "challenge_http_4xx"],
  ["server", "challenge_http_5xx"],
  ["json", "challenge_json_invalid"],
  ["missing", "challenge_echo_missing"],
  ["echo", "challenge_echo_mismatch"],
  ["hang", "callback_timeout"],
])(
  "real loopback TLS + MCP classifies %s and never starts monitoring",
  async (mode, stage) => {
    const f = await fixture(mode);
    const result = await f.subscribe();
    expect(f.stages).toContain(stage);
    expect(f.open).not.toHaveBeenCalled();
    expect(JSON.stringify(f.stages)).not.toContain("PRIVATE_POISON");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_POISON");
    if (mode === "normal") expect(result.result?.id).toMatch(/^sub_/);
    else {
      expect(result.error?.code).toBe(-32015);
      expect(result.error?.data?.reason).toBe(mode === "hang" ? "timeout" : "challenge_failed");
      expect(f.stages).not.toContain("subscription_created");
    }
    const before = f.received();
    await f.subscribe();
    expect(f.received()).toBe(before);
  },
  20000,
);
