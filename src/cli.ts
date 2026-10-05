#!/usr/bin/env node
import { BridgeError, errorResult } from "./errors.js";
const [command, ...args] = process.argv.slice(2);
if (command === "--help" || command === "help" || !command) {
  console.log(
    "orca-dots-bridge <overview|waiting|detail|logs|inspect|send> [--limit N] [--cursor C] [--id WORKTREE_ID] [--handle TERMINAL_HANDLE] [--max-chars N] [--text TEXT] [--expected-worktree-id ID]\nJSON output. Set ORCA_BIN and optionally ORCA_ENVIRONMENT. send requires an explicit terminal handle and nonempty text. No automatic runtime startup.",
  );
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
        key === "--max-chars"
          ? "maxChars"
          : key === "--expected-worktree-id"
            ? "expectedWorktreeId"
            : key.slice(2);
      if (name in options) throw new BridgeError("invalid_input", "Duplicate flag.");
      options[name] = ["limit", "maxChars"].includes(name) ? Number(value) : value;
    }
    const bridge = new Bridge();
    if (!["overview", "waiting", "detail", "logs", "inspect", "send"].includes(command))
      throw new BridgeError("invalid_input", "Unknown command.");
    const result =
      await bridge[command as "overview" | "waiting" | "detail" | "logs" | "inspect" | "send"](
        options,
      );
    console.log(serialize({ ok: true, result }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: errorResult(e) }));
    process.exitCode = 1;
  }
}
