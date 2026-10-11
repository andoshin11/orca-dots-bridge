import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { OrcaAdapter } from "../src/adapter.js";
import { serviceCatalog, startBridgeService } from "../src/events/bridge-service.js";
import { Bridge } from "../src/service.js";
import type { KeyAccount } from "../src/events/keychain.js";
import type { PaneTarget } from "../src/events/pane-contract.js";

const serviceKey = Buffer.alloc(32, 1);
const relayKey = Buffer.alloc(32, 2);
const keys = {
  read: async (account: KeyAccount) =>
    Buffer.from(
      {
        "outbox-v1": Buffer.alloc(32, 3),
        "service-v1": serviceKey,
        "relay-v1": relayKey,
      }[account],
    ),
};
const target: PaneTarget = {
  executionHostId: "local",
  worktreeId: "wt_1",
  terminalHandle: "term_1",
  paneKey: "tab_1:leaf_1",
  incarnationId: "inc_1",
};
const callback = "https://connectors.api.openai.com/webhook/mcp-events/abc";
const secret = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;
/** A port the OS just handed out; the service needs a fixed number for its Host check. */
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
const running: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
});

/** A stand-in Orca CLI: one writable agent terminal, and receipts for sends. */
function fakeOrca() {
  const calls: string[][] = [];
  const terminal = {
    handle: "term_1",
    worktreeId: "wt_1",
    tabId: "tab_1",
    leafId: "leaf_1",
    connected: true,
    writable: true,
    agentIdentity: "codex",
  };
  const bridge = new Bridge(
    new OrcaAdapter(async (args) => {
      calls.push(args);
      const result =
        args[0] === "worktree"
          ? { worktrees: [], totalCount: 0, truncated: false }
          : args[1] === "list"
            ? { terminals: [], totalCount: 0, truncated: false }
            : args[1] === "show"
              ? { terminal }
              : {
                  send: {
                    handle: "term_1",
                    accepted: true,
                    bytesWritten: 2,
                    prompt: {
                      requestId: "synthetic-request",
                      stages: ["input_accepted"],
                      provider: "codex",
                      observation: "supported",
                    },
                  },
                };
      return JSON.stringify({ ok: true, result });
    }),
  );
  return { bridge, calls };
}

async function fixture(options: {
  enabled: boolean;
  sendEnabled?: boolean;
  describe?: () => Promise<PaneTarget>;
  bridge?: Bridge;
}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "notify-service-")));
  const settingsPath = join(dir, "chatgpt-settings.json");
  await writeFile(
    settingsPath,
    JSON.stringify({
      notificationsEnabled: options.enabled,
      sendEnabled: options.sendEnabled === true,
    }),
  );
  const posts: { url: string; body: any }[] = [];
  const ports = { port: await freePort(), relayPort: await freePort() };
  const start = () =>
    startBridgeService({
      directory: join(dir, "notifications"),
      settingsPath,
      ...ports,
      callbackHosts: ["connectors.api.openai.com"],
      keys,
      describe: options.describe ?? (async () => target),
      // Echo the verification challenge; accept events.
      post: async (url, _headers, body) => {
        const parsed = JSON.parse(body);
        posts.push({ url, body: parsed });
        return {
          status: 200,
          body:
            parsed.type === "verification" ? JSON.stringify({ challenge: parsed.challenge }) : "",
        };
      },
      sweepMs: 50,
      ...(options.bridge ? { bridge: options.bridge } : {}),
    }).then((s) => {
      running.push(s);
      return s;
    });
  const mcp = async (
    method: string,
    params: Record<string, unknown> = {},
    meta: Record<string, unknown> = {},
  ) => {
    const response = await fetch(`http://127.0.0.1:${ports.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": method,
        ...(method === "tools/call" ? { "Mcp-Name": String(params.name) } : {}),
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${serviceKey.toString("base64url")}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            ...meta,
          },
        },
      }),
    });
    return (await response.json()) as any;
  };
  const relay = async (kind: string) => {
    const id = `msg_${randomUUID()}`;
    const seconds = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      type: "agent.status.changed",
      kind,
      worktreeId: target.worktreeId,
      paneKey: target.paneKey,
      tabId: "tab_1",
      leafId: "leaf_1",
      state: kind,
      mainAgent: { state: kind, stateStartedAt: Date.now() - 10 },
      receivedAt: Date.now(),
    });
    const signature = createHmac("sha256", relayKey)
      .update(`${id}.${seconds}.${body}`)
      .digest("base64");
    return fetch(`http://127.0.0.1:${ports.relayPort}/relay`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": seconds,
        "webhook-signature": `v1,${signature}`,
      },
      body,
    });
  };
  const subscribe = (
    args: unknown = { terminalHandle: "term_1", worktreeId: "wt_1" },
    name = "orca.pane_turn_finished",
  ) =>
    mcp("events/subscribe", {
      name,
      arguments: args,
      delivery: { mode: "webhook", url: callback, secret },
      ttlMs: null,
    });
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(check()).toBe(true);
  };
  return { dir, settingsPath, posts, start, mcp, relay, subscribe, until };
}

