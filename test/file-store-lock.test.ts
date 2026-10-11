import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { openAtomicStore } from "../src/events/file-store.js";

const dir = async () => realpath(await mkdtemp(join(tmpdir(), "store-lock-")));
const boot = () => Math.round(Date.now() / 1000 - uptime());
/** Boot time is derived from uptime, so two readings can differ by a second at a rounding edge. */
async function expectOwnLock(path: string) {
  const [pid, written] = (await readFile(path, "utf8")).trim().split(" ").map(Number);
  expect(pid).toBe(process.pid);
  expect(Math.abs(written! - boot())).toBeLessThanOrEqual(2);
}

it("writes the owner pid and boot time into the lock and removes it on close", async () => {
  const d = await dir();
  const store = await openAtomicStore(d);
  await expectOwnLock(join(d, "state.lock"));
  await store.close();
  await expect(readFile(join(d, "state.lock"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses any existing lock unless reclaiming is asked for", async () => {
  const d = await dir();
  await writeFile(join(d, "state.lock"), `999999 ${boot()}\n`);
  await expect(openAtomicStore(d)).rejects.toMatchObject({ code: "EEXIST" });
});

it("reclaims a lock from a process that is gone or from an earlier boot", async () => {
  for (const content of [`999999 ${boot()}\n`, `${process.pid} ${boot() - 86400}\n`]) {
    const d = await dir();
    await writeFile(join(d, "state.lock"), content);
    const store = await openAtomicStore(d, { reclaimStaleLock: true });
    await expectOwnLock(join(d, "state.lock"));
    await store.close();
  }
});

it("keeps refusing a lock held by a running process in this boot, or one it cannot read", async () => {
  for (const content of [`${process.pid} ${boot()}\n`, "", "garbage\n"]) {
    const d = await dir();
    await writeFile(join(d, "state.lock"), content);
    await expect(openAtomicStore(d, { reclaimStaleLock: true })).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await readFile(join(d, "state.lock"), "utf8")).toBe(content);
  }
});
