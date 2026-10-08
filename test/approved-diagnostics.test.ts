import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPreflightDiagnostics } from "../src/events/preflight-diagnostics.js";
import { createServiceNotificationEndpoint } from "../src/events/service-endpoint.js";
import { assertCallbackApproval } from "../src/events/callback-preflight.js";
import { limitTrialVerification } from "../src/events/trial-verification-budget.js";
import { digest } from "../src/events/model.js";
const target = {
  executionHostId: "local",
  worktreeId: "synthetic-private",
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
    url: "https://receiver.example.com/private?POISON=never-save",
    secret: `whsec_${Buffer.alloc(32, 7).toString("base64")}`,
  },
};
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture(mode = "success", eventStatus = 200) {
  const directory = mkdtempSync(join(tmpdir(), "synthetic-approved-diagnostics-"));
  chmodSync(directory, 0o700);
  const path = join(directory, "approved-diagnostics.json"),
    diagnostic = createPreflightDiagnostics(path);
  let now = 100000,
    blob: string | null = null,
    receive: (frame: unknown) => void = () => {};
  const approval = {
    host: "receiver.example.com",
    urlHash: digest(params.delivery.url),
    owner: "service:trial-service-v1" as const,
    targetHash: digest(target),
    expiresAt: 700000,
  };
  const rawPost = vi.fn(async (_url: string, _headers: Record<string, string>, body: string) => {
    const parsed = JSON.parse(body);
    if (parsed.type === "verification") {
      if (mode === "transport") throw new Error("POISON-private-network-error");
      return {
        status: 200,
        body: JSON.stringify({ challenge: mode === "echo" ? "wrong" : parsed.challenge }),
      };
    }
    if (mode === "event_transport") throw new Error("POISON-event-error");
    return { status: eventStatus, body: "" };
  });
  const endpoint = await createServiceNotificationEndpoint({
    target,
    keyId: "trial-service-v1",
    serviceKey: Buffer.alloc(32, 3),
    expiresAt: approval.expiresAt,
    diagnostic,
    beforeSubscribe: (owner, value) =>
      assertCallbackApproval(approval, owner, value, now, diagnostic),
    engine: {
      diagnostic,
      now: () => now,
      key: Buffer.alloc(32, 4),
      store: {
        load: async () => blob,
        save: async (value: string) => {
          blob = value;
        },
      },
      allowedCallbackHosts: [approval.host],
      post: limitTrialVerification(rawPost, approval.expiresAt, () => now, diagnostic),
    },
    transport: {
      open: async (_method, _input, onFrame) => {
        if (mode === "monitor") throw new Error("POISON-runtime-error");
        receive = onFrame;
        receive({
          type: "ready",
          subscription: {
            version: 2,
            subscriptionId: "synthetic-source",
            target,
            authorityEpoch: "epoch",
            baselineSequence: 0,
            expiresAt: 699000,
            replayCursor: null,
          },
        });
        return async () => {};
      },
    },
  });
  cleanup.push(async () => {
    await endpoint.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const counts = () => JSON.parse(readFileSync(path, "utf8")).counts as Record<string, number>;
  const request = async (input: unknown = params) =>
    (
      await endpoint.fetch(
        new Request("http://127.0.0.1/mcp", {
          method: "POST",
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
              ...(input as object),
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        }),
      )
    ).json();
  return {
    endpoint,
    counts,
    request,
    rawPost,
    checkApproval: () =>
      assertCallbackApproval(approval, "service:trial-service-v1", params, now, diagnostic),
    expire: () => {
      now = 700000;
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
    text: () => readFileSync(path, "utf8"),
  };
}
it("distinguishes exact URL mismatch before outbound and never logs URL, hash or secret", async () => {
  const f = await fixture();
  expect(
    await f.request({
      ...params,
      delivery: { ...params.delivery, url: params.delivery.url + "changed" },
    }),
  ).toHaveProperty("error");
  expect(f.counts()).toMatchObject({
    method_subscribe: 1,
    approval_url_mismatch: 1,
    challenge_attempted: 0,
    subscription_created: 0,
    subscription_request_rejected: 1,
  });
  expect(f.rawPost).not.toHaveBeenCalled();
  for (const value of ["POISON", digest(params.delivery.url), params.delivery.secret])
    expect(f.text()).not.toContain(value);
});
it.each(["transport", "echo"])(
  "classifies %s verification failure and blocks a second outbound challenge",
  async (mode) => {
    const f = await fixture(mode);
    expect(await f.request()).toHaveProperty("error");
    expect(f.counts()).toMatchObject({
      approval_url_match: 1,
      challenge_attempted: 1,
      challenge_failed: 1,
      challenge_succeeded: 0,
      subscription_created: 0,
    });
    expect(
      f.counts()[
        mode === "transport" ? "challenge_transport_failed" : "challenge_response_rejected"
      ],
    ).toBe(1);
    expect(await f.request()).toHaveProperty("error");
    expect(f.counts().challenge_blocked).toBe(1);
    expect(f.rawPost).toHaveBeenCalledTimes(1);
    expect(f.text()).not.toContain("POISON");
  },
);
it.each([200, 503])(
  "counts subscription, monitoring and event delivery status %s",
  async (status) => {
    const f = await fixture("success", status);
    expect(await f.request()).toHaveProperty("result.id");
    expect(f.counts()).toMatchObject({
      challenge_attempted: 1,
      challenge_succeeded: 1,
      subscription_created: 1,
      monitoring_start_attempted: 1,
      monitoring_started: 1,
      subscription_request_succeeded: 1,
    });
    f.emit();
    await vi.waitFor(() => expect(f.counts().event_send_attempted).toBe(1));
    expect(f.counts()[status === 200 ? "event_send_succeeded" : "event_send_failed"]).toBe(1);
    await f.endpoint.close();
    expect(f.counts().monitoring_stopped).toBe(1);
    expect(f.text()).not.toContain("POISON");
  },
);
it("records monitoring failure after verification and removes the subscription", async () => {
  const f = await fixture("monitor");
  expect(await f.request()).toHaveProperty("error");
  expect(f.counts()).toMatchObject({
    challenge_succeeded: 1,
    subscription_created: 1,
    subscription_removed: 1,
    monitoring_start_attempted: 1,
    monitoring_start_failed: 1,
    monitoring_started: 0,
    event_send_attempted: 0,
  });
});
it("rejects expiry without outbound and classifies event transport failure", async () => {
  const expired = await fixture();
  expired.expire();
  expect(() => expired.checkApproval()).toThrow("callback_approval_required");
  expect(expired.counts().approval_expired).toBe(1);
  expect(expired.rawPost).not.toHaveBeenCalled();
  const f = await fixture("event_transport");
  expect(await f.request()).toHaveProperty("result.id");
  f.emit();
  await vi.waitFor(() => expect(f.counts().event_send_failed).toBe(1));
  expect(f.text()).not.toContain("POISON");
});
