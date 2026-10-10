import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createMacKeychain } from "./events/keychain.js";
import {
  defaultRelayConfigPath,
  KeySetupError,
  setupErrorCode,
  setupRelayKey,
} from "./key-setup-shared.js";

export { defaultRelayConfigPath, setupRelayKey } from "./key-setup-shared.js";

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const portIndex = args.indexOf("--relay-port");
  const configIndex = args.indexOf("--config-path");
  const relayPort = portIndex >= 0 ? Number(args[portIndex + 1]) : Number.NaN;
  const configPath = configIndex >= 0 ? args[configIndex + 1] : defaultRelayConfigPath();
  const known = args.every(
    (arg, i) =>
      ["--relay-port", "--config-path"].includes(arg) ||
      ["--relay-port", "--config-path"].includes(args[i - 1] ?? ""),
  );
  if (!known || !configPath || Number.isNaN(relayPort)) {
    process.stdout.write(
      "Usage: relay-key-setup --relay-port PORT [--config-path PATH]\nCreates Keychain account relay-v1 and the orca-agent-status-relay config. Refuses to overwrite either.\n",
    );
    process.exitCode = 1;
  } else {
    setupRelayKey({ keys: createMacKeychain(), configPath, relayPort }).then(
      () => process.stdout.write(`Relay key created; plugin config written to ${configPath}\n`),
      (error: unknown) => {
        const code = setupErrorCode(error, "relay_setup_failed");
        const leftover =
          error instanceof KeySetupError && error.leftover.length > 0
            ? ` (check Keychain account: ${error.leftover.join(", ")})`
            : "";
        process.stdout.write(`Relay setup failed: ${code}${leftover}\n`);
        process.exitCode = 1;
      },
    );
  }
}
