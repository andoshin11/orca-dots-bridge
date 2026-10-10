import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  chatgptSettingsPath,
  fromSettingsPage,
  readSettings,
  settingsReadResult,
  settingsTools,
  updateSettings,
} from "../src/chatgpt-settings.js";

const tempHome = () => mkdtemp(join(tmpdir(), "chatgpt-settings-"));

/** Sends JSON-RPC lines to the built MCP server and collects responses by id. */
/**
 * Sends JSON-RPC lines to the built MCP server and collects responses by id.
 * Like a real client, it waits for the initialize result before sending the rest.
 */
async function rpc(env: Record<string, string>, requests: object[]) {
  const child = spawn(process.execPath, ["dist/mcp.mjs"], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const responses = new Map<number, any>();
  const waiters: { ids: number[]; resolve: () => void }[] = [];
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      responses.set(message.id, message);
      for (const w of waiters) if (w.ids.every((id) => responses.has(id))) w.resolve();
    }
  });
  const waitFor = (ids: number[]) =>
    new Promise<void>((resolve, reject) => {
      if (ids.every((id) => responses.has(id))) return resolve();
      const timer = setTimeout(
        () => reject(new Error(`no response for ${ids.join(",")}; stderr: ${stderr}`)),
        8000,
      );
      waiters.push({ ids, resolve: () => (clearTimeout(timer), resolve()) });
    });
  try {
    const [first, ...rest] = requests;
    child.stdin.write(`${JSON.stringify(first)}\n`);
    if (first && "id" in first) await waitFor([first.id as number]);
    for (const request of rest) child.stdin.write(`${JSON.stringify(request)}\n`);
    await waitFor(rest.flatMap((r) => ("id" in r ? [r.id as number] : [])));
    return responses;
  } finally {
    child.kill();
  }
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
const update = (id: number, sendEnabled: boolean, meta?: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: {
    name: settingsTools.update,
    arguments: { set: { sendEnabled } },
    ...(meta ? { _meta: meta } : {}),
  },
});

describe("ChatGPT plugin settings", () => {
  test("missing or malformed settings read as defaults", async () => {
    const home = await tempHome();
    const path = chatgptSettingsPath(home);
    expect(await readSettings(path)).toEqual({ sendEnabled: false });
    const malformed = join(home, "malformed.json");
    await writeFile(malformed, '{"sendEnabled": "yes"');
    expect(await readSettings(malformed)).toEqual({ sendEnabled: false });
    await writeFile(malformed, '{"sendEnabled": "yes"}');
    expect(await readSettings(malformed)).toEqual({ sendEnabled: false });
  });

  test("updates persist privately and keep a value for every property", async () => {
    const path = chatgptSettingsPath(await tempHome());
    expect(await updateSettings(path, { sendEnabled: true })).toEqual({ sendEnabled: true });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ sendEnabled: true });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const result = settingsReadResult(await readSettings(path));
    expect(Object.keys(result.values)).toEqual(Object.keys(result.schema.properties));
    expect(result.layout[0]?.items).toContainEqual({ kind: "property", property: "sendEnabled" });
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
      update(3, true, { "openai/action_name": settingsTools.update }),
    ]);
    const capability = { readTool: settingsTools.read, updateTool: settingsTools.update };
    expect(on.get(1).result.capabilities.extensions["openai/settings"]).toEqual(capability);
    expect(on.get(1).result.capabilities.experimental["openai/settings"]).toEqual(capability);
    expect(on.get(2).result.tools.map((t: { name: string }) => t.name)).toEqual([
      "orca_status",
      settingsTools.read,
      settingsTools.update,
    ]);
    expect(on.get(3).result.structuredContent).toEqual({ values: { sendEnabled: true } });
    expect(await readSettings(chatgptSettingsPath(home))).toEqual({ sendEnabled: true });
  });

  test("only the settings page can turn sending on; anything can turn it off", async () => {
    expect(fromSettingsPage({ "openai/action_name": "x" })).toBe(true);
    expect(fromSettingsPage({ "openai/action_name": "x", "openai/session": "s" })).toBe(false);
    expect(fromSettingsPage({ "openai/session": "s" })).toBe(false);
    expect(fromSettingsPage(undefined)).toBe(false);

    const home = await tempHome();
    const env = { HOME: home, ORCA_BRIDGE_STATUS_ONLY: "1", ORCA_BRIDGE_CHATGPT_SETTINGS: "1" };
    const fromChat = { "openai/session": "s", "openai/locale": "ja-JP" };
    const chat = await rpc(env, [
      initialize,
      initialized,
      update(3, true, fromChat),
      update(4, true),
    ]);
    for (const id of [3, 4]) {
      expect(chat.get(id).result.isError).toBe(true);
      expect(chat.get(id).result.content[0].text).toContain("settings page");
    }
    expect(await readSettings(chatgptSettingsPath(home))).toEqual({ sendEnabled: false });

    await updateSettings(chatgptSettingsPath(home), { sendEnabled: true });
    const off = await rpc(env, [initialize, initialized, update(3, false, fromChat)]);
    expect(off.get(3).result.structuredContent).toEqual({ values: { sendEnabled: false } });
  });

  test("send is exposed but refused until the ChatGPT setting allows it", async () => {
    const home = await tempHome();
    const env = {
      HOME: home,
      ORCA_BRIDGE_TOOLSET: "status-send",
      ORCA_BRIDGE_ENABLE_SEND: "1",
      ORCA_BRIDGE_CHATGPT_SETTINGS: "1",
    };
    const send = {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "orca_send_instruction",
        arguments: { handle: "term_x", text: "hi", expectedWorktreeId: "wt" },
      },
    };
    const responses = await rpc(env, [initialize, initialized, list, send]);
    expect(responses.get(2).result.tools.map((t: { name: string }) => t.name)).toContain(
      "orca_send_instruction",
    );
    expect(responses.get(3).result.isError).toBe(true);
    expect(JSON.parse(responses.get(3).result.content[0].text).error.code).toBe("send_disabled");

    await mkdir(dirname(chatgptSettingsPath(home)), { recursive: true });
    await writeFile(chatgptSettingsPath(home), '{"sendEnabled": "true"}');
    const loose = await rpc(env, [initialize, initialized, send]);
    expect(JSON.parse(loose.get(3).result.content[0].text).error.code).toBe("send_disabled");

    // Allowed: the call passes the gate and reaches Orca (absent here, so it fails there).
    await writeFile(chatgptSettingsPath(home), '{"sendEnabled": true}');
    const allowed = await rpc({ ...env, PATH: "/usr/bin:/bin", ORCA_BIN: "/nonexistent/orca" }, [
      initialize,
      initialized,
      send,
    ]);
    expect(JSON.parse(allowed.get(3).result.content[0].text).error.code).not.toBe("send_disabled");
  });
});
