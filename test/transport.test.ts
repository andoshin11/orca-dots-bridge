import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { beforeAll, expect, test } from "vite-plus/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
beforeAll(() => {
  execFileSync(resolve("node_modules/.bin/vp"), ["pack"], { stdio: "pipe" });
});
test("built CLI emits machine-readable result and fails unknown commands", () => {
  const env = { ...process.env, ORCA_BIN: resolve("test/fixtures/orca.mjs"), ORCA_ENVIRONMENT: "" };
  const result = JSON.parse(
    execFileSync(process.execPath, ["dist/cli.mjs", "overview"], { env, encoding: "utf8" }),
  );
  expect(result.ok).toBe(true);
  expect(result.result.items).toEqual([]);
  expect(result.result.hostCoverageVerified).toBe(false);
  expect(() =>
    execFileSync(process.execPath, ["dist/cli.mjs", "send"], { env, stdio: "pipe" }),
  ).toThrow();
});
test("stdio MCP initializes, lists exactly six read-only tools, executes and reports validation errors", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/mcp.mjs")],
    env: { ORCA_BIN: resolve("test/fixtures/orca.mjs"), ORCA_ENVIRONMENT: "" },
    stderr: "pipe",
  });
  const client = new Client({ name: "bridge-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual([
      "orca_overview",
      "orca_status",
      "orca_task_detail",
      "orca_task_logs",
      "orca_terminal_inspect",
      "orca_waiting",
    ]);
    expect(listed.tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
    const result = await client.callTool({ name: "orca_overview", arguments: { limit: 1 } });
    expect(result.isError).not.toBe(true);
    const content = result.content as { type: string; text: string }[];
    expect(JSON.parse(content[0]!.text).items).toEqual([]);
    const status = await client.callTool({
      name: "orca_status",
      arguments: { repo: "sample", name: "review" },
    });
    expect(status.isError).not.toBe(true);
    expect(JSON.parse((status.content as { text: string }[])[0]!.text).resolution).toBe(
      "not_found",
    );
    const invalid = await client.callTool({
      name: "orca_task_logs",
      arguments: { handle: "term_1", limit: 10000 },
    });
    expect(invalid.isError).toBe(true);
  } finally {
    await client.close();
  }
});

test("CLI send works with synthetic target and rejects implicit target", () => {
  const env = { ...process.env, ORCA_BIN: resolve("test/fixtures/orca.mjs"), ORCA_ENVIRONMENT: "" };
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      ["dist/cli.mjs", "send", "--handle", "term_fixture", "--text", "synthetic instruction"],
      { env, encoding: "utf8" },
    ),
  );
  expect(result.result).toMatchObject({ accepted: true, completion: "not_observed" });
  expect(() =>
    execFileSync(process.execPath, ["dist/cli.mjs", "send", "--text", "test"], {
      env,
      stdio: "pipe",
    }),
  ).toThrow();
});
test("opt-in MCP send is explicitly mutating and non-idempotent", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/mcp.mjs")],
    env: {
      ORCA_BIN: resolve("test/fixtures/orca.mjs"),
      ORCA_ENVIRONMENT: "",
      ORCA_BRIDGE_ENABLE_SEND: "1",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "send-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    expect(tools).toHaveLength(7);
    expect(tools.find((t) => t.name === "orca_send_instruction")?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: true,
    });
    const response = await client.callTool({
      name: "orca_send_instruction",
      arguments: { handle: "term_fixture", text: "synthetic instruction" },
    });
    expect(response.isError).not.toBe(true);
    const content = response.content as { text: string }[];
    expect(JSON.parse(content[0]!.text)).toMatchObject({
      accepted: true,
      completion: "not_observed",
    });
  } finally {
    await client.close();
  }
});

test("built CLI inspect returns terminal and logs in one invocation", () => {
  const env = { ...process.env, ORCA_BIN: resolve("test/fixtures/orca.mjs"), ORCA_ENVIRONMENT: "" };
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "dist/cli.mjs",
        "inspect",
        "--handle",
        "term_fixture",
        "--expected-worktree-id",
        "w1",
        "--limit",
        "2",
      ],
      { env, encoding: "utf8" },
    ),
  );
  expect(result.result).toMatchObject({
    scope: "single_terminal",
    terminal: { handle: "term_fixture", worktreeId: "w1" },
    log: { text: "synthetic output" },
  });
});

test("CLI status accepts exact selectors and returns compact resolution", () => {
  const env = { ...process.env, ORCA_BIN: resolve("test/fixtures/orca.mjs"), ORCA_ENVIRONMENT: "" };
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "dist/cli.mjs",
        "status",
        "--repo",
        "sample",
        "--name",
        "review",
        "--branch",
        "feature",
        "--host-id",
        "local",
      ],
      { env, encoding: "utf8" },
    ),
  );
  expect(result.result).toMatchObject({
    resolution: "not_found",
    notificationDelivery: "outside_bridge",
  });
});

test("status-only MCP denies every other tool even with send opt-in", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/mcp.mjs")],
    env: {
      ORCA_BIN: resolve("test/fixtures/orca.mjs"),
      ORCA_BRIDGE_STATUS_ONLY: "1",
      ORCA_BRIDGE_ENABLE_SEND: "1",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "status-only-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["orca_status"]);
    const result = await client.callTool({
      name: "orca_status",
      arguments: { repo: "sample", name: "review" },
    });
    expect(result.isError).not.toBe(true);
    for (const name of ["orca_overview", "orca_task_logs", "orca_send_instruction"]) {
      expect((await client.callTool({ name, arguments: {} })).isError).toBe(true);
    }
  } finally {
    await client.close();
  }
});
