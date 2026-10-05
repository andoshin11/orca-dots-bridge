#!/usr/bin/env node
// Synthetic CLI fixture; never connects to Orca or executes instruction text.
const args = process.argv.slice(2);
const verb = args.slice(0, 2).join(" ");
const handle = args[args.indexOf("--terminal") + 1];
const text = args[args.indexOf("--text") + 1];
let result;
if (verb === "worktree ps") result = { worktrees: [], totalCount: 0, truncated: false };
else if (verb === "terminal list") result = { terminals: [], totalCount: 0, truncated: false };
else if (verb === "terminal show" && handle === "term_fixture")
  result = {
    terminal: {
      handle,
      worktreeId: "w1",
      tabId: "tab",
      leafId: "leaf",
      connected: true,
      writable: true,
      agentIdentity: "codex",
    },
  };
else if (verb === "terminal send" && handle === "term_fixture") {
  const accepted = text !== "refuse";
  result = {
    send: {
      handle,
      accepted,
      bytesWritten: accepted ? Buffer.byteLength(text) : 0,
      ...(!accepted ? { refusedReason: "permission" } : {}),
    },
  };
  if (!accepted) process.exitCode = 1;
}
if (result) console.log(JSON.stringify({ ok: true, result }));
else {
  console.log(JSON.stringify({ ok: false, error: { code: "unsupported_operation" } }));
  process.exitCode = 1;
}
