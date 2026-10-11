import { constants } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createRunner } from "../adapter.js";
import { readSettings, settingsCapability } from "../chatgpt-settings.js";
import { Bridge } from "../service.js";
import {
  callTool,
  defineTool,
  findTool,
  listEntry,
  sendTool,
  settingsToolDefinitions,
  statusTool,
  type ToolDefinition,
} from "../tools.js";
import { EventEngine, subscribeSchema, unsubscribeSchema } from "./engine.js";
import { openAtomicStore } from "./file-store.js";
import { createSessionMcpHttpEntry, type SessionTools } from "./http-entry.js";
import { createMacKeychain, type KeyAccount } from "./keychain.js";
import { createLoopbackServer } from "./loopback-server.js";
import { createPaneDescriber, paneTargetSchema, type PaneDescriber } from "./pane-contract.js";
import { createRelayHub, paneCatalog, PaneEventsRpc } from "./pane-rpc.js";
import { createPreflightDiagnostics, type DiagnosticRecord } from "./preflight-diagnostics.js";
import { createRelayIngress, createRelayServer } from "./relay-ingress.js";
import { createServiceKeyResolver } from "./service-key.js";
import { callbackUrl, createPost, EventError, type Post } from "./webhook.js";

// The always-on bridge service: the single MCP endpoint the one Tunnel forwards
// to. It serves orca_find, orca_status, orca_send_instruction (refused unless the ChatGPT
// setting 指示の送信を許可 is on), the ChatGPT settings tools, and MCP Events
// notifications. It keeps subscriptions across restarts, accepts several panes
// and lets ChatGPT refresh subscriptions (up to a day each). Whether it may notify
// at all is the ChatGPT plugin setting 通知を受け取る, read on every subscribe,
// event and delivery: turning it off drops every subscription.

/** Hosts ChatGPT is known to use for MCP Events callbacks; extendable in settings.json. */
export const defaultCallbackHosts = ["connectors.api.openai.com"] as const;
/** Fixed so the Tunnel profile and its LaunchAgent always point at the service. */
export const servicePort = 8787;
const maxTtlMs = 86400000;
// The service key never expires on its own; turning notifications off is the switch.
const noExpiry = Date.UTC(9999, 0, 1);

/** dot only sees handles and worktree IDs (from orca_find or orca_status), not pane keys. */
const shortTargetSchema = z
  .object({
    terminalHandle: z.string().min(1).max(4096),
    worktreeId: z.string().min(1).max(4096),
  })
  .strict();

const shortInputSchema = {
  type: "object",
  properties: {
    terminalHandle: { type: "string", minLength: 1, maxLength: 4096 },
    worktreeId: { type: "string", minLength: 1, maxLength: 4096 },
  },
  required: ["terminalHandle", "worktreeId"],
  additionalProperties: false,
};
const paneEvent = paneCatalog[0]!;
const howToSubscribe =
  "Pass the terminalHandle and worktreeId that orca_find or orca_status returned for the agent. Pane-scoped: a new agent session in the same pane is not distinguished and missed events are not detected; report a received observation, never assert it as confirmed.";
/**
 * One event per kind, so the kind is in the event name: a subscriber that does not
 * surface the payload still knows whether a turn ended or input is needed.
 */
export const serviceCatalog = [
  {
    name: "orca.pane_turn_finished",
    description: `An Orca agent's turn ended in the subscribed pane (success unconfirmed), as reported by the orca-agent-status-relay plugin. A monitoring_interrupted payload means monitoring of the pane stopped instead. ${howToSubscribe}`,
    kinds: ["turn_finished", "monitoring_interrupted"],
  },
  {
    name: "orca.pane_input_required",
    description: `An Orca agent in the subscribed pane is waiting for input or approval, as reported by the orca-agent-status-relay plugin. A monitoring_interrupted payload means monitoring of the pane stopped instead. ${howToSubscribe}`,
    kinds: ["input_required", "monitoring_interrupted"],
  },
].map(({ name, description, kinds }) => ({
  name,
  description,
  delivery: paneEvent.delivery,
  inputSchema: shortInputSchema,
  payloadSchema: {
    ...paneEvent.payloadSchema,
    properties: { ...paneEvent.payloadSchema.properties, kind: { enum: kinds } },
  },
}));

