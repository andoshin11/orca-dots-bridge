import { writeSync } from "node:fs";
import { isatty } from "node:tty";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import { createMacKeychain } from "./events/keychain.js";
import { createCallbackPreflight } from "./events/callback-preflight.js";
import { createLoopbackServer } from "./events/loopback-server.js";
import { notificationTargetSchema } from "./events/orca-contract.js";
import { createPreflightDiagnostics } from "./events/preflight-diagnostics.js";

// User-launched only. Never run this CLI through an assistant tool with real credentials.
export async function runNotificationPreflight(
  readKey = () => createMacKeychain().read("service-v1"),
) {
  let stage = "config";
  try {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk.toString();
      if (Buffer.byteLength(input) > 65536) throw new Error("input_limit");
    }
    const config = z
      .object({
        target: notificationTargetSchema,
        port: z.number().int().min(1024).max(65535).default(8787),
        diagnosticsPath: z.string().max(4096).optional(),
      })
      .strict()
      .parse(JSON.parse(input));
    input = "";
    stage = "diagnostics";
    const diagnostic = config.diagnosticsPath
      ? createPreflightDiagnostics(config.diagnosticsPath)
      : undefined;
    // Must have a user's private TTY before reading any real key.
    stage = "review_terminal";
    if (!isatty(2)) throw new Error("review_terminal_unavailable");
    const writeReview = (text: string) => {
      const bytes = Buffer.from(text);
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(2, bytes, offset, bytes.length - offset);
    };
    let key: Buffer | undefined;
    let closing = false;
    let writes = Promise.resolve();
    const expiresAt = Date.now() + 600000;
    let endpoint: ReturnType<typeof createCallbackPreflight> | undefined;
    const server = createLoopbackServer(
      config.port,
      () => (closing ? undefined : endpoint),
      diagnostic,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const close = async () => {
      if (closing) return;
      closing = true;
      if (timer) clearTimeout(timer);
      endpoint?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      key?.fill(0);
      await writes;
      try {
        diagnostic?.("stopped");
      } finally {
        finish();
      }
    };
    try {
      stage = "service_key_read";
      key = await readKey();
      stage = "endpoint_config";
      endpoint = createCallbackPreflight({
        target: config.target,
        serviceKey: key,
        expiresAt,
        diagnostic,
        review: (url, candidate) => {
          // Only printable ASCII URLs may reach the private terminal, never stdout/logs.
          writes = writes
            .then(async () => {
              if (!/^[\x21-\x7e]+$/.test(url)) throw new Error("review_url_invalid");
              writeReview(
                "\n【送信先候補を受信しました。まだ承認・送信していません】\n" +
                  "この候補が本人のアカウントに属するかは未確認です。URL全文はチャットへ貼らないでください。\n" +
                  "ホスト名（ドメイン部分）：" +
                  candidate.host +
                  "\n" +
                  "URL全文（次の1行を、後の非表示入力欄だけへ貼り付けます）：\n" +
                  url +
                  "\n" +
                  "対象とURLのハッシュは内部で自動照合します。ハッシュの入力は不要です。\n" +
                  "試験接続を一度止めてから、日本語の承認入力へ進みます。URLが変わった場合は送信前に停止します。\n",
              );
              diagnostic?.("candidate_displayed");
              process.stdout.write(
                "Callback candidate displayed; no subscription created. metadata=" +
                  JSON.stringify(candidate) +
                  "\n",
              );
            })
            .catch(() => {
              try {
                diagnostic?.("candidate_display_failed");
              } catch {
                /* storage failure also stops preflight */
              }
              void close();
            });
        },
      });
      stage = "listen";
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      stage = "running";
      diagnostic?.("running");
      const stop = () => {
        void close().catch(() => {
          process.exitCode = 1;
          finish();
        });
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      timer = setTimeout(stop, Math.max(0, expiresAt - Date.now()));
      process.stdout.write(
        "Preflight only: subscriptions rejected, no outbound callback or monitoring. Stops within ten minutes.\n",
      );
      await done;
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    } finally {
      await close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    const fixed =
      code === "EADDRINUSE"
        ? "port_in_use"
        : code === "EACCES"
          ? "permission_denied"
          : [
                "review_terminal_unavailable",
                "keychain_read_failed",
                "keychain_timeout",
                "keychain_unavailable",
                "invalid_keychain_key",
                "input_limit",
                "diagnostics_unavailable",
              ].includes(message)
            ? message
            : stage === "config"
              ? "config_invalid"
              : "operation_rejected";
    process.stdout.write(`Preflight failure: stage=${stage} code=${fixed}\n`);
    throw new Error("preflight_failed");
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void runNotificationPreflight().catch(() => {
    process.exitCode = 1;
  });
}
