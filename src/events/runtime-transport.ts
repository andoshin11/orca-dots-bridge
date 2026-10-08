import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { z } from "zod";
import type { OrcaEventTransport } from "./session-rpc.js";
import { EventError } from "./webhook.js";
import { notificationTargetSchema, type NotificationTarget } from "./orca-contract.js";
const envelope = z.object({
  id: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  streaming: z.literal(true).optional(),
  _meta: z.object({ runtimeId: z.string() }),
});
/** Local IPC only. Runtime metadata/credentials are supplied explicitly; never discovered or logged here. */
export function createRuntimeEventTransport(
  options: { endpoint: string; authToken: string; runtimeId: string },
  connect: (path: string) => Duplex = createConnection,
): OrcaEventTransport & { describe(handle: string): Promise<NotificationTarget> } {
  if (
    (!options.endpoint.startsWith("/") && !options.endpoint.startsWith("\\\\.\\pipe\\")) ||
    !options.authToken ||
    !options.runtimeId
  )
    throw new EventError("runtime_configuration_required");
  const request = (
    method: string,
    params: unknown,
    receive: (frame: unknown) => void,
    unary = false,
  ): Promise<() => Promise<void>> =>
    new Promise((resolve, reject) => {
      const socket = connect(options.endpoint);
      const id = randomUUID();
      let buffer = "";
      let ready = false;
      let closed = false;
      const timeout = setTimeout(() => fail(), 5000);
      const stop = async () => {
        closed = true;
        clearTimeout(timeout);
        socket.destroy();
      };
      const fail = () => {
        if (closed) return;
        if (!ready) reject(new EventError("runtime_unavailable"));
        else receive({ type: "end" });
        void stop();
      };
      socket.setEncoding("utf8");
      socket.on("error", fail);
      socket.on("close", fail);
      socket.on("connect", () =>
        socket.write(`${JSON.stringify({ id, authToken: options.authToken, method, params })}\n`),
      );
      socket.on("data", (chunk: string) => {
        if (closed) return;
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 262144) {
          fail();
          return;
        }
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0 && !closed) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          try {
            const raw: unknown = JSON.parse(line);
            if (
              z
                .object({ _keepalive: z.literal(true) })
                .strict()
                .safeParse(raw).success
            )
              continue;
            const frame = envelope.parse(raw);
            if (!frame.ok || frame.id !== id || frame._meta.runtimeId !== options.runtimeId) {
              fail();
              return;
            }
            if (unary && frame.streaming) {
              fail();
              return;
            }
            receive(frame.result);
            if (!ready) {
              ready = true;
              clearTimeout(timeout);
              resolve(stop);
            }
            if (!frame.streaming) {
              if (unary) {
                void stop();
                return;
              }
              fail();
              return;
            }
          } catch {
            fail();
            return;
          }
        }
      });
    });
  return {
    open: request,
    describe: async (handle) => {
      let result: unknown;
      const stop = await request(
        "terminal.agentEvents.describe",
        { terminalHandle: handle },
        (value) => {
          result = value;
        },
        true,
      );
      await stop();
      return z.object({ target: notificationTargetSchema }).strict().parse(result).target;
    },
  };
}
