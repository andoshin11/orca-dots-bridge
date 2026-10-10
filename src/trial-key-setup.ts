import { writeSync } from "node:fs";
import { isatty } from "node:tty";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createMacKeychain } from "./events/keychain.js";
import { KeySetupError, setupTrialKeys, type SetupKeys } from "./key-setup-shared.js";

export { KeySetupError, setupTrialKeys } from "./key-setup-shared.js";

export function apiKeyText(apiKey: string) {
  return (
    "\n【dot プラグインの API キー（この画面にだけ 1 回表示します）】\n" +
    "チャット・Git・コマンド引数・通常ログには貼らないでください。認証ヘッダーは `Authorization: Bearer <このキー>` です。\n" +
    apiKey +
    "\n"
  );
}

/** The command's behaviour, separated from process wiring so it can be tested. */
export async function runTrialKeySetup(io: {
  args: string[];
  stderrIsTerminal: boolean;
  keys: () => SetupKeys;
  writeStdout: (text: string) => void;
  writeStderr: (bytes: Buffer) => void;
}): Promise<number> {
  if (io.args.length > 0) {
    io.writeStdout(
      "Usage: trial-key-setup\nCreates Keychain accounts outbox-v1 and service-v1 and shows the service API key once on the private terminal (stderr). Refuses to overwrite either.\n",
    );
    return 1;
  }
  // Checked before any key exists, so a redirected stderr never receives the API key.
  if (!io.stderrIsTerminal) {
    io.writeStdout("Trial key setup failed: private_terminal_required\n");
    return 1;
  }
  try {
    await setupTrialKeys({
      keys: io.keys(),
      showApiKey: (apiKey) => {
        const bytes = Buffer.from(apiKeyText(apiKey));
        try {
          io.writeStderr(bytes);
        } finally {
          bytes.fill(0);
        }
      },
    });
    io.writeStdout("Trial keys created (outbox-v1, service-v1).\n");
    return 0;
  } catch (error) {
    const code = error instanceof KeySetupError ? error.message : "trial_key_setup_failed";
    const leftover =
      error instanceof KeySetupError && error.leftover.length > 0
        ? ` (check Keychain accounts: ${error.leftover.join(", ")})`
        : "";
    io.writeStdout(`Trial key setup failed: ${code}${leftover}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void runTrialKeySetup({
    args: process.argv.slice(2),
    stderrIsTerminal: isatty(2),
    keys: () => createMacKeychain(),
    writeStdout: (text) => {
      process.stdout.write(text);
    },
    writeStderr: (bytes) => {
      for (let offset = 0; offset < bytes.length;)
        offset += writeSync(2, bytes, offset, bytes.length - offset);
    },
  }).then((code) => {
    process.exitCode = code;
  });
}
