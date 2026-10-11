import { z } from "zod";
const text = z.string().max(2_000_000);
const nullableText = text.nullish();
const timestamp = z.number().finite().nonnegative().nullish();
export const agentSchema = z.object({
  paneKey: text,
  parentPaneKey: nullableText,
  state: text,
  taskTitle: nullableText,
  displayName: nullableText,
  agentType: nullableText,
  lastAssistantMessage: nullableText,
  toolName: nullableText,
  interrupted: z.boolean().optional(),
  stateStartedAt: timestamp,
  updatedAt: timestamp,
  restoredUnconfirmed: z.boolean().optional(),
  structuredHostOwned: z.boolean().optional(),
});
export const worktreeSchema = z.object({
  worktreeId: text,
  hostId: nullableText,
  repo: text,
  branch: text,
  displayName: text,
  parentWorktreeId: nullableText,
  status: text,
  lastOutputAt: timestamp,
  linkedPR: z.object({ number: z.number().int(), state: text }).nullable().optional(),
  agents: z.array(agentSchema).max(10000),
  // Read by orca_remove_workspace's preflight; optional so older runtimes still parse.
  isMainWorktree: z.boolean().optional(),
  workspaceKind: text.optional(),
  liveTerminalCount: z.number().int().nonnegative().optional(),
  hasAttachedPty: z.boolean().optional(),
});
export const terminalSchema = z.object({
  handle: text,
  worktreeId: text,
  tabId: text,
  leafId: text,
  title: nullableText,
  connected: z.boolean(),
  writable: z.boolean().optional(),
  agentIdentity: text.optional(),
  lastOutputAt: timestamp,
  executionHostId: nullableText,
});
export const terminalShowSchema = terminalSchema.extend({
  agentWait: z
    .object({ source: text, reason: text.optional(), since: timestamp })
    .nullable()
    .optional(),
});
const hostScope = z.object({ hostIds: z.array(text), omittedHostIds: z.array(text) }).optional();
const listing = { totalCount: z.number().int().nonnegative(), truncated: z.boolean(), hostScope };
export const psSchema = z.object({ ...listing, worktrees: z.array(worktreeSchema).max(10000) });
export const terminalsSchema = z.object({
  ...listing,
  terminals: z.array(terminalSchema).max(10000),
});
export const logSchema = z.object({
  handle: text,
  status: z.enum(["running", "exited", "unknown"]),
  tail: z.array(text),
  truncated: z.boolean(),
  limited: z.boolean().optional(),
  nextCursor: z.string().nullable(),
  oldestCursor: nullableText,
  latestCursor: nullableText,
  source: text.optional(),
});
export type Agent = z.infer<typeof agentSchema>;
export type Worktree = z.infer<typeof worktreeSchema>;
export type Terminal = z.infer<typeof terminalSchema>;

export const sendResultSchema = z.object({
  handle: text,
  accepted: z.boolean(),
  bytesWritten: z.number().int().nonnegative(),
  refusedReason: text.optional(),
  prompt: z
    .object({
      requestId: text,
      stages: z.array(text),
      provider: text,
      observation: text,
    })
    .optional(),
});

// Write receipts. Only the fields the bridge reports are modeled; the rest pass through
// unread. Shapes come from the Orca CLI's own handlers (`worktree create`, `terminal
// close`, `worktree rm`) as shipped in October 2026.
const handleRef = z.object({ handle: text }).passthrough();
export const createResultSchema = z
  .object({
    worktree: z
      .object({
        id: text,
        displayName: nullableText,
        branch: nullableText,
        path: nullableText,
        repoId: nullableText,
      })
      .passthrough(),
    // Newer runtimes return agentTerminalHandle; older ones only startupTerminal.handle.
    agentTerminalHandle: nullableText,
    startupTerminal: handleRef.nullish(),
  })
  .passthrough();
export const closeResultSchema = z.object({
  close: z
    .object({
      handle: text,
      closeMode: nullableText,
      ptyKilled: z.boolean().optional(),
    })
    .passthrough(),
});
export const closeAllResultSchema = z
  .object({
    closed: z.number().int().nonnegative().optional(),
    stopped: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export const removeResultSchema = z
  .object({
    removed: z.boolean(),
    removing: z.boolean().optional(),
    preservedBranch: z.object({ branchName: text }).passthrough().nullish(),
  })
  .passthrough();
