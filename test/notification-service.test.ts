import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { serviceCatalog, startNotificationService } from "../src/events/notification-service.js";
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

async function fixture(options: { enabled: boolean; describe?: () => Promise<PaneTarget> }) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "notify-service-")));
  const settingsPath = join(dir, "chatgpt-settings.json");
  await writeFile(settingsPath, JSON.stringify({ notificationsEnabled: options.enabled }));
  const posts: { url: string; body: any }[] = [];
  const ports = { port: await freePort(), relayPort: await freePort() };
  const start = () =>
    startNotificationService({
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
    }).then((s) => {
      running.push(s);
      return s;
    });
  const mcp = async (method: string, params: Record<string, unknown> = {}) => {
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
  expect(listed.result.tools.map((t: any) => t.name)).toEqual(["orca_recent_notifications"]);
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
