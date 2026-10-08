import { expect, it, vi } from "vitest";
import { createSessionMcpHttpEntry } from "../src/events/http-entry.js";

// Research regression: do not disguise a failed events subscription as an
// input-required tool round. No engine, network sender or live credentials.
it.each(["input_required", "pending"])(
  "the installed SDK rejects %s as an events/subscribe continuation",
  async (resultType) => {
    const dispatch = vi.fn(async () => ({
      resultType,
      requestState: "synthetic-opaque-state",
      inputRequests: {},
    }));
    const fetch = createSessionMcpHttpEntry({ dispatch }, async () => "synthetic-owner");
    const response = await fetch(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "events/subscribe",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "events/subscribe",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {}, url: {} } },
            },
          },
        }),
      }),
    );
    const result = await response.json();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.error.code).toBe(-32603);
    expect(result.result).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("synthetic-opaque-state");
  },
);
