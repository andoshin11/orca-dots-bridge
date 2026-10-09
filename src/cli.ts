#!/usr/bin/env node
import { BridgeError, errorResult } from "./errors.js";
const [command, ...args] = process.argv.slice(2);
if (command === "--help" || command === "help" || !command) {
  console.log(
    "orca-dots-bridge <status|overview|waiting|detail|logs|inspect|send|pane-target> [--repo REPO --name NAME] [--branch BRANCH] [--host-id HOST] [--limit N] [--cursor C] [--id WORKTREE_ID] [--handle TERMINAL_HANDLE] [--max-chars N] [--text TEXT] [--expected-worktree-id ID]\nJSON output. Set ORCA_BIN and optionally ORCA_ENVIRONMENT. send requires an explicit terminal handle and nonempty text. pane-target --handle prints the pane notification target and its targetHash. No automatic runtime startup.",
  );
} else if (command === "pane-target") {
  try {
    if (args.length !== 2 || args[0] !== "--handle" || !args[1])
      throw new BridgeError(
        "invalid_input",
        "pane-target requires exactly --handle TERMINAL_HANDLE.",
      );
    const [{ createRunner }, { createPaneDescriber }, { digest }] = await Promise.all([
      import("./adapter.js"),
      import("./events/pane-contract.js"),
      import("./events/model.js"),
    ]);
    const target = await createPaneDescriber(createRunner())(args[1]);
    console.log(JSON.stringify({ ok: true, result: { target, targetHash: digest(target) } }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: errorResult(e) }));
    process.exitCode = 1;
  }
} else {
  try {
    const { Bridge, serialize } = await import("./service.js");
    const options: Record<string, unknown> = {};
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i],
        value = args[i + 1];
      if (
        !key ||
        !value ||
        ![
          "--repo",
          "--name",
          "--branch",
          "--host-id",
          "--limit",
          "--cursor",
          "--id",
          "--handle",
          "--max-chars",
          "--text",
          "--expected-worktree-id",
        ].includes(key)
      )
        throw new BridgeError("invalid_input", "Unknown flag or missing value.");
      const name =
        key === "--host-id"
          ? "hostId"
          : key === "--max-chars"
            ? "maxChars"
            : key === "--expected-worktree-id"
              ? "expectedWorktreeId"
              : key.slice(2);
      if (name in options) throw new BridgeError("invalid_input", "Duplicate flag.");
      options[name] = ["limit", "maxChars"].includes(name) ? Number(value) : value;
    }
    const bridge = new Bridge();
    if (!["status", "overview", "waiting", "detail", "logs", "inspect", "send"].includes(command))
      throw new BridgeError("invalid_input", "Unknown command.");
    const result =
      await bridge[
        command as "status" | "overview" | "waiting" | "detail" | "logs" | "inspect" | "send"
      ](options);
    console.log(serialize({ ok: true, result }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: errorResult(e) }));
    process.exitCode = 1;
  }
}
