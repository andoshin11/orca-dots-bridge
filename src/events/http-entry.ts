import { z } from "zod";
import {
  McpServer,
  createMcpHandler,
  fromJsonSchema,
  ProtocolError,
} from "@modelcontextprotocol/server";
import { EventError } from "./webhook.js";
import type { DiagnosticRecord, DiagnosticStage } from "./preflight-diagnostics.js";
/** No listener or credential defaults. The caller supplies a verified token resolver and durable engine. */
export function createSessionMcpHttpEntry(
  rpc: {
    dispatch: (
      owner: string,
      method: string,
      params: unknown,
      signal?: AbortSignal,
      operationSignal?: AbortSignal,
    ) => Promise<Record<string, unknown>>;
  },
  resolveOwner: (authorization: string | undefined) => Promise<string>,
  diagnostic?: DiagnosticRecord,
) {
  return async (request: Request): Promise<Response> => {
    let owner: string;
    diagnostic?.("mcp_arrived");
    try {
      owner = await resolveOwner(request.headers.get("authorization") ?? undefined);
    } catch {
      diagnostic?.("auth_rejected");
      return new Response("Unauthorized", { status: 401 });
    }
    diagnostic?.("auth_accepted");
    let observedMethod = "";
    let dispatched = false;
    if (diagnostic) {
      const version = request.headers.get("MCP-Protocol-Version");
      diagnostic(
        version === "2026-07-28"
          ? "version_current"
          : version
            ? "version_other"
            : "version_missing",
      );
      let raw: unknown;
      try {
        raw = await request.clone().json();
      } catch {
        diagnostic("json_invalid");
      }
      const envelope = z.object({ jsonrpc: z.literal("2.0"), method: z.string() }).safeParse(raw);
      if (!envelope.success) diagnostic("envelope_invalid");
      else {
        const methods: Record<string, DiagnosticStage> = {
          "server/discover": "method_discover",
          "tools/list": "method_tools_list",
          "events/list": "method_events_list",
          "events/subscribe": "method_subscribe",
          "events/unsubscribe": "method_unsubscribe",
        };
        observedMethod = envelope.data.method;
        diagnostic(
          Object.hasOwn(methods, observedMethod) ? methods[observedMethod]! : "method_other",
        );
      }
    }
    const handler = createMcpHandler(
      () => {
        const server = new McpServer({ name: "orca-session-events", version: "0.1.0" });
        const capabilities = { tools: {}, events: {} };
        server.server.registerCapabilities(capabilities);
        server.server.setRequestHandler(
          "tools/list",
          { params: fromJsonSchema({ type: "object" }) },
          async () => {
            dispatched = true;
            diagnostic?.("rpc_dispatch");
            return { tools: [] };
          },
        );
        for (const method of ["events/list", "events/subscribe", "events/unsubscribe"]) {
          server.server.setRequestHandler(
            method,
            { params: fromJsonSchema({ type: "object" }) },
            async (params, context) => {
              dispatched = true;
              diagnostic?.("rpc_dispatch");
              try {
                const { _meta: _protocolMetadata, ...input } = z.record(z.unknown()).parse(params);
                if (request.signal.aborted || context.mcpReq.signal.aborted)
                  throw new EventError("request_cancelled");
                return await rpc.dispatch(
                  owner,
                  method,
                  input,
                  request.signal,
                  context.mcpReq.signal,
                );
              } catch (error) {
                diagnostic?.("rpc_rejected");
                throw new ProtocolError(
                  error instanceof EventError &&
                    ["callback_verification_failed", "callback_approval_required"].includes(
                      error.code,
                    )
                    ? -32015
                    : -32602,
                  "Event request rejected",
                  error instanceof EventError && error.code === "callback_approval_required"
                    ? { reason: "callback_approval_required" }
                    : error instanceof EventError && error.code === "callback_verification_failed"
                      ? {
                          reason:
                            error.reason === "callback_timeout" ||
                            error.reason === "challenge_reply_late"
                              ? "timeout"
                              : "challenge_failed",
                        }
                      : undefined,
                );
              }
            },
          );
        }
        return server;
      },
      { legacy: "reject" },
    );
    try {
      const response = await handler.fetch(request);
      if (diagnostic) {
        diagnostic(
          response.status >= 200 && response.status < 300
            ? "response_2xx"
            : response.status >= 400 && response.status < 500
              ? "response_4xx"
              : response.status >= 500
                ? "response_5xx"
                : "response_other",
        );
        if (!dispatched && observedMethod !== "server/discover")
          diagnostic("protocol_without_dispatch");
        if (response.headers.get("content-type")?.includes("application/json")) {
          const body: unknown = await response.clone().json();
          if (z.object({ error: z.object({ code: z.number() }) }).safeParse(body).success)
            diagnostic("rpc_error");
        }
      }
      return response;
    } catch {
      diagnostic?.("protocol_exception");
      throw new Error("protocol_request_failed");
    }
  };
}
