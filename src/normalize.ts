import type { Agent, Worktree } from "./contracts.js";
export function clip(value: string | null | undefined, max = 500) {
  if (value == null) return null;
  return value.length <= max ? value : value.slice(0, max - 1) + "…";
}
export function normalizeAgent(a: Agent, now = Date.now()) {
  const known = ["working", "blocked", "waiting", "done"].includes(a.state);
  const ageMs = a.updatedAt == null ? null : Math.max(0, now - a.updatedAt);
  return {
    paneKey: a.paneKey,
    parentPaneKey: a.parentPaneKey ?? null,
    state: known ? a.state : "unknown",
    reportedState: clip(a.state, 80),
    title: clip(a.taskTitle || a.displayName, 200),
    agentType: clip(a.agentType, 80),
    lastResponse: clip(a.lastAssistantMessage),
    tool: clip(a.toolName, 100),
    interrupted: a.interrupted ?? false,
    stateStartedAt: a.stateStartedAt ?? null,
    updatedAt: a.updatedAt ?? null,
    freshness: a.restoredUnconfirmed
      ? "unconfirmed"
      : a.structuredHostOwned
        ? "host_owned"
        : ageMs === null
          ? "unknown"
          : ageMs > 300000
            ? "old_observation"
            : "recent",
    ageMs,
    attention: a.state === "blocked" || a.state === "waiting",
  };
}
export function normalizeWorktree(w: Worktree, now = Date.now()) {
  return {
    id: w.worktreeId,
    title: clip(w.displayName, 200),
    repo: clip(w.repo, 200),
    branch: clip(w.branch, 200),
    hostId: w.hostId ?? null,
    parentId: w.parentWorktreeId ?? null,
    reportedStatus: clip(w.status, 80),
    pullRequest: w.linkedPR ?? null,
    lastOutputAt: w.lastOutputAt ?? null,
    agentCount: w.agents.length,
    agents: w.agents.slice(0, 20).map((a) => normalizeAgent(a, now)),
    agentsTruncated: w.agents.length > 20,
  };
}
