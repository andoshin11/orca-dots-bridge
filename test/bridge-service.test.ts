import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
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
function fakeOrca(
  options: {
    agents?: object[];
    psFails?: boolean;
    /** Extra worktrees and terminals (mutable: tests add workspaces later). */
    worktrees?: object[];
    terminals?: object[];
  } = {},
) {
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
      if (args[0] === "worktree" && options.psFails) throw new Error("synthetic ps failure");
      const worktrees = [
        ...(options.agents
          ? [
              {
                worktreeId: "wt_1",
                repo: "repo",
                branch: "main",
                displayName: "ws",
                status: "active",
                agents: options.agents,
              },
            ]
          : []),
        ...(options.worktrees ?? []),
      ];
      const terminals = options.terminals ?? [];
      const result =
        args[0] === "worktree"
          ? { worktrees, totalCount: worktrees.length, truncated: false }
          : args[1] === "list"
            ? { terminals, totalCount: terminals.length, truncated: false }
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
      // Never the real Orca CLI: notification summaries read `worktree ps` after delivery.
      bridge: options.bridge ?? fakeOrca().bridge,
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
  const relay = async (
    kind: string,
    pane: { worktreeId: string | null; paneKey: string } = target,
    startedAt = Date.now() - 10,
  ) => {
    const id = `msg_${randomUUID()}`;
    const seconds = String(Math.floor(Date.now() / 1000));
    const [tabId, leafId] = pane.paneKey.split(":");
    const body = JSON.stringify({
      type: "agent.status.changed",
      kind,
      worktreeId: pane.worktreeId,
      paneKey: pane.paneKey,
      tabId,
      leafId,
      state: kind,
      mainAgent: { state: kind, stateStartedAt: startedAt },
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
  for (const e of listed.result.events) {
    // One pane (handle + worktree ID), or one scope of many panes.
    expect(e.inputSchema.oneOf.map((o: any) => o.required)).toEqual([
      ["terminalHandle", "worktreeId"],
      ["scope"],
      ["scope", "repo"],
      ["scope", "worktreeId"],
    ]);
    for (const o of e.inputSchema.oneOf) expect(o.additionalProperties).toBe(false);
    expect(e.description).toContain("scope");
  }
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

it("adds the agent's last message and pending tool to recent notifications", async () => {
  const orca = fakeOrca({
    agents: [
      {
        paneKey: "tab_1:leaf_1",
        state: "blocked",
        agentType: "claude",
        lastAssistantMessage: "Build finished; cleaning up next.",
        toolName: "Bash",
        toolInput: "rm -rf build",
      },
    ],
  });
  const f = await fixture({ enabled: true, bridge: orca.bridge });
  await f.start();
  await f.subscribe(undefined, "orca.pane_input_required");
  await f.relay("blocked");
  await f.until(() => f.posts.some((p) => p.body.name === "orca.pane_input_required"));
  let notifications: any[] = [];
  for (let i = 0; i < 100; i++) {
    const reply = await f.mcp("tools/call", { name: "orca_recent_notifications", arguments: {} });
    notifications = reply.result.structuredContent.notifications;
    if (notifications[0]?.summary) {
      expect(reply.result.structuredContent.observation).toContain("untrusted");
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(notifications).toEqual([
    {
      event: "orca.pane_input_required",
      kind: "input_required",
      at: expect.any(String),
      terminalHandle: "term_1",
      worktreeId: "wt_1",
      summary: "Build finished; cleaning up next.",
      pending: { kind: "permission", toolName: "Bash", toolInput: "rm -rf build" },
    },
  ]);
});

it("delivers and lists a notification even when the summary cannot be read", async () => {
  const orca = fakeOrca({ psFails: true });
  const f = await fixture({ enabled: true, bridge: orca.bridge });
  await f.start();
  await f.subscribe(undefined, "orca.pane_turn_finished");
  await f.relay("done");
  await f.until(() => f.posts.some((p) => p.body.name === "orca.pane_turn_finished"));
  await f.until(() => orca.calls.some((a) => a[0] === "worktree"));
  const reply = await f.mcp("tools/call", { name: "orca_recent_notifications", arguments: {} });
  expect(reply.result.structuredContent).toEqual({
    notifications: [
      {
        event: "orca.pane_turn_finished",
        kind: "turn_finished",
        at: expect.any(String),
        terminalHandle: "term_1",
        worktreeId: "wt_1",
      },
    ],
  });
});

it("serves every tool of the one plugin and advertises the ChatGPT settings", async () => {
  const f = await fixture({ enabled: false });
  await f.start();
  const listed = await f.mcp("tools/list");
  const tools = Object.fromEntries(listed.result.tools.map((t: any) => [t.name, t]));
  expect(Object.keys(tools)).toEqual([
    "orca_status",
    "orca_find",
    "orca_brief",
    "orca_pending_input",
    "orca_send_instruction",
    "orca_answer",
    "orca_create_workspace",
    "orca_close_agent",
    "orca_remove_workspace",
    "orca_start_task",
    "orca_audit_log",
    "orca_set_alias",
    "orca_remove_alias",
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

it("refuses the workspace tools until each one's own setting is on", async () => {
  const orca = fakeOrca();
  const f = await fixture({ enabled: false, sendEnabled: true, bridge: orca.bridge });
  await f.start();
  const listed = await f.mcp("tools/list");
  const tools = Object.fromEntries(listed.result.tools.map((t: any) => [t.name, t]));
  expect(tools.orca_create_workspace.annotations).toEqual({
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  });
  for (const name of ["orca_close_agent", "orca_remove_workspace"])
    expect(tools[name].annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  const calls = [
    ["orca_create_workspace", { repo: "sample-repo", name: "task" }, "create_disabled"],
    ["orca_close_agent", { handle: "term_1", expectedWorktreeId: "wt_1" }, "close_disabled"],
    ["orca_remove_workspace", { worktreeId: "wt_1" }, "remove_disabled"],
    ["orca_start_task", { repo: "sample-repo", template: "issue", issue: 12 }, "create_disabled"],
  ] as const;
  for (const [name, args, code] of calls) {
    const refused = await f.mcp("tools/call", { name, arguments: args });
    expect(refused.result.isError).toBe(true);
    expect(JSON.parse(refused.result.content[0].text).error.code).toBe(code);
  }
  expect(orca.calls).toHaveLength(0);
  // On: the close call passes the gate and reaches Orca (show, then close).
  await writeFile(f.settingsPath, JSON.stringify({ closeEnabled: true }));
  const closed = await f.mcp("tools/call", { name: calls[1][0], arguments: calls[1][1] });
  expect(orca.calls.map((c) => c.slice(0, 2).join(" "))).toContain("terminal show");
  expect(JSON.parse(closed.result.content[0].text).error?.code).not.toBe("close_disabled");
});

it("records every write call, refused or not, and lets dot read the record back", async () => {
  const orca = fakeOrca();
  const f = await fixture({ enabled: false, bridge: orca.bridge });
  await f.start();
  const call = (name: string, args: unknown, meta?: Record<string, unknown>) =>
    f.mcp("tools/call", { name, arguments: args }, meta);
  await call("orca_send_instruction", {
    handle: "term_1",
    expectedWorktreeId: "wt_1",
    text: "secret-free instruction ".repeat(20),
  });
  await call("orca_start_task", { repo: "sample-repo", template: "pr_review", pr: 45 });
  await call(
    "orca_settings_update",
    { set: { notificationsEnabled: true } },
    {
      "openai/action_name": "x",
    },
  );
  // Read-only tools are never recorded.
  await call("orca_find", {});
  const read = await call("orca_audit_log", { limit: 10 });
  const { entries } = JSON.parse(read.result.content[0].text);
  expect(entries).toEqual([
    {
      time: expect.any(String),
      source: "chatgpt",
      tool: "orca_settings_update",
      outcome: "ok",
      target: { notificationsEnabled: true },
      summary: "notificationsEnabled=true",
    },
    {
      time: expect.any(String),
      source: "chatgpt",
      tool: "orca_start_task",
      outcome: "refused",
      errorCode: "create_disabled",
      target: { repo: "sample-repo", template: "pr_review", pr: 45 },
    },
    {
      time: expect.any(String),
      source: "chatgpt",
      tool: "orca_send_instruction",
      outcome: "refused",
      errorCode: "send_disabled",
      target: { handle: "term_1", worktreeId: "wt_1" },
      summary: expect.stringMatching(/^secret-free instruction .{150,}…$/),
    },
  ]);
  expect(Array.from(entries[2].summary as string)).toHaveLength(200);
  const only = await call("orca_audit_log", { tool: "orca_start_task" });
  expect(JSON.parse(only.result.content[0].text).entries).toHaveLength(1);
  const path = join(f.dir, "audit.log");
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(3);
});

it("turns settings on only from the ChatGPT settings page", async () => {
  const f = await fixture({ enabled: false });
  await f.start();
  const update = (set: Record<string, boolean>, meta?: Record<string, unknown>) =>
    f.mcp("tools/call", { name: "orca_settings_update", arguments: { set } }, meta);
  const settings = async () => JSON.parse(await readFile(f.settingsPath, "utf8"));

  for (const meta of [undefined, { "openai/session": "s", "openai/action_name": "x" }])
    for (const key of ["sendEnabled", "createEnabled", "closeEnabled", "removeEnabled"]) {
      const chat = await update({ [key]: true }, meta);
      expect(chat.result.isError).toBe(true);
      expect(JSON.parse(chat.result.content[0].text).error.code).toBe("settings_page_only");
      expect((await settings())[key]).not.toBe(true);
    }
  // Unknown settings are not accepted at all.
  const unknown = await update({ forceEnabled: true }, { "openai/action_name": "x" });
  expect(unknown.result.isError).toBe(true);
  const workspace = await update(
    { createEnabled: true, closeEnabled: true, removeEnabled: true },
    { "openai/action_name": "x" },
  );
  expect(workspace.result.structuredContent.values).toMatchObject({
    createEnabled: true,
    closeEnabled: true,
    removeEnabled: true,
    sendEnabled: false,
  });
  const offAgain = await update({
    createEnabled: false,
    closeEnabled: false,
    removeEnabled: false,
  });
  expect(offAgain.result.isError).toBeUndefined();

  const page = await update(
    { sendEnabled: true, notificationsEnabled: true },
    { "openai/action_name": "x" },
  );
  const expected = {
    sendEnabled: true,
    closeEnabled: false,
    createEnabled: false,
    removeEnabled: false,
    notificationsEnabled: true,
  };
  expect(page.result.structuredContent).toEqual({ values: expected });
  const read = await f.mcp("tools/call", { name: "orca_settings_read", arguments: {} });
  expect(read.result.structuredContent.values).toEqual(expected);
  // Turning something off is accepted from anywhere.
  const off = await update({ notificationsEnabled: false });
  expect(off.result.structuredContent.values.notificationsEnabled).toBe(false);
});

// ---- scope subscriptions ----

/** Three panes in two repos; a pane's terminal is named after it. */
function scopeOrca() {
  const worktree = (worktreeId: string, repo: string, displayName: string) => ({
    worktreeId,
    repo,
    branch: displayName,
    displayName,
    status: "active",
    agents: [] as object[],
  });
  const term = (handle: string, worktreeId: string, tabId: string) => ({
    handle,
    worktreeId,
    tabId,
    leafId: "leaf",
    connected: true,
  });
  const worktrees = [
    worktree("wt_1", "repo", "ws"),
    worktree("wt_2", "repo", "ws2"),
    worktree("wt_3", "other", "elsewhere"),
  ];
  worktrees[1]!.agents.push({
    paneKey: "tab_2:leaf",
    state: "waiting",
    toolName: "Bash",
    toolInput: "npm publish",
    lastAssistantMessage: "Ready to publish.",
  });
  const terminals = [
    term("term_1", "wt_1", "tab_1"),
    term("term_2", "wt_2", "tab_2"),
    term("term_3", "wt_3", "tab_3"),
  ];
  return { ...fakeOrca({ worktrees, terminals }), worktrees, terminals, worktree, term };
}
const pane = (worktreeId: string | null, tab: string) => ({ worktreeId, paneKey: `${tab}:leaf` });
const events = (posts: { body: any }[]) => posts.filter((p) => p.body.type !== "verification");

it("delivers every pane's events to one scope subscription and says which pane", async () => {
  const orca = scopeOrca();
  const f = await fixture({ enabled: true, bridge: orca.bridge });
  await f.start();
  const reply = await f.subscribe({ scope: "all" }, "orca.pane_input_required");
  expect(reply.result.id).toMatch(/^sub_/);
  await f.relay("waiting", pane("wt_2", "tab_2"));
  // The relay may omit the worktree: the pane key finds it.
  await f.relay("blocked", pane(null, "tab_3"));
  // Turn ends are another event name.
  await f.relay("done", pane("wt_2", "tab_2"));
  await f.until(() => events(f.posts).length === 2);
  await new Promise((r) => setTimeout(r, 100));
  expect(events(f.posts).map((p) => [p.body.name, p.body.data.kind, p.body.data.pane])).toEqual([
    [
      "orca.pane_input_required",
      "input_required",
      { worktreeId: "wt_2", terminalHandle: "term_2", repo: "repo", workspace: "ws2" },
    ],
    [
      "orca.pane_input_required",
      "input_required",
      { worktreeId: "wt_3", terminalHandle: "term_3", repo: "other", workspace: "elsewhere" },
    ],
  ]);
  // The recent memory knows the pane and reads the summary for it.
  let notifications: any[] = [];
  for (let i = 0; i < 100; i++) {
    const r = await f.mcp("tools/call", { name: "orca_recent_notifications", arguments: {} });
    notifications = r.result.structuredContent.notifications;
    if (notifications.some((n) => n.summary)) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(notifications).toEqual([
    {
      event: "orca.pane_input_required",
      kind: "input_required",
      at: expect.any(String),
      worktreeId: "wt_3",
      terminalHandle: "term_3",
      repo: "other",
      workspace: "elsewhere",
    },
    {
      event: "orca.pane_input_required",
      kind: "input_required",
      at: expect.any(String),
      worktreeId: "wt_2",
      terminalHandle: "term_2",
      repo: "repo",
      workspace: "ws2",
      summary: "Ready to publish.",
      pending: { kind: "permission", toolName: "Bash", toolInput: "npm publish" },
    },
  ]);
});

it("a repo scope covers workspaces created later and only that repo", async () => {
  const orca = scopeOrca();
  const f = await fixture({ enabled: true, bridge: orca.bridge });
  await f.start();
  // A misheard repo name is refused rather than becoming a silent subscription.
  expect((await f.subscribe({ scope: "repo", repo: "rpo" })).error).toBeDefined();
  expect((await f.subscribe({ scope: "repo", repo: "repo", extra: 1 })).error).toBeDefined();
  expect((await f.subscribe({ scope: "worktree", worktreeId: "wt_nope" })).error).toBeDefined();
  // Scope subscriptions exist for the single-kind events only.
  expect((await f.subscribe({ scope: "all" }, "orca.pane_activity")).error).toBeDefined();
  expect((await f.subscribe({ scope: "repo", repo: "repo" })).result.id).toMatch(/^sub_/);
  await f.relay("done", pane("wt_3", "tab_3"));
  await f.relay("done", pane("wt_1", "tab_1"));
  await f.until(() => events(f.posts).length === 1);
  expect(events(f.posts)[0]!.body.data.pane.worktreeId).toBe("wt_1");
  // A workspace created after subscribing, past the short cache.
  orca.worktrees.push(orca.worktree("wt_new", "repo", "fresh"));
  orca.terminals.push(orca.term("term_new", "wt_new", "tab_new"));
  await new Promise((r) => setTimeout(r, 600));
  await f.relay("done", pane("wt_new", "tab_new"));
  await f.until(() => events(f.posts).length === 2);
  expect(events(f.posts)[1]!.body.data.pane).toEqual({
    worktreeId: "wt_new",
    terminalHandle: "term_new",
    repo: "repo",
    workspace: "fresh",
  });
});

it("delivers a pane's event once when a pane and scope subscriptions overlap", async () => {
  const orca = scopeOrca();
  const f = await fixture({ enabled: true, bridge: orca.bridge });
  await f.start();
  await f.subscribe(); // pane term_1 (wt_1, tab_1:leaf_1 via describe)
  await f.subscribe({ scope: "all" });
  await f.subscribe({ scope: "repo", repo: "repo" });
  await f.subscribe({ scope: "worktree", worktreeId: "wt_2" });
  await f.relay("done", target); // the pane subscription's pane
  await f.relay("done", pane("wt_2", "tab_2")); // worktree scope is the narrowest
  await f.relay("done", pane("wt_3", "tab_3")); // only "all" covers it
  await f.until(() => events(f.posts).length >= 3);
  await new Promise((r) => setTimeout(r, 200));
  const delivered = events(f.posts).map((p) => String(p.body.data.pane?.worktreeId ?? "pane"));
  expect(delivered.sort((a, b) => a.localeCompare(b))).toEqual(["pane", "wt_2", "wt_3"]);
});

it("keeps scope subscriptions across a restart, unsubscribes them and drops them when off", async () => {
  const orca = scopeOrca();
  const f = await fixture({ enabled: true, bridge: orca.bridge });
  const first = await f.start();
  await f.subscribe({ scope: "worktree", worktreeId: "wt_2" });
  await first.close();
  running.splice(running.indexOf(first), 1);
  await f.start();
  await f.relay("done", pane("wt_2", "tab_2"));
  await f.until(() => events(f.posts).length === 1);

  const unsubscribed = await f.mcp("events/unsubscribe", {
    name: "orca.pane_turn_finished",
    arguments: { scope: "worktree", worktreeId: "wt_2" },
    delivery: { mode: "webhook", url: callback },
  });
  expect(unsubscribed.error).toBeUndefined();
  await f.relay("done", pane("wt_2", "tab_2"), Date.now() - 5);
  await new Promise((r) => setTimeout(r, 200));
  expect(events(f.posts)).toHaveLength(1);

  await f.subscribe({ scope: "all" });
  await writeFile(f.settingsPath, JSON.stringify({ notificationsEnabled: false }));
  await new Promise((r) => setTimeout(r, 200));
  await f.relay("done", pane("wt_3", "tab_3"));
  await new Promise((r) => setTimeout(r, 200));
  expect(events(f.posts)).toHaveLength(1);
});
