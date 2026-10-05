// Offline probe: synthetic Orca only, no tunnel, key, callback, or live agent.
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
const client = new Client({ name: "events-compatibility-probe", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("dist/mcp.mjs")],
  env: { ORCA_BIN: resolve("test/fixtures/orca.mjs"), ORCA_BRIDGE_STATUS_ONLY: "1" },
  stderr: "pipe",
});
const methods = {};
try {
  await client.connect(transport);
  for (const method of ["server/discover", "events/list"]) {
    try {
      await client.request({ method, params: {} }, z.object({}).passthrough(), { timeout: 5000 });
      methods[method] = "responded";
    } catch (error) {
      methods[method] = error?.code === -32601 ? "method_not_found" : "probe_failed";
    }
  }
  console.log(
    JSON.stringify(
      {
        scope: "offline_synthetic_stdio_only",
        requiredProtocol: "2026-07-28",
        sdkSupportsRequiredProtocol: SUPPORTED_PROTOCOL_VERSIONS.includes("2026-07-28"),
        methods,
        tunnelEventsVerified: false,
        dotDeliveryVerified: false,
      },
      null,
      2,
    ),
  );
} catch {
  console.error("Offline compatibility probe failed; rebuild the bridge and retry.");
  process.exitCode = 1;
} finally {
  await client.close();
}
