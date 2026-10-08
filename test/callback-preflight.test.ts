import { expect, it, vi } from "vitest";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(() => {
    throw new Error("unexpected DNS");
  }),
}));
vi.mock("node:https", () => ({
  request: vi.fn(() => {
    throw new Error("unexpected HTTPS");
  }),
}));
import {
  createCallbackPreflight,
  assertCallbackApproval,
  type CallbackApproval,
} from "../src/events/callback-preflight.js";
import { createServiceNotificationEndpoint } from "../src/events/service-endpoint.js";
const target = {
  executionHostId: "local",
  worktreeId: "fixture",
  terminalHandle: "term_test",
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
    url: "https://receiver.example.com/one?opaque=value",
    secret: `whsec_${Buffer.alloc(32, 8).toString("base64")}`,
  },
};
function request(
  endpoint: { fetch: (r: Request) => Promise<Response> },
  method: string,
  input = {},
  auth = `Bearer ${key.toString("base64url")}`,
) {
  return endpoint.fetch(
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": method,
        accept: "application/json, text/event-stream",
        authorization: auth,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...input,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }),
  );
}
function fixture() {
  let now = 100000;
  const review = vi.fn();
  const endpoint = createCallbackPreflight({
    target,
    serviceKey: key,
    expiresAt: 700000,
    now: () => now,
    review,
  });
  return {
    endpoint,
    review,
    expire: () => {
      now = 700000;
    },
  };
}
it("authenticates before review, exposes no tools, rejects wrong targets and expired/revoked auth", async () => {
  const f = fixture();
  expect((await request(f.endpoint, "events/subscribe", params, "Bearer wrong")).status).toBe(401);
  expect(await (await request(f.endpoint, "tools/list")).json()).toMatchObject({
    result: { tools: [] },
  });
  expect(await (await request(f.endpoint, "events/list")).json()).toHaveProperty("result.events");
  expect(
    await (
      await request(f.endpoint, "events/subscribe", {
        ...params,
        arguments: { ...target, paneKey: "other" },
      })
    ).json(),
  ).toHaveProperty("error");
  expect(f.review).not.toHaveBeenCalled();
  f.expire();
  expect((await request(f.endpoint, "events/subscribe", params)).status).toBe(401);
  f.endpoint.close();
  expect((await request(f.endpoint, "events/list")).status).toBe(401);
});
it("reviews once locally, rejects every subscribe, and never discloses URL/secret in MCP response", async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) {
    const response = await (await request(f.endpoint, "events/subscribe", params)).json();
    expect(response).toMatchObject({
      error: { code: -32015, data: { reason: "callback_approval_required" } },
    });
    expect(JSON.stringify(response)).not.toContain("opaque");
    expect(JSON.stringify(response)).not.toContain(params.delivery.secret);
  }
  expect(lookup).not.toHaveBeenCalled();
  expect(httpsRequest).not.toHaveBeenCalled();
  expect(f.review).toHaveBeenCalledTimes(1);
  expect(f.review.mock.calls[0]![0]).toBe(params.delivery.url);
  expect(JSON.stringify(f.review.mock.calls[0]![1])).not.toContain("opaque");
  await request(f.endpoint, "events/subscribe", {
    ...params,
    delivery: { ...params.delivery, url: "https://other.example.com/" },
  });
  expect(f.review).toHaveBeenCalledTimes(1);
  f.endpoint.close();
});
it("rejects malformed signing keys, non-HTTPS, credentials, fragment, custom port and IP URLs before review", async () => {
  const f = fixture();
  for (const url of [
    "http://receiver.example.com",
    "https://user:pass@receiver.example.com",
    "https://receiver.example.com/#frag",
    "https://receiver.example.com:8443/",
    "https://127.0.0.1/",
    "https://[::1]/",
  ]) {
    expect(
      await (
        await request(f.endpoint, "events/subscribe", {
          ...params,
          delivery: { ...params.delivery, url },
        })
      ).json(),
    ).toHaveProperty("error");
  }
  await request(f.endpoint, "events/subscribe", {
    ...params,
    delivery: { ...params.delivery, secret: "bad" },
  });
  expect(f.review).not.toHaveBeenCalled();
  f.endpoint.close();
});
it("approval binds canonical full URL including query, owner, target and expiry; new valid key is not destination approval", async () => {
  const f = fixture();
  await request(f.endpoint, "events/subscribe", params);
  const approval = f.review.mock.calls[0]![1] as CallbackApproval;
  expect(() => assertCallbackApproval(approval, approval.owner, params, 100001)).not.toThrow();
  for (const changed of [
    { ...params, arguments: { ...target, launchId: "new" } },
    {
      ...params,
      delivery: { ...params.delivery, url: "https://receiver.example.com/two?opaque=value" },
    },
    {
      ...params,
      delivery: { ...params.delivery, url: "https://receiver.example.com/one?opaque=changed" },
    },
  ])
    expect(() => assertCallbackApproval(approval, approval.owner, changed, 100001)).toThrow();
  expect(() => assertCallbackApproval(approval, "other", params, 100001)).toThrow();
  expect(() => assertCallbackApproval(approval, approval.owner, params, 700000)).toThrow();
  expect(() =>
    assertCallbackApproval({ ...approval, expiresAt: 9999999 }, approval.owner, params, 100001),
  ).toThrow();
  f.endpoint.close();
});
it("approved endpoint rejects URL changes before sending and still requires a successful challenge before opening Orca", async () => {
  const f = fixture();
  await request(f.endpoint, "events/subscribe", params);
  const approval = f.review.mock.calls[0]![1] as CallbackApproval;
  const post = vi.fn(async (_url: string, _headers: Record<string, string>, _body: string) => ({
    status: 200,
    body: '{"challenge":"wrong"}',
  }));
  const open = vi.fn();
  const endpoint = await createServiceNotificationEndpoint({
    target,
    keyId: "trial-service-v1",
    serviceKey: key,
    expiresAt: 700000,
    beforeSubscribe: (owner, p) => assertCallbackApproval(approval, owner, p, 100000),
    engine: {
      now: () => 100000,
      key: Buffer.alloc(32, 2),
      allowedCallbackHosts: [approval.host],
      post,
      store: { load: async () => null, save: async () => undefined },
    },
    transport: { open },
  });
  try {
    await request(endpoint, "events/subscribe", {
      ...params,
      delivery: { ...params.delivery, url: "https://receiver.example.com/other" },
    });
    expect(post).not.toHaveBeenCalled();
    expect(await (await request(endpoint, "events/subscribe", params)).json()).toHaveProperty(
      "error",
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(JSON.parse(post.mock.calls[0]![2] as string)).toHaveProperty("type", "verification");
    expect(open).not.toHaveBeenCalled();
  } finally {
    await endpoint.close();
    f.endpoint.close();
  }
});