it("lists one event per kind with the handle + worktree ID arguments dot can supply", async () => {
  const f = await fixture({ enabled: true });
  await f.start();
  const listed = await f.mcp("events/list");
  expect(listed.result.events).toEqual(serviceCatalog);
  expect(listed.result.events.map((e: any) => e.name)).toEqual([
    "orca.pane_turn_finished",
    "orca.pane_input_required",
  ]);
  for (const e of listed.result.events)
    expect(e.inputSchema.required).toEqual(["terminalHandle", "worktreeId"]);
});

it("names each delivery after its kind and sends a subscription only its own kind", async () => {
  const f = await fixture({ enabled: true });
  await f.start();
  await f.subscribe(undefined, "orca.pane_turn_finished");
  await f.subscribe(undefined, "orca.pane_input_required");
  await f.relay("waiting");
  await f.until(() => f.posts.some((p) => p.body.name === "orca.pane_input_required"));
  await f.relay("done");
  await f.until(() => f.posts.some((p) => p.body.name === "orca.pane_turn_finished"));
  await new Promise((r) => setTimeout(r, 100));
  const events = f.posts.filter((p) => p.body.type !== "verification");
  expect(events.map((p) => [p.body.name, p.body.data.kind])).toEqual([
    ["orca.pane_input_required", "input_required"],
    ["orca.pane_turn_finished", "turn_finished"],
  ]);
});

it("keeps delivering to an earlier orca.pane_activity subscription", async () => {
  const f = await fixture({ enabled: true });
  await f.start();
  await f.subscribe(undefined, "orca.pane_activity");
  await f.relay("waiting");
  await f.until(() =>
    f.posts.some(
      (p) => p.body.name === "orca.pane_activity" && p.body.data.kind === "input_required",
    ),
  );
});

it("refuses subscriptions while 通知を受け取る is off", async () => {
  const f = await fixture({ enabled: false });
  await f.start();
  const reply = await f.subscribe();
  expect(reply.error).toBeDefined();
  expect(f.posts).toHaveLength(0);
});

it("verifies the callback, delivers pane events, and keeps the subscription across a restart", async () => {
  const f = await fixture({ enabled: true });
  const first = await f.start();
  const reply = await f.subscribe();
  expect(reply.result.id).toMatch(/^sub_/);
  expect(f.posts[0]?.body.type).toBe("verification");

  expect((await f.relay("done")).status).toBe(204);
  await f.until(() => f.posts.some((p) => p.body.name === "orca.pane_turn_finished"));
  expect(f.posts.at(-1)?.body.data).toMatchObject({
    kind: "turn_finished",
    assurance: "pane_only",
  });

  await first.close();
  running.splice(running.indexOf(first), 1);
  await f.start();
  const before = f.posts.length;
  expect((await f.relay("done")).status).toBe(204);
  await f.until(() => f.posts.slice(before).some((p) => p.body.name === "orca.pane_turn_finished"));
  const counts = JSON.parse(await readFile(join(f.dir, "notifications", "counts.json"), "utf8"));
  expect(counts.counts.subscriptions_resumed).toBe(1);
});

