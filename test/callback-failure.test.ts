import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  createNodePinnedSend,
  createPost,
  EventError,
  transportReason,
} from "../src/events/webhook.js";
import { recordDeliveryFailure } from "../src/events/delivery-diagnostics.js";
import { limitTrialVerification } from "../src/events/trial-verification-budget.js";
import { EventEngine } from "../src/events/engine.js";
const url = "https://receiver.example.com/PRIVATE_SENTINEL";
it.each([
  [600, "{}", 0, "challenge_http_other"],
  [200, "null", 0, "challenge_echo_missing"],
  [200, '{"challenge":5}', 0, "challenge_echo_missing"],
  [200, "echo", 10001, "challenge_reply_late"],
  [200, "echo", -1, "challenge_clock_invalid"],
] as const)(
  "classifies non-wire reply boundaries %s/%s/%s",
  async (status, body, elapsed, stage) => {
    let now = 100000;
    const stages: string[] = [];
    const engine = await EventEngine.open({
      key: Buffer.alloc(32, 3),
      store: { load: async () => null, save: async () => {} },
      authorize: async () => true,
      allowedCallbackHosts: ["receiver.example.com"],
      now: () => now,
      diagnostic: (s) => stages.push(s),
      post: async (_u, _h, requestBody) => {
        now += elapsed;
        return {
          status,
          body:
            body === "echo"
              ? JSON.stringify({ challenge: JSON.parse(requestBody).challenge })
              : body,
        };
      },
    });
    await expect(
      engine.subscribe("owner", {
        name: "orca.session_activity",
        arguments: {
          executionHostId: "local",
          worktreeId: "fixture",
          terminalHandle: "term_fixture",
          paneKey: "pane",
          incarnationId: "gen",
          launchId: "launch",
          providerSessionId: "session",
        },
        delivery: {
          mode: "webhook",
          url,
          secret: "whsec_" + Buffer.alloc(32, 7).toString("base64"),
        },
      }),
    ).rejects.toThrow("callback_verification_failed");
    expect(stages).toContain(stage);
    expect(stages).not.toContain("subscription_created");
  },
);
afterEach(() => vi.useRealTimers());
it.each([
  ["ENOTFOUND", "dns_not_found"],
  ["ERR_HTTP_INVALID_HEADER_VALUE", "request_invalid"],
  ["EAI_AGAIN", "dns_temporary"],
  ["ERR_TLS_CERT_ALTNAME_INVALID", "tls_hostname"],
  ["CERT_HAS_EXPIRED", "tls_validity"],
  ["CERT_NOT_YET_VALID", "tls_validity"],
  ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls_trust"],
  ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls_trust"],
  ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "tls_trust"],
  ["ERR_SSL_WRONG_VERSION_NUMBER", "tls_protocol"],
  ["ETIMEDOUT", "timeout"],
  ["ECONNREFUSED", "socket_refused"],
  ["EACCES", "socket_permission"],
  ["EPERM", "socket_permission"],
  ["ECONNRESET", "socket_reset"],
  ["EPIPE", "socket_reset"],
  ["ENETUNREACH", "socket_unreachable"],
  ["EHOSTUNREACH", "socket_unreachable"],
  ["HPE_INVALID_HEADER_TOKEN", "http_parse"],
  ["PRIVATE_SENTINEL", "unknown"],
])("classifies Node code %s without copying arbitrary details", async (code, reason) => {
  const error = Object.assign(new Error(url), { code, hostname: url, cause: { secret: url } });
  const request = (() => {
    const req = Object.assign(new EventEmitter(), {
      end() {
        queueMicrotask(() => req.emit("error", error));
      },
    });
    return req;
  }) as unknown as typeof import("node:https").request;
  const send = createNodePinnedSend(request);
  const stages: string[] = [];
  const post = limitTrialVerification(
    createPost(["receiver.example.com"], async () => ["8.8.8.8"], send),
    Date.now() + 30000,
    Date.now,
    (stage) => stages.push(stage),
  );
  await expect(post(url, {}, '{"type":"verification"}')).rejects.toMatchObject({
    code: "delivery_failed",
    reason,
  });
  expect(stages).toContain(
    reason === "unknown" ? "callback_unknown_failure" : "callback_" + reason,
  );
  expect(JSON.stringify(stages)).not.toContain("PRIVATE_SENTINEL");
  await expect(post(url, {}, '{"type":"verification"}')).rejects.toThrow(
    "callback_approval_required",
  );
  expect(stages.filter((x) => x === "challenge_attempted")).toHaveLength(1);
});
it("does not stringify an error code object or read its message, stack or cause", () => {
  const poison = {
    toString() {
      throw new Error("must_not_stringify");
    },
  };
  expect(transportReason({ code: poison })).toBe("unknown");
  expect(
    transportReason({
      get code() {
        throw poison;
      },
    }),
  ).toBe("unknown");
  expect(
    transportReason({
      code: "ECONNRESET",
      get message() {
        throw poison;
      },
    }),
  ).toBe("socket_reset");
  const stages: string[] = [];
  recordDeliveryFailure(new EventError("delivery_failed", url), (s) => stages.push(s));
  expect(stages).toEqual(["callback_unknown_failure"]);
});
it.each([
  [[], "dns_empty"],
  [["127.0.0.1"], "address_rejected"],
  [["::1"], "address_rejected"],
  [["8.8.8.8", "10.0.0.1"], "address_rejected"],
])("rejects unsafe DNS answers without opening a socket: %j", async (addresses, reason) => {
  const send = vi.fn();
  await expect(
    createPost(["receiver.example.com"], async () => addresses as string[], send)(url, {}, "{}"),
  ).rejects.toMatchObject({ reason });
  expect(send).not.toHaveBeenCalled();
});
it.each([
  ["ENOTFOUND", "dns_not_found"],
  ["EAI_AGAIN", "dns_temporary"],
  ["private", "dns_other"],
])("classifies resolver rejection %s", async (code, reason) => {
  await expect(
    createPost(["receiver.example.com"], async () => {
      throw { code, message: url };
    })(url, {}, "{}"),
  ).rejects.toMatchObject({ code: "dns_failed", reason });
});
it("bounds stalled DNS to ten seconds; late DNS cannot start a send", async () => {
  vi.useFakeTimers();
  let release!: (v: string[]) => void;
  const send = vi.fn();
  const p = createPost(
    ["receiver.example.com"],
    () =>
      new Promise((r) => {
        release = r;
      }),
    send,
  )(url, {}, "{}");
  const result = expect(p).rejects.toMatchObject({ reason: "timeout" });
  await vi.advanceTimersByTimeAsync(10000);
  await result;
  release(["8.8.8.8"]);
  await Promise.resolve();
  expect(send).not.toHaveBeenCalled();
});
it("cancels stalled DNS immediately and never sends after late resolution", async () => {
  let release!: (v: string[]) => void;
  const send = vi.fn(),
    controller = new AbortController();
  const p = createPost(
    ["receiver.example.com"],
    () =>
      new Promise((r) => {
        release = r;
      }),
    send,
  )(url, {}, "{}", controller.signal);
  controller.abort();
  await expect(p).rejects.toMatchObject({ reason: "cancelled" });
  release(["8.8.8.8"]);
  await Promise.resolve();
  expect(send).not.toHaveBeenCalled();
});
