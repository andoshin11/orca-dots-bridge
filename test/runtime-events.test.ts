import { expect, it } from "vite-plus/test";
import { Duplex } from "node:stream";
import { createRuntimeEventTransport } from "../src/events/runtime-transport.js";
const config = {
  endpoint: "/synthetic/runtime.sock",
  authToken: "synthetic",
  runtimeId: "runtime",
};
function fake(reply: (request: { id: string }) => string) {
  return () => {
    const socket = new Duplex({
      read() {},
      write(chunk, _encoding, done) {
        socket.push(reply(JSON.parse(chunk.toString())));
        done();
      },
    });
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  };
}
it("requires explicit local IPC configuration", () => {
  expect(() =>
    createRuntimeEventTransport({ ...config, endpoint: "https://example.com" }),
  ).toThrow();
  expect(() => createRuntimeEventTransport({ ...config, authToken: "" })).toThrow();
});
it.each(["wrong_id", "wrong_runtime", "failure", "malformed", "oversized"])(
  "rejects %s RPC frames",
  async (mode) => {
    const transport = createRuntimeEventTransport(
      config,
      fake((request) => {
        if (mode === "malformed") return "not-json\n";
        if (mode === "oversized") return "x".repeat(262145);
        return (
          JSON.stringify({
            id: mode === "wrong_id" ? "other" : request.id,
            ok: mode !== "failure",
            streaming: true,
            result: { type: "ready" },
            _meta: { runtimeId: mode === "wrong_runtime" ? "other" : "runtime" },
          }) + "\n"
        );
      }),
    );
    await expect(transport.open("terminal.agentEvents.subscribe", {}, () => {})).rejects.toThrow(
      "runtime_unavailable",
    );
  },
);
it("decodes multiple newline frames and stops its private socket", async () => {
  const frames: unknown[] = [];
  const transport = createRuntimeEventTransport(
    config,
    fake(
      (request) =>
        '{"_keepalive":true}\n' +
        JSON.stringify({
          id: request.id,
          ok: true,
          streaming: true,
          result: { type: "ready" },
          _meta: { runtimeId: "runtime" },
        }) +
        "\n",
    ),
  );
  const close = await transport.open("terminal.agentEvents.subscribe", {}, (frame) =>
    frames.push(frame),
  );
  expect(frames).toEqual([{ type: "ready" }]);
  await close();
});

it("uses authenticated unary describe before a callback and rejects streaming substitutes", async () => {
  const target = {
    executionHostId: "local",
    worktreeId: "fixture",
    terminalHandle: "term_fixture",
    paneKey: "pane",
    incarnationId: "gen",
    launchId: "launch",
    providerSessionId: "session",
  };
  for (const streaming of [false, true]) {
    const transport = createRuntimeEventTransport(
      config,
      fake(
        (request) =>
          JSON.stringify({
            id: request.id,
            ok: true,
            ...(streaming ? { streaming: true } : {}),
            result: { target },
            _meta: { runtimeId: config.runtimeId },
          }) + "\n",
      ),
    );
    if (streaming)
      await expect(transport.describe(target.terminalHandle)).rejects.toThrow(
        "runtime_unavailable",
      );
    else expect(await transport.describe(target.terminalHandle)).toEqual(target);
  }
});
