import { afterEach, expect, it, vi } from "vitest";
import {
  createTwoPhaseEndpoint,
  validateVerificationScope,
} from "../src/events/two-phase-endpoint.js";
import { createPost } from "../src/events/webhook.js";
import { privateReviewText } from "../src/notification-two-phase.js";
import { digest } from "../src/events/model.js";
const target = {
  executionHostId: "local" as const,
  worktreeId: "synthetic-日本語",
  terminalHandle: "term_fixture",
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
    url: "https://receiver.example.com/one-private-path",
    secret: `whsec_${Buffer.alloc(32, 7).toString("base64")}`,
  },
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const clean: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of clean.splice(0)) await close();
  vi.useRealTimers();
});
async function fixture(mode = "normal") {
  let now = 100000,
    blob: string | null = null,
    changed = false;
  let receive: (value: unknown) => void = () => {};
  const entered = deferred<void>(),
    release = deferred<void>();
  const scope = {
    host: "receiver.example.com",
    owner: "service:trial-service-v1" as const,
    targetHash: digest(target),
    expiresAt: 700000,
    domainConfirmation: "送信先ドメインを確認 receiver.example.com",
    confirmation: "確認通信1回のみを承認 receiver.example.com",
    accountBasis: "bounded_protocol_test" as const,
  };
  const stages: string[] = [],
    review = vi.fn(),
    stop = vi.fn(async () => {});
  const send = vi.fn(async (_target, _headers, body: string) => {
    const parsed = JSON.parse(body);
    if (mode === "challenge_wait") {
      entered.resolve();
      await release.promise;
    }
    return {
      status: 200,
      body: JSON.stringify({ challenge: mode === "wrong_echo" ? "wrong" : parsed.challenge }),
    };
  });
  const open = vi.fn(async (_method, _params, cb: (v: unknown) => void) => {
    receive = cb;
    if (mode === "open_fail") throw new Error("synthetic-runtime-error");
    cb({
      type: "ready",
      subscription: {
        version: 2,
        subscriptionId: "source",
        target,
        authorityEpoch: "epoch",
        baselineSequence: 0,
        expiresAt: 699000,
        replayCursor: null,
      },
    });
    return stop;
  });
  const describe = vi.fn(async () => {
    if (mode === "activation_wait" && describe.mock.calls.length > 1) {
      entered.resolve();
      await release.promise;
    }
    return changed ? { ...target, incarnationId: "changed" } : target;
  });
  const options = {
    scope,
    target,
    serviceKey: Buffer.alloc(32, 3),
    diagnostic: (stage: any) => stages.push(stage),
    review,
    transport: { open, describe },
    engine: {
      now: () => now,
      key: Buffer.alloc(32, 4),
      store: {
        load: async () => blob,
        save: async (v: string) => {
          blob = v;
        },
      },
      post: createPost(
        [scope.host],
        async () => [mode === "private_ip" ? "127.0.0.1" : "8.8.8.8"],
        send,
      ),
    },
  };
  const endpoint = await createTwoPhaseEndpoint(options);
  clean.push(async () => {
    release.resolve();
    await endpoint.close();
  });
  const controller = new AbortController();
  const request = async (input: unknown = params, method = "events/subscribe", auth = true) =>
    (
      await endpoint.fetch(
        new Request("http://127.0.0.1/mcp", {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            "MCP-Protocol-Version": "2026-07-28",
            "Mcp-Method": method,
            accept: "application/json, text/event-stream",
            authorization: auth
              ? `Bearer ${Buffer.alloc(32, 3).toString("base64url")}`
              : "Bearer synthetic-wrong",
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
      )
    ).text();
  const approval = {
    privateUrl: params.delivery.url,
    confirmation: "通知送信を承認 receiver.example.com",
    accountBasis: "bounded_protocol_test",
  };
  return {
    endpoint,
    request,
    options,
    controller,
    approval,
    send,
    open,
    review,
    stages,
    stop,
    entered,
    release,
    advance: (t: number) => {
      now = t;
    },
    change: () => {
      changed = true;
    },
    emit: () =>
      receive({
        type: "event",
        event: {
          version: 2,
          target,
          authorityEpoch: "epoch",
          sequence: 1,
          eventId: "synthetic-event",
          occurredAt: now,
          kind: "input_required",
        },
      }),
  };
}
it("creates once without monitoring, waits minutes, activates the same subscription without re-verification, then delivers", async () => {
  const f = await fixture();
  const first = JSON.parse(await f.request());
  expect(first.result.id).toMatch(/^sub_/);
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.open).not.toHaveBeenCalled();
  expect(f.review).toHaveBeenCalledExactlyOnceWith(params.delivery.url);
  f.emit();
  expect(f.send).toHaveBeenCalledTimes(1);
  f.advance(220000);
  const activated = await f.endpoint.activate(f.approval);
  expect(activated.id).toBe(first.result.id);
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.open).toHaveBeenCalledTimes(1);
  f.emit();
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
  expect(f.stages).toContain("notification_approval_waiting");
  expect(f.stages).toContain("notification_activated");
});
it.each([
  "wrong_url",
  "missing_consent",
  "expired",
  "target_changed",
  "cancelled",
  "closed",
  "unsubscribed",
])("does not monitor or send events after %s", async (mode) => {
  const f = await fixture();
  expect(JSON.parse(await f.request()).result.id).toMatch(/^sub_/);
  let approval = { ...f.approval };
  if (mode === "wrong_url") approval.privateUrl += "/changed";
  if (mode === "missing_consent") approval.confirmation = "";
  if (mode === "expired") f.advance(700000);
  if (mode === "target_changed") f.change();
  if (mode === "cancelled") f.controller.abort();
  if (mode === "closed") await f.endpoint.close();
  if (mode === "unsubscribed")
    await f.request(
      {
        name: params.name,
        arguments: target,
        delivery: { mode: "webhook", url: params.delivery.url },
      },
      "events/unsubscribe",
    );
  await expect(f.endpoint.activate(approval)).rejects.toThrow("activation_rejected");
  expect(f.open).not.toHaveBeenCalled();
  expect(f.send).toHaveBeenCalledTimes(1);
});
it.each(["private_ip", "wrong_echo"])(
  "never permits activation after %s verification failure",
  async (mode) => {
    const f = await fixture(mode);
    expect(JSON.parse(await f.request()).error).toBeDefined();
    expect(f.review).not.toHaveBeenCalled();
    await expect(f.endpoint.activate(f.approval)).rejects.toThrow();
    expect(f.open).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledTimes(mode === "private_ip" ? 0 : 1);
  },
);
it("rejects wrong authentication, target and host before sending", async () => {
  for (const mode of ["auth", "target", "host"]) {
    const f = await fixture();
    const input = structuredClone(params);
    if (mode === "target") input.arguments.launchId = "changed";
    if (mode === "host") input.delivery.url = "https://other.example.com/callback";
    await f.request(input, "events/subscribe", mode !== "auth");
    expect(f.send).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
  }
});
it("rejects simultaneous and later subscribe requests without a second challenge", async () => {
  const f = await fixture("challenge_wait");
  const first = f.request();
  await f.entered.promise;
  expect(JSON.parse(await f.request()).error).toBeDefined();
  f.release.resolve();
  expect(JSON.parse(await first).result.id).toMatch(/^sub_/);
  expect(
    JSON.parse(
      await f.request({
        ...params,
        delivery: { ...params.delivery, url: params.delivery.url + "/new" },
      }),
    ).error,
  ).toBeDefined();
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.open).not.toHaveBeenCalled();
});
it("cancels activation during target validation and blocks concurrent activation", async () => {
  const f = await fixture("activation_wait");
  await f.request();
  const one = f.endpoint.activate(f.approval);
  const rejected = expect(one).rejects.toThrow("activation_rejected");
  await f.entered.promise;
  await expect(f.endpoint.activate(f.approval)).rejects.toThrow("activation_rejected");
  f.release.resolve();
  await rejected;
  expect(f.open).not.toHaveBeenCalled();
  expect(f.send).toHaveBeenCalledTimes(1);
});
it("does not restore approval or an old verified subscription on restart", async () => {
  const f = await fixture();
  await f.request();
  await expect(createTwoPhaseEndpoint(f.options)).rejects.toThrow("trial_state_already_exists");
  expect(f.send).toHaveBeenCalledTimes(1);
});
it("stops before activation at the original timer deadline", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  await f.request();
  await vi.advanceTimersByTimeAsync(600000);
  await expect(f.endpoint.activate(f.approval)).rejects.toThrow();
  expect(f.open).not.toHaveBeenCalled();
  expect(f.send).toHaveBeenCalledTimes(1);
});
it("removes a verified subscription when monitoring cannot start", async () => {
  const f = await fixture("open_fail");
  await f.request();
  await expect(f.endpoint.activate(f.approval)).rejects.toThrow();
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.stages).toContain("subscription_removed");
});
it("requires separately worded verification consent and safe private rendering", () => {
  expect(() => validateVerificationScope({}, target, 100000)).toThrow();
  expect(() => privateReviewText("https://example.com/\nPOISON")).toThrow();
});
it("does not extend the published expiration while verification takes time", async () => {
  const f = await fixture("challenge_wait");
  const response = f.request();
  await f.entered.promise;
  f.advance(102000);
  f.release.resolve();
  const result = JSON.parse(await response);
  expect(Date.parse(result.result.refreshBefore)).toBe(700000);
  expect(f.open).not.toHaveBeenCalled();
});
