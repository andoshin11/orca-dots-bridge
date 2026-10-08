import { expect, it } from "vitest";
import { EventEngine } from "../src/events/engine.js";
import { SessionEventsRpc } from "../src/events/session-rpc.js";
import { createServiceNotificationEndpoint } from "../src/events/service-endpoint.js";
const target = {
  executionHostId: "local" as const,
  worktreeId: "folder:test",
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
    url: "https://receiver.example.com/one",
    secret: `whsec_${Buffer.alloc(32, 7).toString("base64")}`,
  },
  ttlMs: 600000,
};
function fixture() {
  let now = 100000;
  let posts = 0,
    opened = 0,
    stopped = 0;
  const engineOptions = {
    now: () => now,
    key: Buffer.alloc(32, 4),
    store: { load: async () => null, save: async () => undefined },
    allowedCallbackHosts: ["receiver.example.com"],
    post: async (_url: string, _headers: Record<string, string>, body: string) => {
      posts++;
      return { status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) };
    },
  };
  const transport = {
    open: async (_method: string, _params: unknown, receive: (frame: unknown) => void) => {
      opened++;
      receive({
        type: "ready",
        subscription: {
          version: 2,
          subscriptionId: "source",
          target,
          authorityEpoch: "epoch",
          baselineSequence: 0,
          expiresAt: now + 599000,
          replayCursor: null,
        },
      });
      return async () => {
        stopped++;
      };
    },
  };
  return {
    engineOptions,
    transport,
    advance: () => {
      now += 1000;
    },
    counts: () => ({ posts, opened, stopped }),
  };
}
it("pins one callback and subscription, retries without renewing, and refuses resubscribe after cancellation", async () => {
  const f = fixture();
  const engine = await EventEngine.open({
    ...f.engineOptions,
    authorize: async (_owner, t) => JSON.stringify(t) === JSON.stringify(target),
  });
  const rpc = new SessionEventsRpc(engine, f.transport, f.engineOptions.now, 600000, 700000, true);
  try {
    await expect(
      rpc.dispatch("owner", "events/subscribe", {
        ...params,
        arguments: { ...target, paneKey: "wrong" },
      }),
    ).rejects.toThrow();
    const first = await rpc.dispatch("owner", "events/subscribe", params);
    f.advance();
    expect(await rpc.dispatch("owner", "events/subscribe", params)).toEqual(first);
    for (const delivery of [
      { ...params.delivery, url: "https://receiver.example.com/two" },
      { ...params.delivery, secret: `whsec_${Buffer.alloc(32, 8).toString("base64")}` },
    ])
      await expect(
        rpc.dispatch("owner", "events/subscribe", { ...params, delivery }),
      ).rejects.toThrow("subscription_limit");
    expect(f.counts()).toEqual({ posts: 1, opened: 1, stopped: 0 });
    await rpc.dispatch("owner", "events/unsubscribe", {
      name: params.name,
      arguments: target,
      delivery: { mode: "webhook", url: params.delivery.url },
    });
    await expect(rpc.dispatch("owner", "events/subscribe", params)).rejects.toThrow(
      "subscription_limit",
    );
  } finally {
    await rpc.close();
  }
});
it("service endpoint authenticates, exposes no tools, and rejects other targets before callback traffic", async () => {
  const f = fixture();
  const endpoint = await createServiceNotificationEndpoint({
    target,
    keyId: "fixture",
    serviceKey: Buffer.alloc(32, 3),
    expiresAt: 700000,
    engine: f.engineOptions,
    transport: f.transport,
  });
  const request = async (
    method: string,
    input = {},
    auth = `Bearer ${Buffer.alloc(32, 3).toString("base64url")}`,
  ) => {
    const r = await endpoint.fetch(
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
    return r;
  };
  try {
    expect((await request("events/list", {}, "Bearer wrong")).status).toBe(401);
    expect(await (await request("tools/list")).json()).toMatchObject({ result: { tools: [] } });
    expect(
      await (
        await request("events/subscribe", { ...params, arguments: { ...target, paneKey: "other" } })
      ).json(),
    ).toHaveProperty("error");
    for (const name of ["orca_status", "orca_send"])
      expect(await (await request("tools/call", { name, arguments: {} })).json()).toHaveProperty(
        "error",
      );
    expect(f.counts().posts).toBe(0);
    expect(await (await request("events/subscribe", params)).json()).toHaveProperty("result.id");
    expect(
      await (
        await request("events/subscribe", {
          ...params,
          delivery: { ...params.delivery, url: "https://receiver.example.com/two" },
        })
      ).json(),
    ).toHaveProperty("error");
    expect(f.counts().posts).toBe(1);
  } finally {
    await endpoint.close();
  }
  expect((await request("events/list")).status).toBe(401);
});
