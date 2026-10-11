import { expect, it, vi } from "vite-plus/test";
import { EventEngine, subscribeSchema } from "../src/events/engine.js";
import { digest } from "../src/events/model.js";
import { scopeTargetSchema } from "../src/events/pane-contract.js";
import { createPaneResolver, type PaneInventory } from "../src/events/pane-resolver.js";
import { scopeCovers } from "../src/events/pane-rpc.js";

const inventory: PaneInventory = {
  complete: true,
  worktrees: [
    { worktreeId: "wt_1", repo: "repo", workspace: "ws" },
    { worktreeId: "wt_2", repo: "other", workspace: "ws2" },
  ],
  terminals: [
    { handle: "term_1", worktreeId: "wt_1", paneKey: "a:1" },
    { handle: "term_x", worktreeId: "wt_2", paneKey: "dup:1" },
    { handle: "term_y", worktreeId: "wt_2", paneKey: "dup:1" },
  ],
};

it("accepts only strict scope targets, and only for the single-kind events", () => {
  for (const ok of [
    { scope: "all" },
    { scope: "repo", repo: "orca-dots-bridge" },
    { scope: "worktree", worktreeId: "repo::/path" },
  ])
    expect(scopeTargetSchema.parse(ok)).toEqual(ok);
  for (const bad of [
    { scope: "all", repo: "x" },
    { scope: "repo" },
    { scope: "repo", repo: "" },
    { scope: "repo", repo: " padded" },
    { scope: "repo", repo: "x".repeat(201) },
    { scope: "worktree", worktreeId: "a\nb" },
    { scope: "everything" },
  ])
    expect(scopeTargetSchema.safeParse(bad).success).toBe(false);
  const delivery = { mode: "webhook", url: "https://x.example.com/", secret: "s" };
  const ok = (name: string, args: unknown) =>
    subscribeSchema.safeParse({ name, arguments: args, delivery }).success;
  expect(ok("orca.pane_turn_finished", { scope: "all" })).toBe(true);
  expect(ok("orca.pane_input_required", { scope: "repo", repo: "r" })).toBe(true);
  expect(ok("orca.pane_activity", { scope: "all" })).toBe(false);
  expect(ok("orca.turn_finished", { scope: "all" })).toBe(false);
});

it("decides scope membership from the resolved pane", () => {
  const pane = {
    paneKey: "a:1",
    worktreeId: "wt_1",
    repo: "repo",
    workspace: "ws",
    terminalHandle: null,
  };
  expect(scopeCovers({ scope: "all" }, pane)).toBe(true);
  expect(scopeCovers({ scope: "repo", repo: "repo" }, pane)).toBe(true);
  expect(scopeCovers({ scope: "repo", repo: "Repo" }, pane)).toBe(false);
  expect(scopeCovers({ scope: "worktree", worktreeId: "wt_1" }, pane)).toBe(true);
  expect(scopeCovers({ scope: "worktree", worktreeId: "wt_2" }, pane)).toBe(false);
  expect(scopeCovers({ scope: "repo", repo: "repo" }, { ...pane, repo: null })).toBe(false);
});

it("resolves panes through a short-lived, shared inventory read", async () => {
  let time = 0;
  const load = vi.fn(async () => inventory);
  const resolver = createPaneResolver(load, () => time);
  const [a, b] = await Promise.all([
    resolver.resolve({ worktreeId: null, paneKey: "a:1" }),
    resolver.resolve({ worktreeId: "wt_1", paneKey: "a:1" }),
  ]);
  expect(a).toEqual({
    paneKey: "a:1",
    worktreeId: "wt_1",
    repo: "repo",
    workspace: "ws",
    terminalHandle: "term_1",
  });
  expect(b).toEqual(a);
  expect(load).toHaveBeenCalledTimes(1);
  time = 9000;
  await resolver.resolve({ worktreeId: "wt_1", paneKey: "a:1" });
  expect(load).toHaveBeenCalledTimes(1);
  time = 10000;
  await resolver.resolve({ worktreeId: "wt_1", paneKey: "a:1" });
  expect(load).toHaveBeenCalledTimes(2);
  // Two terminals claim the pane: no handle is guessed, the worktree still resolves.
  time = 10600;
  expect(await resolver.resolve({ worktreeId: "wt_2", paneKey: "dup:1" })).toMatchObject({
    worktreeId: "wt_2",
    repo: "other",
    terminalHandle: null,
  });
  // A miss re-reads at most once, then gives up.
  time = 11200;
  expect(await resolver.resolve({ worktreeId: null, paneKey: "gone:1" })).toBeNull();
  expect(load).toHaveBeenCalledTimes(4);
});

it("does not cache a failed inventory read", async () => {
  let fail = true;
  const resolver = createPaneResolver(async () => {
    if (fail) throw new Error("orca down");
    return inventory;
  });
  await expect(resolver.resolve({ worktreeId: "wt_1", paneKey: "a:1" })).rejects.toThrow(
    "orca down",
  );
  fail = false;
  expect(await resolver.resolve({ worktreeId: "wt_1", paneKey: "a:1" })).toMatchObject({
    repo: "repo",
  });
});

it("forgets the oldest delivered event ids instead of refusing new events", async () => {
  let blob: string | null = null;
  const target = { scope: "all" } as const;
  const engine = await EventEngine.open({
    key: Buffer.alloc(32, 4),
    store: { load: async () => blob, save: async (v) => void (blob = v) },
    allowedCallbackHosts: ["receiver.example.com"],
    authorize: async () => true,
    post: async (_url, _headers, body) => ({
      status: 200,
      body: JSON.stringify({ challenge: JSON.parse(body).challenge }),
    }),
  });
  const { id } = await engine.subscribe("owner", {
    name: "orca.pane_turn_finished",
    arguments: target,
    delivery: {
      mode: "webhook",
      url: "https://receiver.example.com/x",
      secret: `whsec_${Buffer.alloc(32, 7).toString("base64")}`,
    },
  });
  const event = (n: number) => ({
    eventId: `e_${n}`,
    name: "orca.pane_turn_finished",
    timestamp: new Date(Date.now() + 1000).toISOString(),
    cursor: null,
    data: {
      subscriptionId: digest(id),
      freshness: "receipt_only",
      assurance: "pane_only",
      kind: "turn_finished",
      outcome: "unconfirmed",
      pane: { worktreeId: "wt_1", repo: "repo" },
    },
  });
  for (let n = 0; n < 2100; n++) {
    expect(await engine.ingestSession("owner", id, target, event(n))).toBe(true);
    if (n % 10 === 9) await engine.deliver();
  }
  await engine.deliver();
  // The newest ids are still remembered as duplicates.
  expect(await engine.ingestSession("owner", id, target, event(2099))).toBe(false);
  // A pane field that is not a string is refused.
  const bad = event(5000);
  (bad.data.pane as Record<string, unknown>).repo = 1;
  expect(await engine.ingestSession("owner", id, target, bad)).toBe(false);
}, 30000);
