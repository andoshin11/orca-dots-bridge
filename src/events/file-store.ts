import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Store } from "./engine.js";
const absent = (e: unknown) => e instanceof Error && "code" in e && e.code === "ENOENT";
/** One owner process; refuses stale locks, symlinks and permissive directories. */
export async function openAtomicStore(
  directory: string,
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
  const lease = await open(lock, "wx", 0o600);
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
