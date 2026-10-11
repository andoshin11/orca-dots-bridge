import { mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { OrcaAdapter } from "../src/adapter.js";
import { AliasStore, maxAliases } from "../src/aliases.js";
import { Bridge } from "../src/service.js";

const worktree = {
  worktreeId: "repo1::/Users/me/orca/workspaces/orca-dots-bridge/debug-birdge",
  repo: "orca-dots-bridge",
  displayName: "debug-birdge",
  branch: "debug",
  status: "idle",
  agents: [],
};
async function fixture(options: { truncated?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "aliases-"));
  const path = join(dir, "nested", "aliases.json");
  const calls: string[][] = [];
  const adapter = new OrcaAdapter(async (args) => {
    calls.push(args);
    const result =
      args[0] === "worktree"
        ? { worktrees: [worktree], totalCount: 1, truncated: options.truncated ?? false }
        : { terminals: [], totalCount: 0, truncated: false };
    return JSON.stringify({ ok: true, result });
  });
  const store = new AliasStore(path);
  return { dir, path, store, calls, bridge: new Bridge(adapter, () => 1000, undefined, store) };
}

test("saves an alias for an existing workspace in an owner-only file", async () => {
  const f = await fixture();
  const saved = await f.bridge.setAlias({
    name: " デバッグ  バードジ ",
    worktreeId: worktree.worktreeId,
  });
  expect(saved).toMatchObject({
    alias: "デバッグ バードジ",
    worktreeId: worktree.worktreeId,
    repo: "orca-dots-bridge",
    workspace: "debug-birdge",
    replacedWorktreeId: null,
    aliasCount: 1,
  });
  expect((await stat(f.path)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({
    version: 1,
    aliases: [{ name: "デバッグ バードジ", worktreeId: worktree.worktreeId, updatedAt: 1000 }],
  });
  // Only Orca reads happened; nothing was sent to Orca.
  expect(f.calls.map((c) => c.slice(0, 2).join(" ")).sort()).toEqual([
    "terminal list",
    "worktree ps",
  ]);
  // Same name in another form re-points instead of adding.
  await f.store.set("でばっぐばーどじ", "other", 2000);
  expect(await f.store.list()).toEqual([
    { name: "でばっぐばーどじ", worktreeId: "other", updatedAt: 2000 },
  ]);
  expect(await f.bridge.removeAlias({ name: "デバッグバードジ" })).toEqual({
    alias: "デバッグバードジ",
    removed: true,
    worktreeId: "other",
    aliasCount: 0,
  });
  expect((await f.bridge.removeAlias({ name: "デバッグバードジ" })).removed).toBe(false);
});

test("refuses unknown workspaces and invalid names", async () => {
  const f = await fixture();
  await expect(f.bridge.setAlias({ name: "x", worktreeId: "nope" })).rejects.toMatchObject({
    code: "not_found",
  });
  const partial = await fixture({ truncated: true });
  await expect(partial.bridge.setAlias({ name: "x", worktreeId: "nope" })).rejects.toMatchObject({
    code: "inventory_incomplete",
  });
  for (const input of [
    { name: "", worktreeId: worktree.worktreeId },
    { name: "x".repeat(41), worktreeId: worktree.worktreeId },
    { name: " - _ ", worktreeId: worktree.worktreeId },
    { name: "a\u0007b", worktreeId: worktree.worktreeId },
    { name: "ok", worktreeId: "-flag" },
    { name: "ok", worktreeId: worktree.worktreeId, extra: 1 },
  ])
    await expect(f.bridge.setAlias(input)).rejects.toMatchObject({ code: "invalid_input" });
  await expect(new Bridge().setAlias({ name: "ok", worktreeId: "x" })).rejects.toMatchObject({
    code: "aliases_unavailable",
  });
});

test("keeps at most 50 aliases", async () => {
  const f = await fixture();
  for (let i = 0; i < maxAliases; i++) await f.store.set(`alias ${i}`, `wt_${i}`, i);
  await expect(
    f.bridge.setAlias({ name: "one more", worktreeId: worktree.worktreeId }),
  ).rejects.toMatchObject({
    code: "alias_limit",
  });
  // Re-pointing an existing name is still allowed at the limit.
  await f.bridge.setAlias({ name: "ALIAS 3", worktreeId: worktree.worktreeId });
  expect((await f.store.list()).length).toBe(maxAliases);
});

test("reads a missing, malformed or symlinked file as no aliases", async () => {
  const f = await fixture();
  expect(await f.store.list()).toEqual([]);
  await f.store.set("ok", "wt", 1);
  await writeFile(f.path, "{not json");
  expect(await f.store.list()).toEqual([]);
  await writeFile(
    f.path,
    JSON.stringify({
      version: 1,
      aliases: [
        { name: "good", worktreeId: "wt", updatedAt: 1 },
        { name: "", worktreeId: "wt", updatedAt: 1 },
        { name: "GOOD", worktreeId: "dup", updatedAt: 2 },
        { name: "extra", worktreeId: "wt", updatedAt: 1, more: true },
      ],
    }),
  );
  expect((await f.store.list()).map((a) => a.name)).toEqual(["good"]);
  const real = join(f.dir, "real.json");
  await writeFile(
    real,
    JSON.stringify({ version: 1, aliases: [{ name: "x", worktreeId: "w", updatedAt: 1 }] }),
  );
  const linked = join(f.dir, "linked.json");
  await symlink(real, linked);
  expect(await new AliasStore(linked).list()).toEqual([]);
});
