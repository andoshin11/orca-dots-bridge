// Explicit live read-only check. Not part of npm test / verify.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const startedAt = new Date().toISOString();
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../dist/mcp.mjs", import.meta.url))],
  env: {
    ORCA_BIN: process.env.ORCA_BIN || "orca",
    ORCA_ENVIRONMENT: "",
    ORCA_PAIRING_CODE: "",
  },
  stderr: "pipe",
});
// Drain diagnostics but do not persist or echo logs/secrets.
transport.stderr?.resume();
const client = new Client({ name: "orca-bridge-local-verification", version: "0.1.0" });
const calls = [];
async function call(name, args) {
  const start = Date.now();
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  assert(!response.isError, `${name} failed: ${JSON.stringify(response.content)}`);
  const text = response.content.find((c) => c.type === "text");
  assert(text, `${name} returned no text`);
  const result = JSON.parse(text.text);
  assert(result.fetchedAt, `${name} returned no freshness timestamp`);
  calls.push({ tool: name, elapsedMs: Date.now() - start, fetchedAt: result.fetchedAt });
  return result;
}
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "orca_overview",
    "orca_task_detail",
    "orca_task_logs",
    "orca_waiting",
  ]);
  assert(tools.every((t) => t.annotations?.readOnlyHint));
  const overview = await call("orca_overview", { limit: 20 });
  assert(!overview.inventoryIncomplete, "Inventory is incomplete");
  assert(overview.worktreeHostScope?.hostIds.includes("local"), "Local host was not observed");
  if (overview.nextCursor) {
    const second = await call("orca_overview", { limit: 20, cursor: overview.nextCursor });
    assert(
      !second.items.some((w) => overview.items.some((previous) => previous.id === w.id)),
      "Duplicate page members",
    );
  }
  let cursor;
  let pages = 0,
    examined = 0,
    attention = 0,
    errors = 0,
    unevaluated = 0;
  do {
    const waiting = await call("orca_waiting", { limit: 20, ...(cursor ? { cursor } : {}) });
    assert(!waiting.inventoryIncomplete, "Waiting inventory is incomplete");
    pages++;
    examined += waiting.examined;
    attention += waiting.items.length;
    errors += waiting.errors.length;
    unevaluated += waiting.unevaluatedWaitCount;
    cursor = waiting.nextCursor;
    assert(pages <= 100, "Waiting scan exceeded safety bound");
  } while (cursor);
  assert.equal(errors, 0, "Some terminal inspections failed");
  let detail;
  for (const worktree of overview.items.filter((w) => w.agentCount > 0).slice(0, 5)) {
    const result = await call("orca_task_detail", { id: worktree.id });
    assert.equal(result.task.id, worktree.id);
    if (result.terminals.some((t) => t.connected && !t.error)) {
      detail = result;
      break;
    }
  }
  assert(detail, "No connected terminal found in the bounded detail sample; logs not tested");
  const terminal = detail.terminals.find((t) => t.connected && !t.error);
  const log = await call("orca_task_logs", { handle: terminal.handle, limit: 2, maxChars: 200 });
  assert.equal(log.handle, terminal.handle);
  assert(log.text.length <= 200);
  console.log(
    JSON.stringify(
      {
        ok: true,
        startedAt,
        finishedAt: new Date().toISOString(),
        target: "local",
        transport: "MCP SDK client -> stdio bridge -> Orca CLI -> local runtime",
        dotRegistrationVerified: false,
        audioRoundTripVerified: false,
        tools: tools.map((t) => t.name),
        overview: {
          worktrees: overview.worktreeTotal,
          terminals: overview.terminalTotal,
          hostScope: overview.worktreeHostScope,
          agentCounts: overview.agentCounts,
          fetchedAt: overview.fetchedAt,
        },
        waiting: {
          pages,
          examined,
          attention,
          errors,
          unevaluated,
          note: "Pages are fresh reads, not one atomic fleet snapshot. Unevaluated waits remain unknown.",
        },
        detail: {
          matchedRequestedId: true,
          terminalCount: detail.terminals.length,
          observedAgentFreshness: detail.task.agents.map((a) => a.freshness),
        },
        logs: {
          characters: log.text.length,
          source: log.source,
          outputClipped: log.outputClipped,
          cursorUsableForHistory: log.cursorUsableForHistory,
        },
        calls,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(JSON.stringify({ ok: false, message: error.message, calls }));
  process.exitCode = 1;
} finally {
  await client.close();
}
