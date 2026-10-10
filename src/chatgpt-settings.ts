import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Trial of OpenAI's MCP Extensions structured settings (`openai/settings`):
// ChatGPT renders these on the plugin page with native controls. Nothing here
// changes what the bridge does to Orca; the only write is this server's own
// settings file.

export const settingsTools = {
  read: "orca_settings_read",
  update: "orca_settings_update",
  ping: "orca_bridge_ping",
} as const;

export const settingsCapability = {
  "openai/settings": { readTool: settingsTools.read, updateTool: settingsTools.update },
};

const properties = {
  trialFlag: {
    type: "boolean",
    title: "設定表示の試験",
    description: "ChatGPT から Mac の設定を読み書きできるかの確認用です。動作には影響しません。",
  },
} as const;
type Values = { trialFlag: boolean };
const defaults: Values = { trialFlag: false };

export function chatgptSettingsPath(home = homedir()) {
  return join(home, ".orca-dots-bridge", "chatgpt-settings.json");
}

export async function readSettings(path: string): Promise<Values> {
  const text = await readFile(path, "utf8").catch(() => "");
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      const flag = (parsed as Record<string, unknown>).trialFlag;
      return { trialFlag: typeof flag === "boolean" ? flag : defaults.trialFlag };
    }
  } catch {
    // Missing or unreadable settings fall back to defaults.
  }
  return { ...defaults };
}

async function writeSettings(path: string, values: Values) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

export function settingsReadResult(values: Values) {
  return {
    schema: { type: "object" as const, properties },
    values,
    layout: [
      {
        kind: "group" as const,
        title: "Orca Dots Bridge（試験）",
        items: [
          { kind: "property" as const, property: "trialFlag" },
          { kind: "tool" as const, tool: settingsTools.ping },
        ],
      },
    ],
  };
}

export const updateShape = {
  set: z.object({ trialFlag: z.boolean().optional() }).strict(),
};

export async function updateSettings(path: string, set: { trialFlag?: boolean }) {
  const values = { ...(await readSettings(path)), ...set };
  await writeSettings(path, values);
  return values;
}

export function registerChatgptSettings(server: McpServer, path = chatgptSettingsPath()) {
  const structured = (value: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  });
  server.registerTool(
    settingsTools.read,
    {
      title: "Orca Dots Bridge の設定を読む",
      description: "Read this bridge's ChatGPT plugin settings. No Orca access.",
      inputSchema: {},
      outputSchema: {
        schema: z.record(z.string(), z.unknown()),
        values: z.record(z.string(), z.unknown()),
        layout: z.array(z.record(z.string(), z.unknown())).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => structured(settingsReadResult(await readSettings(path))),
  );
  server.registerTool(
    settingsTools.update,
    {
      title: "Orca Dots Bridge の設定を変える",
      description:
        "Called by ChatGPT's settings page with changed values only. Do not call from chat. No Orca access.",
      inputSchema: updateShape,
      outputSchema: { values: z.record(z.string(), z.unknown()) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ set }) => structured({ values: await updateSettings(path, set) }),
  );
  server.registerTool(
    settingsTools.ping,
    {
      title: "Mac への接続を確認",
      description: "Confirms the plugin reaches the bridge on the Mac. No Orca access.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => ({
      content: [
        {
          type: "text" as const,
          text: `Mac の bridge に届きました（${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}）`,
        },
      ],
    }),
  );
}