it("keeps subscriptions while Orca is unreachable at start and resumes them later", async () => {
  let reachable = true;
  const f = await fixture({
    enabled: true,
    describe: async () => {
      if (!reachable) throw new Error("orca not running");
      return target;
    },
  });
  const first = await f.start();
  await f.subscribe();
  await first.close();
  running.splice(running.indexOf(first), 1);
  reachable = false;
  await f.start();
  await new Promise((r) => setTimeout(r, 120));
  reachable = true;
  const counts = () =>
    readFile(join(f.dir, "notifications", "counts.json"), "utf8").then((t) => JSON.parse(t).counts);
  for (let i = 0; i < 50 && (await counts()).subscriptions_resumed === 0; i++)
    await new Promise((r) => setTimeout(r, 20));
  expect((await counts()).subscriptions_resumed).toBe(1);
  const before = f.posts.length;
  await f.relay("done");
  await f.until(() => f.posts.slice(before).some((p) => p.body.name === "orca.pane_turn_finished"));
});

it("drops a persisted subscription whose pane now holds something else", async () => {
  let current = target;
  const f = await fixture({ enabled: true, describe: async () => current });
  const first = await f.start();
  await f.subscribe();
  await first.close();
  running.splice(running.indexOf(first), 1);
  current = { ...target, incarnationId: "inc_2" };
  await f.start();
  const before = f.posts.length;
  await f.relay("done");
  await new Promise((r) => setTimeout(r, 200));
  expect(f.posts.length).toBe(before);
});

it("drops every subscription when the setting is turned off", async () => {
  const f = await fixture({ enabled: true });
  await f.start();
  await f.subscribe();
  await writeFile(f.settingsPath, JSON.stringify({ notificationsEnabled: false }));
  const counts = () =>
    readFile(join(f.dir, "notifications", "counts.json"), "utf8").then((t) => JSON.parse(t).counts);
  for (let i = 0; i < 50 && (await counts()).subscriptions_dropped === 0; i++)
    await new Promise((r) => setTimeout(r, 20));
  expect((await counts()).subscriptions_dropped).toBeGreaterThan(0);
  const before = f.posts.length;
  await f.relay("done");
  await new Promise((r) => setTimeout(r, 200));
  expect(f.posts.length).toBe(before);
});

it("rejects a callback outside the allowed hosts and records only its host name", async () => {
  const f = await fixture({ enabled: true });
  await f.start();
  const reply = await f.mcp("events/subscribe", {
    name: "orca.pane_turn_finished",
    arguments: { terminalHandle: "term_1", worktreeId: "wt_1" },
    delivery: {
      mode: "webhook",
      url: "https://hooks.example.com/secret-path?token=x",
      secret,
    },
  });
  expect(reply.error).toBeDefined();
  expect(await readFile(join(f.dir, "notifications", "rejected-callback-host"), "utf8")).toBe(
    "hooks.example.com\n",
  );
});

it("unsubscribes with the short arguments even after the pane is gone", async () => {
  let alive = true;
  const f = await fixture({
    enabled: true,
    describe: async () => {
      if (!alive) throw new Error("pane closed");
      return target;
    },
  });
  await f.start();
  await f.subscribe();
  alive = false;
  const reply = await f.mcp("events/unsubscribe", {
    name: "orca.pane_turn_finished",
    arguments: { terminalHandle: "term_1", worktreeId: "wt_1" },
    delivery: { mode: "webhook", url: callback },
  });
  expect(reply.error).toBeUndefined();
  alive = true;
  const before = f.posts.length;
  await f.relay("done");
  await new Promise((r) => setTimeout(r, 200));
  expect(f.posts.length).toBe(before);
});

