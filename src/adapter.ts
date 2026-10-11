import { execFile } from "node:child_process";
import { z } from "zod";
import { BridgeError } from "./errors.js";
import {
  psSchema,
  terminalsSchema,
  terminalShowSchema,
  logSchema,
  sendResultSchema,
  createResultSchema,
  closeResultSchema,
  closeAllResultSchema,
  removeResultSchema,
} from "./contracts.js";
/** `timeout` overrides the runner's default for slow writes (creating a checkout). */
export type Runner = (args: string[], options?: { timeout?: number }) => Promise<string>;
export function createRunner(
  binary = process.env.ORCA_BIN || "orca",
  environment = process.env.ORCA_ENVIRONMENT,
  timeout = 10000,
  maxBytes = 8 * 1024 * 1024,
): Runner {
  return (args, options) =>
    new Promise((resolve, reject) => {
      // No shell, no arbitrary verbs or caller-provided flags. Pairing credentials never appear in argv.
      execFile(
        binary,
        [...args, ...(environment ? ["--environment", environment] : []), "--json"],
        { timeout: options?.timeout ?? timeout, maxBuffer: maxBytes, encoding: "utf8" },
        (error, stdout) => {
          if (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT")
              return reject(
                new BridgeError(
                  "cli_missing",
                  "Orca CLI was not found. Set ORCA_BIN to its absolute path.",
                ),
              );
            if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
              return reject(
                new BridgeError("output_limit", "Orca output exceeded the adapter byte limit."),
              );
            if (error.killed)
              return reject(
                new BridgeError(
                  "timeout",
                  "Orca command timed out; runtime availability is unknown.",
                ),
              );
            // Preserve structured runtime failures even when Orca exits nonzero. Never expose raw stderr.
            try {
              const result = unwrap(stdout);
              // Orca returns ok:true plus accepted:false and exits 1 for a refused send.
              if (args[0] === "terminal" && args[1] === "send") {
                const refused = z.object({ send: sendResultSchema }).safeParse(result);
                if (refused.success && !refused.data.send.accepted) return resolve(stdout);
              }
            } catch (e) {
              if (
                e instanceof BridgeError &&
                e.code !== "invalid_json" &&
                e.code !== "schema_changed"
              )
                return reject(e);
            }
            return reject(
              new BridgeError(
                "cli_failed",
                "Orca CLI failed; check runtime connectivity and local CLI configuration.",
              ),
            );
          }
          resolve(stdout);
        },
      );
    });
}
export function unwrap(raw: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new BridgeError("invalid_json", "Orca returned invalid JSON.");
  }
  const envelope = z
    .object({
      ok: z.boolean(),
      result: z.unknown().optional(),
      error: z.object({ code: z.string() }).optional(),
    })
    .safeParse(value);
  if (!envelope.success)
    throw new BridgeError("schema_changed", "Orca response envelope is incompatible.");
  if (!envelope.data.ok) {
    const remote = envelope.data.error?.code ?? "runtime_error";
    const safeCode = /^[a-z_]{1,80}$/.test(remote) ? remote : "runtime_error";
    throw new BridgeError(
      safeCode,
      "Orca could not complete this command. Check runtime reachability, target environment and access.",
    );
  }
  return envelope.data.result;
}
export class OrcaAdapter {
  constructor(private run: Runner = createRunner()) {}
  private async read<T>(args: string[], schema: z.ZodType<T>, timeout?: number): Promise<T> {
    const parsed = schema.safeParse(
      unwrap(await (timeout === undefined ? this.run(args) : this.run(args, { timeout }))),
    );
    if (!parsed.success)
      throw new BridgeError(
        "schema_changed",
        "Orca result fields are incompatible; update the adapter for this CLI version.",
      );
    return parsed.data;
  }
  ps() {
    return this.read(["worktree", "ps", "--limit", "1001"], psSchema);
  }
  terminals() {
    return this.read(["terminal", "list", "--limit", "1001"], terminalsSchema);
  }
  show(handle: string) {
    return this.read(
      ["terminal", "show", "--terminal", handle],
      z.object({ terminal: terminalShowSchema }),
    ).then((r) => r.terminal);
  }
  logs(handle: string, limit: number, cursor?: string) {
    return this.read(
      [
        "terminal",
        "read",
        "--terminal",
        handle,
        "--limit",
        String(limit),
        ...(cursor === undefined ? [] : ["--cursor", cursor]),
      ],
      z.object({ terminal: logSchema }),
    ).then((r) => r.terminal);
  }
  /** The rendered screen's last `limit` rows (`--screen`): what a TUI shows right now. */
  screen(handle: string, limit: number) {
    return this.read(
      ["terminal", "read", "--terminal", handle, "--screen", "--limit", String(limit)],
      z.object({ terminal: logSchema }),
    ).then((r) => r.terminal);
  }
  /**
   * Types keys without Enter, written raw (no bracketed paste) by Orca: a menu digit.
   * Only a single menu digit is accepted here.
   */
  keys(handle: string, keys: string) {
    if (!/^[1-9]$/.test(keys))
      throw new BridgeError("invalid_input", "Invalid arguments or out-of-range limit/cursor.");
    return this.read(
      ["terminal", "send", "--terminal", handle, "--text", keys],
      z.object({ send: sendResultSchema }),
    ).then((r) => r.send);
  }
  send(handle: string, text: string) {
    return this.read(
      ["terminal", "send", "--terminal", handle, "--text", text, "--enter"],
      z.object({ send: sendResultSchema }),
    ).then((r) => r.send);
  }
  /**
   * A new independent worktree in an exact repo. Never activates the app, forces setup
   * hooks or links issues/PRs. `--json` is appended by the runner.
   */
  createWorktree(input: {
    repo: string;
    name: string;
    baseBranch?: string;
    agent?: string;
    prompt?: string;
  }) {
    return this.read(
      [
        "worktree",
        "create",
        "--no-parent",
        "--setup",
        "inherit",
        "--repo",
        value(`name:${input.repo}`),
        "--name",
        value(input.name),
        ...(input.baseBranch === undefined ? [] : ["--base-branch", value(input.baseBranch)]),
        ...(input.agent === undefined ? [] : ["--agent", value(input.agent)]),
        ...(input.prompt === undefined ? [] : ["--prompt", value(input.prompt)]),
      ],
      createResultSchema,
      60000,
    );
  }
  closeTerminal(handle: string) {
    return this.read(
      ["terminal", "close", "--terminal", value(handle)],
      closeResultSchema,
      20000,
    ).then((r) => r.close);
  }
  closeAllTerminals(worktreeId: string) {
    return this.read(
      ["terminal", "close", "--worktree", value(`id:${worktreeId}`), "--all"],
      closeAllResultSchema,
      30000,
    );
  }
  /** Never `--force`, `--run-hooks` or a failed-hook waiver: Orca's own refusals stand. */
  removeWorktree(worktreeId: string) {
    return this.read(
      ["worktree", "rm", "--worktree", value(`id:${worktreeId}`)],
      removeResultSchema,
      60000,
    );
  }
}

/** Defense in depth for write commands: a value is bounded and never reads as a flag. */
function value(text: string) {
  if (
    text.length === 0 ||
    Buffer.byteLength(text, "utf8") > 16000 ||
    text.trimStart().startsWith("-") ||
    text.includes("\0")
  )
    throw new BridgeError("invalid_input", "Invalid arguments or out-of-range limit/cursor.");
  return text;
}
