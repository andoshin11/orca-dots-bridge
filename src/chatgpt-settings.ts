import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
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
  notificationsEnabled: {
    type: "boolean",
    title: "通知を受け取る",
    description:
      "オンにすると、dot に頼んだ Orca のペインのターン終了・入力待ちを通知します（Orca で Agent Status Relay プラグインを有効にしておく必要があります）。オフにすると購読をすべて止めます。",
  },
} as const;
export type ChatgptSettings = { sendEnabled: boolean; notificationsEnabled: boolean };
// Everything that widens what ChatGPT can do starts off.
const defaults: ChatgptSettings = { sendEnabled: false, notificationsEnabled: false };

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
  const values = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >;
  return {
    sendEnabled: values.sendEnabled === true,
    notificationsEnabled: values.notificationsEnabled === true,
  };
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
      {
        kind: "group" as const,
        title: "通知",
        items: [{ kind: "property" as const, property: "notificationsEnabled" }],
      },
    ],
  };
}

export const updateShape = {
  set: z
    .object({ sendEnabled: z.boolean().optional(), notificationsEnabled: z.boolean().optional() })
    .strict(),
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

/**
 * ChatGPT's settings page calls carry `openai/action_name` and no `openai/session`;
 * calls the model makes in chat carry `openai/session` (observed October 2026). The
 * model appears to control only arguments, not this metadata. This is observed, not
 * documented, behavior, so any
 * change makes enabling fail (closed) rather than open. `_meta.ui.visibility: ["app"]`
 * cannot be used instead: it hides the tools from the settings page as well.
 */
export function fromSettingsPage(meta: Record<string, unknown> | undefined) {
  return (
    meta !== undefined &&
    typeof meta["openai/action_name"] === "string" &&
    !("openai/session" in meta)
  );
}