it("rejects a handle whose pane now belongs to another worktree", async () => {
  const f = await fixture({ enabled: true });
  await f.start();
  const reply = await f.subscribe({
    terminalHandle: "term_1",
    worktreeId: "wt_other",
  });
  expect(reply.error).toBeDefined();
  expect(f.posts).toHaveLength(0);
});

it("lets dot read what it was notified about with orca_recent_notifications", async () => {
  const f = await fixture({ enabled: true });
  await f.start();
  const listed = await f.mcp("tools/list");
  expect(listed.result.tools.map((t: any) => t.name)).toContain("orca_recent_notifications");
  const empty = await f.mcp("tools/call", { name: "orca_recent_notifications", arguments: {} });
  expect(empty.result.structuredContent).toEqual({ notifications: [] });

  await f.subscribe(undefined, "orca.pane_turn_finished");
  await f.relay("done");
  await f.until(() => f.posts.some((p) => p.body.name === "orca.pane_turn_finished"));
  const reply = await f.mcp("tools/call", { name: "orca_recent_notifications", arguments: {} });
  expect(reply.result.structuredContent.notifications).toEqual([
    {
      event: "orca.pane_turn_finished",
      kind: "turn_finished",
      at: expect.any(String),
      terminalHandle: "term_1",
      worktreeId: "wt_1",
    },
  ]);

  await writeFile(f.settingsPath, JSON.stringify({ notificationsEnabled: false }));
  const off = await f.mcp("tools/call", { name: "orca_recent_notifications", arguments: {} });
  expect(off.result.structuredContent).toEqual({ notifications: [] });
});

