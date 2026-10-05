import { execFile } from "node:child_process";
import { z } from "zod";
import { BridgeError } from "./errors.js";
import {
  psSchema,
  terminalsSchema,
  terminalShowSchema,
  logSchema,
  sendResultSchema,
} from "./contracts.js";
export type Runner = (args: string[]) => Promise<string>;
export function createRunner(
  binary = process.env.ORCA_BIN || "orca",
  environment = process.env.ORCA_ENVIRONMENT,
  timeout = 10000,
  maxBytes = 8 * 1024 * 1024,
): Runner {
  return (args) =>
    new Promise((resolve, reject) => {
      // No shell, no arbitrary verbs or caller-provided flags. Pairing credentials never appear in argv.
      execFile(
        binary,
        [...args, ...(environment ? ["--environment", environment] : []), "--json"],
        { timeout, maxBuffer: maxBytes, encoding: "utf8" },
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
  private async read<T>(args: string[], schema: z.ZodType<T>): Promise<T> {
    const parsed = schema.safeParse(unwrap(await this.run(args)));
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
  send(handle: string, text: string) {
    return this.read(
      ["terminal", "send", "--terminal", handle, "--text", text, "--enter"],
      z.object({ send: sendResultSchema }),
    ).then((r) => r.send);
  }
}
