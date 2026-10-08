import { request as httpRequest } from "node:http";
import { EventEmitter } from "node:events";
import { createLoopbackServer } from "../src/events/loopback-server.js";
import { afterEach, expect, it, vi } from "vitest";
import { createServiceNotificationEndpoint } from "../src/events/service-endpoint.js";
import { createPost, createNodePinnedSend } from "../src/events/webhook.js";
import { assertCallbackApproval } from "../src/events/callback-preflight.js";
import { limitTrialVerification } from "../src/events/trial-verification-budget.js";
import { digest } from "../src/events/model.js";
const target = {
  executionHostId: "local",
  worktreeId: "synthetic",
  terminalHandle: "term_test",
  paneKey: "pane",
  incarnationId: "gen",
  launchId: "launch",
  providerSessionId: "session",
};
const params = {
  name: "orca.session_activity",
  arguments: target,
  delivery: {
    mode: "webhook",
    url: "https://receiver.example.com/synthetic",
    secret: `whsec_${Buffer.alloc(32, 7).toString("base64")}`,
  },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.useRealTimers();
});
async function fixture(stage: string) {
  const expiresAt = Date.now() + 600000;
  const approval = {
    host: "receiver.example.com",
    owner: "service:trial-service-v1" as const,
    urlHash: digest(params.delivery.url),
    targetHash: digest(target),
    expiresAt,
  };
  const reached = deferred<void>(),
    release = deferred<void>();
  const controller = new AbortController();
  let blob: string | null = null,
    receive: (v: unknown) => void = () => {},
    dnsCount = 0;
  const stop = vi.fn(async () => {});
  const send = vi.fn(async (_target, _headers, body: string, signal?: AbortSignal) => {
    const parsed = JSON.parse(body);
    if (stage === "challenge_send" && parsed.type === "verification") {
      reached.resolve();
      await new Promise<void>((resolve) =>
        signal!.addEventListener("abort", () => resolve(), { once: true }),
      );
      expect(signal!.aborted).toBe(true);
      throw new Error("synthetic-cancelled");
    }
    return { status: 200, body: JSON.stringify({ challenge: parsed.challenge }) };
  });
  const endpoint = await createServiceNotificationEndpoint({
    target,
    keyId: "trial-service-v1",
    serviceKey: Buffer.alloc(32, 3),
    expiresAt,
    beforeSubscribe: async (owner, value, signal) => {
      if (stage === "approval") {
        reached.resolve();
        await release.promise;
        expect(signal!.aborted).toBe(true);
      }
      assertCallbackApproval(approval, owner, value);
    },
    engine: {
      key: Buffer.alloc(32, 4),
      store: {
        load: async () => blob,
        save: async (v) => {
          const first = blob === null;
          blob = v;
          if (stage === "persist" && first) {
            reached.resolve();
            await release.promise;
          }
        },
      },
      allowedCallbackHosts: [approval.host],
      post: limitTrialVerification(
        createPost(
          [approval.host],
          async () => {
            dnsCount++;
            if (
              (stage === "challenge_dns" && dnsCount === 1) ||
              // Every event DNS attempt stays stalled, including bounded retries.
              (stage === "event_dns" && dnsCount >= 2)
            ) {
              reached.resolve();
              await release.promise;
            }
            return ["8.8.8.8"];
          },
          send,
        ),
        expiresAt,
      ),
    },
    transport: {
      open: async (_method, _params, cb) => {
        receive = cb;
        if (stage === "monitor") {
          reached.resolve();
          await release.promise;
        }
        cb({
          type: "ready",
          subscription: {
            version: 2,
            subscriptionId: "synthetic",
            target,
            authorityEpoch: "epoch",
            baselineSequence: 0,
            expiresAt: expiresAt - 1000,
            replayCursor: null,
          },
        });
        return stop;
      },
    },
  });
  cleanup.push(async () => {
    release.resolve();
    controller.abort();
    await endpoint.close();
  });
  const request = () =>
    endpoint.fetch(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "events/subscribe",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${Buffer.alloc(32, 3).toString("base64url")}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "events/subscribe",
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      }),
    );
  return {
    endpoint,
    request,
    controller,
    reached,
    release,
    send,
    stop,
    emit: () =>
      receive({
        type: "event",
        event: {
          version: 2,
          target,
          authorityEpoch: "epoch",
          sequence: 1,
          eventId: "synthetic-event",
          occurredAt: Date.now(),
          kind: "input_required",
        },
      }),
  };
}
it.each(["approval", "challenge_dns", "challenge_send", "persist", "monitor"])(
  "propagates cancellation through the MCP entry at %s and prevents later delivery",
  async (stage) => {
    const f = await fixture(stage);
    const response = f.request();
    await f.reached.promise;
    f.controller.abort();
    f.release.resolve();
    await response;
    await f.endpoint.close();
    f.emit();
    expect(f.send).toHaveBeenCalledTimes(
      ["challenge_send", "persist", "monitor"].includes(stage) ? 1 : 0,
    );
    if (stage === "monitor") expect(f.stop).toHaveBeenCalled();
  },
);
it.each(["abort", "expiry", "close"])(
  "prevents event send after DNS resolves following %s",
  async (reason) => {
    if (reason === "expiry") vi.useFakeTimers();
    const f = await fixture("event_dns");
    const response = await (await f.request()).json();
    expect(response.error).toBeUndefined();
    expect(response.result.id).toMatch(/^sub_/);
    f.emit();
    await f.reached.promise;
    let closing: Promise<void> | undefined;
    if (reason === "abort") f.controller.abort();
    else if (reason === "close") closing = f.endpoint.close();
    else await vi.advanceTimersByTimeAsync(600000);
    f.release.resolve();
    await (closing ?? f.endpoint.close());
    expect(f.send).toHaveBeenCalledTimes(1); // Only the already completed verification.
    expect(f.stop).toHaveBeenCalled();
  },
);
it("does not invoke DNS or node HTTPS for an already aborted send", async () => {
  const controller = new AbortController();
  controller.abort();
  const resolve = vi.fn(),
    send = vi.fn();
  await expect(
    createPost(["receiver.example.com"], resolve, send)(
      params.delivery.url,
      {},
      "{}",
      controller.signal,
    ),
  ).rejects.toThrow("delivery_cancelled");
  expect(resolve).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  const request = vi.fn();
  await expect(
    createNodePinnedSend(request as never)(
      { hostname: "receiver.example.com", address: "8.8.8.8", path: "/synthetic" },
      {},
      "{}",
      controller.signal,
    ),
  ).rejects.toThrow("delivery_cancelled");
  expect(request).not.toHaveBeenCalled();
});