/** The newest notifications kept for orca_recent_notifications (memory only). */
const recentLimit = 20;
const recentToolName = "orca_recent_notifications";
const recentDescription =
  "Lists the Orca notifications this plugin recently delivered to you, newest first: event name, kind (turn_finished, input_required or monitoring_interrupted), when it happened, and the pane's terminal handle and worktree ID. Call it when an Orca event notification arrives without its event data. Pane-scoped observations only; never assert them as confirmed results.";
const deliveredSchema = z.object({
  eventId: z.string(),
  name: z.string(),
  timestamp: z.string(),
  data: z.object({ kind: z.string() }).passthrough(),
});

export type BridgeServiceOptions = {
  directory: string;
  settingsPath: string;
  port: number;
  relayPort: number;
  callbackHosts: readonly string[];
  keys?: { read(account: KeyAccount): Promise<Buffer> };
  describe?: PaneDescriber;
  post?: Post;
  /** How often to check the setting and drop subscriptions when it is off. */
  sweepMs?: number;
  /** Orca access for orca_find, orca_status and orca_send_instruction (the Orca CLI from ORCA_BIN by default). */
  bridge?: Bridge;
};

export async function startBridgeService(options: BridgeServiceOptions) {
  if (options.port === options.relayPort) throw new Error("relay_port_conflict");
  const keys = options.keys ?? createMacKeychain();
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const diagnosticsPath = join(options.directory, "counts.json");
  await unlink(diagnosticsPath).catch(() => undefined);
  const diagnostic: DiagnosticRecord = createPreflightDiagnostics(diagnosticsPath);
  // Keys first: a failure here must not leave a store lock behind.
  const read = (account: KeyAccount) =>
    keys.read(account).catch(() => {
      throw new Error("keychain_read_failed");
    });
  const encryptionKey = await read("outbox-v1");
  const serviceKey = await read("service-v1");
  const relayKey = await read("relay-v1");
  const store = await openAtomicStore(join(options.directory, "state"), {
    reclaimStaleLock: true,
  }).catch((error: unknown) => {
    throw new Error(
      error instanceof Error && "code" in error && error.code === "EEXIST"
        ? "store_locked"
        : "store_unavailable",
    );
  });
  const enabled = async () => (await readSettings(options.settingsPath)).notificationsEnabled;
  const auth = createServiceKeyResolver({
    keyId: "trial-service-v1",
    secret: serviceKey,
    expiresAt: noExpiry,
  });
  const describe = options.describe ?? createPaneDescriber(createRunner());
  const hub = createRelayHub();
  // Remembers what reached ChatGPT, so dot can read it with orca_recent_notifications
  // when the notification itself arrives without the event data.
  const recent: {
    subscriptionId: string;
    eventId: string;
    name: string;
    kind: string;
    at: string;
  }[] = [];
  const basePost = options.post ?? createPost(options.callbackHosts);
  const post: Post = async (url, headers, body, signal) => {
    const reply = await basePost(url, headers, body, signal);
    const delivered = deliveredSchema.safeParse(JSON.parse(body));
    const subscriptionId = headers["X-MCP-Subscription-Id"];
    if (reply.status >= 200 && reply.status < 300 && delivered.success && subscriptionId) {
      const { eventId, name, timestamp, data } = delivered.data;
      if (!recent.some((r) => r.eventId === eventId && r.subscriptionId === subscriptionId)) {
        recent.unshift({ subscriptionId, eventId, name, kind: data.kind, at: timestamp });
        recent.splice(recentLimit);
      }
    }
    return reply;
  };
  const engine = await EventEngine.open({
    key: encryptionKey,
    store,
    diagnostic,
    allowedCallbackHosts: options.callbackHosts,
    post,
    authorize: async (owner, target) =>
      owner === auth.owner && paneTargetSchema.safeParse(target).success && (await enabled()),
  });
  const rpc = new PaneEventsRpc(
    engine,
    { watch: hub.watch, describe },
    Date.now,
    maxTtlMs,
    diagnostic,
  );
  const rejectedHostPath = join(options.directory, "rejected-callback-host");
  /** Expands dot's handle + worktree ID into the full pane identity the engine keys on. */
  const resolveTarget = async (raw: unknown) => {
    const short = shortTargetSchema.safeParse(raw);
    if (!short.success) return paneTargetSchema.parse(raw);
    let target;
    try {
      target = await describe(short.data.terminalHandle);
    } catch {
      throw new EventError("runtime_unavailable");
    }
    if (target.worktreeId !== short.data.worktreeId) throw new EventError("runtime_target_changed");
    return target;
  };
  const dispatch = async (owner: string, method: string, params: unknown) => {
    if (method === "events/list") return { events: structuredClone(serviceCatalog) };
    if (method !== "events/subscribe" && method !== "events/unsubscribe")
      throw new EventError("method_not_found");
    const record = z.record(z.unknown()).parse(params);
    if (method === "events/subscribe") {
      if (!(await enabled())) {
        diagnostic("notifications_disabled");
        throw new EventError("forbidden");
      }
      const parsed = subscribeSchema.safeParse({
        ...record,
        arguments: await resolveTarget(record.arguments),
      });
      if (!parsed.success) throw new EventError("invalid_params");
      try {
        callbackUrl(parsed.data.delivery.url, options.callbackHosts);
      } catch (error) {
        // Record only the host name, so a person can add it to settings.json.
        const host = URL.canParse(parsed.data.delivery.url)
          ? new URL(parsed.data.delivery.url).hostname
          : "";
        if (/^[a-z0-9.-]{1,253}$/.test(host)) await writePlain(rejectedHostPath, `${host}\n`);
        diagnostic("callback_host_rejected");
        throw error;
      }
      return rpc.dispatch(owner, method, parsed.data);
    }
    const short = shortTargetSchema.safeParse(record.arguments);
    if (short.success) {
      // Match stored subscriptions directly: the pane may be gone or changed by now.
      const url = z.object({ url: z.string() }).safeParse(record.delivery);
      for (const s of await engine.listSubscriptions()) {
        const t = paneTargetSchema.safeParse(s.target);
        if (
          s.owner === owner &&
          s.name === record.name &&
          url.success &&
          URL.canParse(url.data.url) &&
          s.url === new URL(url.data.url).href &&
          t.success &&
          t.data.terminalHandle === short.data.terminalHandle &&
          t.data.worktreeId === short.data.worktreeId
        )
          await rpc.dispatch(owner, method, {
            name: s.name,
            arguments: t.data,
            delivery: { mode: "webhook", url: s.url },
          });
      }
      return {};
    }
    const parsed = unsubscribeSchema.safeParse(record);
    if (!parsed.success) throw new EventError("invalid_params");
    return rpc.dispatch(owner, method, parsed.data);
  };
  /** Scoped to the verified owner's subscriptions. */
  const recentTool = (owner: string) =>
    defineTool({
      name: recentToolName,
      title: "Recent Orca notifications",
      description: recentDescription,
      inputShape: { limit: z.number().int().min(1).max(recentLimit).optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      run: async ({ limit = 10 }) => {
        const subscriptions = new Map(
          (await engine.listSubscriptions())
            .filter((s) => s.owner === owner)
            .map((s) => [s.id, paneTargetSchema.safeParse(s.target)] as const),
        );
        const notifications = (await enabled())
          ? recent
              .filter((r) => subscriptions.has(r.subscriptionId))
              .slice(0, limit)
              .map((r) => {
                const target = subscriptions.get(r.subscriptionId);
                return {
                  event: r.name,
                  kind: r.kind,
                  at: r.at,
                  ...(target?.success
                    ? {
                        terminalHandle: target.data.terminalHandle,
                        worktreeId: target.data.worktreeId,
                      }
                    : {}),
                };
              })
          : [];
        return {
          content: [{ type: "text", text: JSON.stringify({ notifications }) }],
          structuredContent: { notifications },
        };
      },
    });
  const bridge = options.bridge ?? new Bridge();
  const definitions: ToolDefinition[] = [
    statusTool(bridge),
    findTool(bridge),
    // Always listed; refused on every call unless 指示の送信を許可 is on.
    sendTool(bridge, { requireExpectedWorktree: true, settingsPath: options.settingsPath }),
    ...settingsToolDefinitions(options.settingsPath),
  ];
  const byName = new Map(definitions.map((d) => [d.name, d]));
  const tools: SessionTools = {
    list: [...definitions, recentTool(auth.owner)].map(listEntry),
    capabilities: { experimental: settingsCapability, extensions: settingsCapability },
    call: async (owner, name, args, meta) => {
      const def = name === recentToolName ? recentTool(owner) : byName.get(name);
      if (!def) throw new EventError("method_not_found");
      return callTool(def, args, meta);
    },
  };
  const fetch = createSessionMcpHttpEntry({ dispatch }, auth.resolve, diagnostic, tools);
  const server = createLoopbackServer(
    options.port,
    () => (closed ? undefined : { fetch }),
    diagnostic,
  );
  const relayServer = createRelayServer(
    options.relayPort,
    createRelayIngress({ key: relayKey, onStatus: (status) => hub.publish(status), diagnostic }),
    diagnostic,
  );
  let closed = false;
  const listen = (target: typeof server, port: number) =>
    new Promise<void>((resolve, reject) => {
      target.once("error", reject);
      target.listen(port, "127.0.0.1", () => {
        target.off("error", reject);
        resolve();
      });
    });
  const sweep = async () => {
    if (!(await enabled())) {
      if ((await rpc.dropAll()) > 0) diagnostic("subscriptions_dropped");
      return;
    }
    // Picks up subscriptions whose pane could not be read at start (Orca not running yet).
    if ((await rpc.resume()) > 0) diagnostic("subscriptions_resumed");
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    for (const s of [server, relayServer]) {
      s.closeAllConnections();
      if (s.listening) await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    auth.revoke();
    await rpc.close();
    // Subscriptions stay on disk for the next start; only the lock is released.
    await store.close();
    encryptionKey.fill(0);
    serviceKey.fill(0);
    relayKey.fill(0);
    diagnostic("stopped");
  };
  try {
    await listen(relayServer, options.relayPort);
    await listen(server, options.port);
    await sweep();
    timer = setInterval(() => void sweep().catch(() => undefined), options.sweepMs ?? 30000);
    diagnostic("running");
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
  return { close, port: options.port, relayPort: options.relayPort };
}

/** Writes a small owner-only file without following a symlink planted at the path. */
export async function writePlain(path: string, text: string) {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  ).catch(() => undefined);
  if (!handle) return;
  try {
    await handle.writeFile(text);
  } finally {
    await handle.close();
  }
}

/** Paths for the service state under the bridge home (the directory keeps its old name). */
export function bridgeServicePaths(home: string) {
  const root = join(home, ".orca-dots-bridge");
  return {
    directory: join(root, "notifications"),
    lastError: join(root, "notifications", "last-error"),
    settingsPath: join(root, "chatgpt-settings.json"),
    bridgeSettings: join(root, "settings.json"),
  };
}
