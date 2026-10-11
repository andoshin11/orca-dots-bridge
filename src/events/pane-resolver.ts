import type { PaneInfo, RelayStatus } from "./pane-contract.js";

/** The identities a scope subscription needs, from one `worktree ps` + `terminal list` read. */
export type PaneInventory = {
  complete: boolean;
  worktrees: { worktreeId: string; repo: string; workspace: string }[];
  terminals: { handle: string; worktreeId: string; paneKey: string }[];
};

/** How long one inventory read answers relay statuses. */
export const inventoryTtlMs = 10000;
/** A pane missing from a cached read triggers a fresh read, but not more often than this. */
const missRefreshMs = 500;

/**
 * Resolves relay statuses (worktree id or pane key) to repo, workspace and terminal
 * through a cached inventory: at most one read every 10 s, plus one early re-read when a
 * pane or worktree is not in the cache (it may have been created since). Concurrent
 * callers share one read; a failed read is not cached.
 */
export function createPaneResolver(
  load: () => Promise<PaneInventory>,
  now: () => number = Date.now,
) {
  let cached: { at: number; value: PaneInventory } | undefined;
  let inflight: Promise<PaneInventory> | undefined;
  const read = () => {
    inflight ??= load()
      .then((value) => {
        cached = { at: now(), value };
        return value;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };
  const inventory = async (fresh = false) =>
    !fresh && cached && now() - cached.at < inventoryTtlMs ? cached.value : read();
  const lookup = (inv: PaneInventory, status: Pick<RelayStatus, "worktreeId" | "paneKey">) => {
    let worktreeId = status.worktreeId;
    const panes = inv.terminals.filter(
      (t) => t.paneKey === status.paneKey && (worktreeId === null || t.worktreeId === worktreeId),
    );
    // Only a unique terminal names the pane; never guess between two.
    const terminal = panes.length === 1 ? panes[0]! : undefined;
    worktreeId ??= terminal?.worktreeId ?? null;
    if (worktreeId === null) return null;
    const w = inv.worktrees.find((x) => x.worktreeId === worktreeId);
    if (!w) return null;
    return {
      paneKey: status.paneKey,
      worktreeId,
      repo: w.repo,
      workspace: w.workspace,
      terminalHandle: terminal?.handle ?? null,
    } satisfies PaneInfo;
  };
  return {
    inventory,
    resolve: async (
      status: Pick<RelayStatus, "worktreeId" | "paneKey">,
    ): Promise<PaneInfo | null> => {
      const first = await inventory();
      const found = lookup(first, status);
      if (found?.terminalHandle != null) return found;
      // Possibly created after the cached read: read again once, unless it was just read.
      if (cached && now() - cached.at < missRefreshMs) return found;
      return lookup(await inventory(true), status) ?? found;
    },
  };
}