it("serves every tool of the one plugin and advertises the ChatGPT settings", async () => {
  const f = await fixture({ enabled: false });
  await f.start();
  const listed = await f.mcp("tools/list");
  const tools = Object.fromEntries(listed.result.tools.map((t: any) => [t.name, t]));
  expect(Object.keys(tools)).toEqual([
    "orca_status",
    "orca_find",
    "orca_send_instruction",
    "orca_settings_read",
    "orca_settings_update",
    "orca_recent_notifications",
  ]);
  // Exact repo + name or the exact worktree id alone; checked by the handler.
  expect(tools.orca_status.inputSchema.required).toBeUndefined();
  expect(tools.orca_status.description).toContain("orca_find");
  expect(tools.orca_find.annotations).toEqual({
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  expect(tools.orca_find.inputSchema.additionalProperties).toBe(false);
  expect(Object.keys(tools.orca_find.inputSchema.properties)).toEqual([
    "query",
    "state",
    "includeIdle",
    "limit",
  ]);
  // status-send shape: the expected worktree is required.
  expect(tools.orca_send_instruction.inputSchema.required).toEqual([
    "expectedWorktreeId",
    "handle",
    "text",
  ]);
  expect(tools.orca_send_instruction.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: true,
  });
  expect(tools.orca_settings_read.outputSchema.type).toBe("object");
  const discovered = await f.mcp("server/discover");
  const capability = { readTool: "orca_settings_read", updateTool: "orca_settings_update" };
  expect(discovered.result.capabilities.extensions["openai/settings"]).toEqual(capability);
  expect(discovered.result.capabilities.experimental["openai/settings"]).toEqual(capability);
  expect(discovered.result.capabilities.events).toBeDefined();
  const unknown = await f.mcp("tools/call", { name: "orca_nope", arguments: {} });
  expect(unknown.error).toBeDefined();
});

it("answers orca_status through the Orca CLI and returns handler failures as tool errors", async () => {
  const orca = fakeOrca();
  const f = await fixture({ enabled: false, bridge: orca.bridge });
  await f.start();
  const reply = await f.mcp("tools/call", {
    name: "orca_status",
    arguments: { repo: "sample-repo", name: "review" },
  });
  expect(reply.error).toBeUndefined();
  expect(orca.calls.some((c) => c[0] === "worktree")).toBe(true);
  const invalid = await f.mcp("tools/call", { name: "orca_status", arguments: { repo: "" } });
  expect(invalid.result.isError).toBe(true);
  expect(JSON.parse(invalid.result.content[0].text).error.code).toBe("invalid_input");
});

it("answers orca_find without exact names and points subscriptions at it", async () => {
  const orca = fakeOrca();
  const f = await fixture({ enabled: false, bridge: orca.bridge });
  await f.start();
  const reply = await f.mcp("tools/call", {
    name: "orca_find",
    arguments: { query: "debug birdge", state: "attention" },
  });
  expect(reply.result.isError).toBeUndefined();
  expect(JSON.parse(reply.result.content[0].text)).toMatchObject({
    matched: 0,
    truncated: false,
    candidates: [],
    queryTokens: ["debug", "birdge"],
  });
  const invalid = await f.mcp("tools/call", { name: "orca_find", arguments: { limit: 21 } });
  expect(JSON.parse(invalid.result.content[0].text).error.code).toBe("invalid_input");
  for (const event of serviceCatalog) expect(event.description).toContain("orca_find");
});

it("refuses orca_send_instruction until 指示の送信を許可 is on", async () => {
  const orca = fakeOrca();
  const f = await fixture({ enabled: false, bridge: orca.bridge });
  await f.start();
  const send = {
    name: "orca_send_instruction",
    arguments: { handle: "term_1", text: "hi", expectedWorktreeId: "wt_1" },
  };
  const refused = await f.mcp("tools/call", send);
  expect(refused.result.isError).toBe(true);
  expect(JSON.parse(refused.result.content[0].text).error.code).toBe("send_disabled");
  expect(orca.calls).toHaveLength(0);
  // Without expectedWorktreeId the call is invalid even before the setting is read.
  const loose = await f.mcp("tools/call", {
    name: "orca_send_instruction",
    arguments: { handle: "term_1", text: "hi" },
  });
  expect(JSON.parse(loose.result.content[0].text).error.code).toBe("invalid_input");

  await writeFile(f.settingsPath, JSON.stringify({ sendEnabled: true }));
  const sent = await f.mcp("tools/call", send);
  expect(sent.result.isError).toBeUndefined();
  expect(orca.calls.some((c) => c[1] === "send")).toBe(true);
});

it("turns settings on only from the ChatGPT settings page", async () => {
  const f = await fixture({ enabled: false });
  await f.start();
  const update = (set: Record<string, boolean>, meta?: Record<string, unknown>) =>
    f.mcp("tools/call", { name: "orca_settings_update", arguments: { set } }, meta);
  const settings = async () => JSON.parse(await readFile(f.settingsPath, "utf8"));

  for (const meta of [undefined, { "openai/session": "s", "openai/action_name": "x" }]) {
    const chat = await update({ sendEnabled: true }, meta);
    expect(chat.result.isError).toBe(true);
    expect(JSON.parse(chat.result.content[0].text).error.code).toBe("settings_page_only");
  }
  expect((await settings()).sendEnabled).toBe(false);

  const page = await update(
    { sendEnabled: true, notificationsEnabled: true },
    { "openai/action_name": "x" },
  );
  expect(page.result.structuredContent).toEqual({
    values: { sendEnabled: true, notificationsEnabled: true },
  });
  const read = await f.mcp("tools/call", { name: "orca_settings_read", arguments: {} });
  expect(read.result.structuredContent.values).toEqual({
    sendEnabled: true,
    notificationsEnabled: true,
  });
  // Turning something off is accepted from anywhere.
  const off = await update({ notificationsEnabled: false });
  expect(off.result.structuredContent.values.notificationsEnabled).toBe(false);
});
