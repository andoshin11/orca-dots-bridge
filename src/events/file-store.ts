import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { uptime } from "node:os";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Store } from "./engine.js";
const absent = (e: unknown) => e instanceof Error && "code" in e && e.code === "ENOENT";
const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

const bootTime = () => Math.round(Date.now() / 1000 - uptime());
const code = (e: unknown) => (e instanceof Error && "code" in e ? e.code : undefined);

/**
 * One owner process; refuses symlinks and permissive directories. The lock records
 * "<pid> <boot time>". A lock from an earlier boot, or from a process that is no
 * longer running, is reclaimed only when `reclaimStaleLock` is set (a long-running
 * service restarted by launchd); trials keep refusing any existing lock.
 */
export async function openAtomicStore(
  directory: string,
  options: { reclaimStaleLock?: boolean } = {},
): Promise<Store & { close(removeState?: boolean): Promise<void> }> {
  const dir = resolve(directory);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (await realpath(dir)) !== dir
  )
    throw new Error("unsafe_store_directory");
  const state = join(dir, "state.enc"),
    lock = join(dir, "state.lock");
  const mine = `${process.pid} ${bootTime()}\n`;
  // The lock appears with its content in one step (link), so it is never empty.
  const acquire = async () => {
    const temp = join(dir, `.lock-${randomUUID()}`);
    await writeFile(temp, mine, { mode: 0o600, flag: "wx" });
    try {
      await link(temp, lock);
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  };
  try {
    await acquire();
  } catch (error) {
    if (!options.reclaimStaleLock || code(error) !== "EEXIST") throw error;
    const held = await readFile(lock, "utf8").catch(() => "");
    const [pid, boot] = held.trim().split(" ").map(Number);
    const known = Number.isInteger(pid) && pid! > 0 && Number.isFinite(boot);
    // PIDs are reused across restarts, so a lock from an earlier boot is stale whatever its PID.
    const stale = known && (Math.abs(boot! - bootTime()) > 120 || !running(pid!));
    if (!stale) throw error;
    // Move it aside, then make sure it is the stale lock we read and not one another
    // process took in the meantime; if it is not, put it back and give up.
    const moved = join(dir, `.stale-${randomUUID()}`);
    await rename(lock, moved);
    if ((await readFile(moved, "utf8")) !== held) {
      await link(moved, lock).catch(() => undefined);
      await unlink(moved);
      throw error;
    }
    await unlink(moved);
    await acquire();
  }
  const lease = await open(lock, "r");
  let closed = false;
  let accepting = true;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    if (!accepting) return Promise.reject(new Error("store_closed"));
    const result = queue.then(run);
    queue = result.catch(() => undefined);
    return result;
  };
  const syncDirectory = async () => {
    const h = await open(dir, "r");
    try {
      await h.sync();
    } finally {
      await h.close();
    }
  };
  return {
    load: () =>
      serial(async () => {
        let handle;
        try {
          handle = await open(state, constants.O_RDONLY | constants.O_NOFOLLOW);
        } catch (e) {
          if (absent(e)) return null;
          throw e;
        }
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > 48000000 || (stat.mode & 0o077) !== 0)
            throw new Error("unsafe_store_file");
          return await handle.readFile("utf8");
        } finally {
          await handle.close();
        }
      }),
    save: (blob) =>
      serial(async () => {
        if (Buffer.byteLength(blob) > 48000000) throw new Error("store_too_large");
        const temp = join(dir, `.state-${randomUUID()}.tmp`);
        const handle = await open(temp, "wx", 0o600);
        try {
          await handle.writeFile(blob, "utf8");
          await handle.sync();
        } catch (error) {
          await unlink(temp).catch(() => undefined);
          throw error;
        } finally {
          await handle.close();
        }
        try {
          await rename(temp, state);
          await syncDirectory();
        } finally {
          await unlink(temp).catch((e) => {
            if (!absent(e)) throw e;
          });
        }
      }),
    close: async (removeState = false) => {
      accepting = false;
      await queue;
      if (closed) return;
      closed = true;
      try {
        if (removeState) {
          await unlink(state).catch((e) => {
            if (!absent(e)) throw e;
          });
          await syncDirectory();
        }
      } finally {
        await lease.close();
        await unlink(lock);
      }
    },
  };
}
