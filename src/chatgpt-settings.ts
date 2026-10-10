import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BridgeError } from "./errors.js";

// Settings shown on the ChatGPT plugin page through OpenAI MCP Extensions
// structured settings (`openai/settings`). ChatGPT renders them with native
// controls; this server only persists the values. Whoever controls the ChatGPT
// account can change them, which the owner accepted for personal use.

export const settingsTools = {
  read: "orca_settings_read",
  update: "orca_settings_update",
} as const;

export const settingsCapability = {
  "openai/settings": { readTool: settingsTools.read, updateTool: settingsTools.update },
};

const properties = {
  sendEnabled: {
    type: "boolean",
    title: "指示の送信を許可",
    description:
      "オンにすると、dot から Orca のエージェント1つへ追加の指示を送れます。送る前に ChatGPT が確認します。",
  },
} as const;
export type ChatgptSettings = { sendEnabled: boolean };
// Everything that widens what ChatGPT can do starts off.
const defaults: ChatgptSettings = { sendEnabled: false };

export function chatgptSettingsPath(home = homedir()) {
  return join(home, ".orca-dots-bridge", "chatgpt-settings.json");
}

/** Reads fresh on every call; anything missing or malformed falls back to the closed default. */
export async function readSettings(path: string): Promise<ChatgptSettings> {
  const text = await readFile(path, "utf8").catch(() => "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...defaults };
  }
  const values = typeof parsed === "object" && parsed !== null ? parsed : {};
  const send = (values as Record<string, unknown>).sendEnabled;
  return { sendEnabled: send === true };
}

async function writeSettings(path: string, values: ChatgptSettings) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

export function settingsReadResult(values: ChatgptSettings) {
  return {
    schema: { type: "object" as const, properties },
    values,
    layout: [
      {
        kind: "group" as const,
        title: "Orca への操作",
        items: [{ kind: "property" as const, property: "sendEnabled" }],
      },
    ],
  };
}

export const updateShape = {
  set: z.object({ sendEnabled: z.boolean().optional() }).strict(),
};

export async function updateSettings(path: string, set: Partial<ChatgptSettings>) {
  const values = { ...(await readSettings(path)), ...set };
  await writeSettings(path, values);
  return values;
}

/** Fails closed unless the ChatGPT setting currently allows sending. */
export async function assertSendAllowed(path: string) {
  if (!(await readSettings(path)).sendEnabled)
    throw new BridgeError(
      "send_disabled",
      "Sending is turned off. The user can turn on 指示の送信を許可 in this plugin's settings in ChatGPT. Do not retry until they do.",
    );
}

// Settings tools are for ChatGPT's settings page, not for the model in chat.
const settingsPageOnly = { ui: { visibility: ["app"] } };

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
      _meta: settingsPageOnly,
    },
    async () => structured(settingsReadResult(await readSettings(path))),
  );
  server.registerTool(
    settingsTools.update,
    {
      title: "Orca Dots Bridge の設定を変える",
      description:
        "Only for ChatGPT's plugin settings page, which sends changed values. Never call from chat. No Orca access.",
      inputSchema: updateShape,
      outputSchema: { values: z.record(z.string(), z.unknown()) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: settingsPageOnly,
    },
    async ({ set }) => structured({ values: await updateSettings(path, set) }),
  );
}
