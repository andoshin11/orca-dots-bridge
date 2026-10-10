import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  chatgptSettingsPath,
  readSettings,
  settingsReadResult,
  settingsTools,
  updateSettings,
} from "../src/chatgpt-settings.js";

const tempHome = () => mkdtemp(join(tmpdir(), "chatgpt-settings-"));

/** Sends JSON-RPC lines to the built MCP server and collects responses by id. */
async function rpc(env: Record<string, string>, requests: object[]) {
  const child = spawn(process.execPath, ["dist/mcp.mjs"], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const responses = new Map<number, any>();
  let buffer = "";
  const ids = requests.flatMap((r) => ("id" in r ? [r.id as number] : []));
  const done = new Promise<void>((resolve) => {
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        responses.set(message.id, message);
        if (ids.every((id) => responses.has(id))) resolve();
      }
    });
  });
  for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  await done;
  child.kill();
  return responses;
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "t", version: "1" },
  },
};
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };

describe("ChatGPT structured settings trial", () => {
  test("missing or malformed settings read as defaults", async () => {
    const home = await tempHome();
    const path = chatgptSettingsPath(home);
    expect(await readSettings(path)).toEqual({ trialFlag: false });
    const malformed = join(home, "malformed.json");
    await writeFile(malformed, '{"trialFlag": "yes"');
    expect(await readSettings(malformed)).toEqual({ trialFlag: false });
    await writeFile(malformed, '{"trialFlag": "yes"}');
    expect(await readSettings(malformed)).toEqual({ trialFlag: false });
  });

  test("updates persist privately and keep a value for every property", async () => {
    const path = chatgptSettingsPath(await tempHome());
    expect(await updateSettings(path, { trialFlag: true })).toEqual({ trialFlag: true });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ trialFlag: true });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const result = settingsReadResult(await readSettings(path));
    expect(Object.keys(result.values)).toEqual(Object.keys(result.schema.properties));
    expect(result.layout[0]?.items).toContainEqual({ kind: "property", property: "trialFlag" });
  });

  test("the server advertises settings only when opted in", async () => {
    const home = await tempHome();
    const base = { HOME: home, ORCA_BRIDGE_STATUS_ONLY: "1" };
    const off = await rpc(base, [initialize, initialized, list]);
    expect(off.get(1).result.capabilities.extensions).toBeUndefined();
    expect(off.get(2).result.tools.map((t: { name: string }) => t.name)).toEqual(["orca_status"]);

    const on = await rpc({ ...base, ORCA_BRIDGE_CHATGPT_SETTINGS: "1" }, [
      initialize,
      initialized,
      list,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: settingsTools.update, arguments: { set: { trialFlag: true } } },
      },
    ]);
    const capability = { readTool: settingsTools.read, updateTool: settingsTools.update };
    expect(on.get(1).result.capabilities.extensions["openai/settings"]).toEqual(capability);
    expect(on.get(1).result.capabilities.experimental["openai/settings"]).toEqual(capability);
    expect(on.get(2).result.tools.map((t: { name: string }) => t.name)).toEqual([
      "orca_status",
      settingsTools.read,
      settingsTools.update,
      settingsTools.ping,
    ]);
    expect(on.get(3).result.structuredContent).toEqual({ values: { trialFlag: true } });
    expect(await readSettings(chatgptSettingsPath(home))).toEqual({ trialFlag: true });
  });
});