it("cancels the complete loopback -> MCP -> approval -> DNS chain on socket disconnect", async () => {
  const f = await fixture("challenge_dns");
  const server = createLoopbackServer(0, () => f.endpoint);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_address");
  const disconnected = deferred<void>();
  const request = httpRequest({
    hostname: "127.0.0.1",
    port: address.port,
    path: "/mcp",
    method: "POST",
    agent: false,
    headers: {
      host: "127.0.0.1:0",
      "content-type": "application/json",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "events/subscribe",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${Buffer.alloc(32, 3).toString("base64url")}`,
    },
  });
  request.on("error", () => disconnected.resolve());
  // Observe the server-side cancellation independently of client socket teardown.
  const connections: Array<import("node:net").Socket> = [];
  server.on("connection", (socket) => connections.push(socket));
  try {
    request.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "events/subscribe",
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    );
    await f.reached.promise;
    const serverClosed = new Promise<void>((resolve) =>
      connections[0]!.once("close", () => resolve()),
    );
    request.destroy();
    await disconnected.promise;
    await serverClosed;
    f.release.resolve();
    await f.endpoint.close();
    expect(f.send).not.toHaveBeenCalled();
  } finally {
    request.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it("keeps monitoring after normal MCP response completion and sends a synthetic event", async () => {
  const f = await fixture("success");
  expect((await (await f.request()).json()).result.id).toMatch(/^sub_/);
  f.emit();
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
  expect(JSON.parse(f.send.mock.calls[1]![2]).name).toBe("orca.session_activity");
});
it("combines the trial cancellation signal with the unchanged HTTPS timeout", async () => {
  const controller = new AbortController();
  let outgoing: AbortSignal | undefined;
  const end = vi.fn();
  const request = vi.fn((options) => {
    outgoing = options.signal;
    const req = Object.assign(new EventEmitter(), { end });
    outgoing!.addEventListener("abort", () => req.emit("error", new Error("synthetic abort")), {
      once: true,
    });
    return req;
  });
  const response = createNodePinnedSend(request as never)(
    { hostname: "receiver.example.com", address: "8.8.8.8", path: "/synthetic" },
    {},
    "{}",
    controller.signal,
  );
  const rejected = expect(response).rejects.toThrow("delivery_failed");
  controller.abort();
  await rejected;
  expect(outgoing!.aborted).toBe(true);
  expect(request).toHaveBeenCalledTimes(1);
  expect(end).toHaveBeenCalledTimes(1); // Issued before cancellation; cannot be retracted.
});
it("expires a held challenge DNS lookup without sending verification", async () => {
  vi.useFakeTimers();
  const f = await fixture("challenge_dns");
  const response = f.request();
  await f.reached.promise;
  await vi.advanceTimersByTimeAsync(600000);
  f.release.resolve();
  await response;
  await f.endpoint.close();
  expect(f.send).not.toHaveBeenCalled();
});
