import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { BridgeError } from "./errors.js";
import { normalizeForMatch } from "./matching.js";

// Local nicknames for Orca workspaces ("でばっぐ" → one worktree id), so a name that speech
// recognition keeps mangling can be said another way. Labels only: nothing here reaches
// Orca, so no ChatGPT setting gates them.

export const maxAliases = 50;
const maxFileBytes = 64 * 1024;

/** A spoken name: 1-40 characters, printable, not only separators. */
export const aliasName = z
  .string()
  .transform((s) => s.normalize("NFKC").trim().replace(/\s+/gu, " "))
  .refine(
    (s) =>
      Array.from(s).length >= 1 &&
      Array.from(s).length <= 40 &&
      Array.from(s).every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127) &&
      normalizeForMatch(s).length > 0,
  );
const entrySchema = z
  .object({
    name: z.string().min(1).max(200),
    worktreeId: z.string().min(1).max(4096),
    updatedAt: z.number().finite().nonnegative(),
  })
  .strict();
export type Alias = z.infer<typeof entrySchema>;

export function aliasesPath(home = homedir()) {
  return join(home, ".orca-dots-bridge", "aliases.json");
}

/**
 * The alias file: `{"version":1,"aliases":[...]}`, owner-only (600), written atomically,
 * at most 50 entries. A missing, unreadable or malformed file reads as no aliases.
 */
export class AliasStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string = aliasesPath()) {}

  async list(): Promise<Alias[]> {
    let text: string;
    try {
      // O_NOFOLLOW: a symlink planted at the path is not read.
      const handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > maxFileBytes) return [];
        text = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    } catch {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return [];
    }
    const raw = (parsed as { version?: unknown; aliases?: unknown } | null) ?? {};
    if (raw.version !== 1 || !Array.isArray(raw.aliases)) return [];
    const seen = new Set<string>();
    const result: Alias[] = [];
    for (const item of raw.aliases.slice(0, maxAliases)) {
      const entry = entrySchema.safeParse(item);
      const name = entry.success ? aliasName.safeParse(entry.data.name) : null;
      if (!entry.success || !name?.success) continue;
      const key = normalizeForMatch(name.data);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ ...entry.data, name: name.data });
    }
    return result;
  }

  /** Adds or re-points one alias (names compare in their normalized form). */
  set(name: string, worktreeId: string, now = Date.now()) {
    return this.serial(async () => {
      const key = normalizeForMatch(name);
      const current = await this.list();
      const others = current.filter((a) => normalizeForMatch(a.name) !== key);
      if (others.length >= maxAliases)
        throw new BridgeError(
          "alias_limit",
          `At most ${maxAliases} aliases can be kept. Remove one with orca_remove_alias first.`,
        );
      const next = [...others, { name, worktreeId, updatedAt: now }];
      await this.write(next);
      return { replaced: current.find((a) => normalizeForMatch(a.name) === key) ?? null, next };
    });
  }

  remove(name: string) {
    return this.serial(async () => {
      const key = normalizeForMatch(name);
      const current = await this.list();
      const next = current.filter((a) => normalizeForMatch(a.name) !== key);
      if (next.length !== current.length) await this.write(next);
      return { removed: current.find((a) => normalizeForMatch(a.name) === key) ?? null, next };
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async write(aliases: Alias[]) {
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = join(dir, `.aliases-${randomUUID()}.tmp`);
    const handle = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify({ version: 1, aliases }, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, this.path);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }
}
