import { randomBytes } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createMacKeychain, type KeyAccount } from "./events/keychain.js";

export const defaultRelayConfigPath = () =>
  join(homedir(), ".config", "orca-agent-status-relay", "config.json");

/**
 * Creates the relay signing key in the Keychain and writes the plugin config
 * that carries the same key, so the secret is never shown, typed or passed on
 * argv. Refuses to overwrite either an existing Keychain account or config file.
 */
export async function setupRelayKey(options: {
  keys: {
    putNew(account: KeyAccount, key: Buffer): Promise<void>;
    remove(account: KeyAccount): Promise<void>;
  };
  configPath: string;
  relayPort: number;
  random?: (size: number) => Buffer;
}) {
  if (!Number.isInteger(options.relayPort) || options.relayPort < 1024 || options.relayPort > 65535)
    throw new Error("invalid_relay_port");
  await mkdir(dirname(options.configPath), { recursive: true, mode: 0o700 });
  // Claim the config path first so an existing plugin config is never replaced.
  const file = await open(options.configPath, "wx", 0o600).catch((error: unknown) => {
    throw new Error(
      (error as NodeJS.ErrnoException).code === "EEXIST"
        ? "relay_config_exists"
        : "relay_config_unwritable",
    );
  });
  const key = (options.random ?? randomBytes)(32);
  let stored = false;
  try {
    await options.keys.putNew("relay-v1", key);
    stored = true;
    const config = {
      url: `http://127.0.0.1:${options.relayPort}/relay`,
      secret: `whsec_${key.toString("base64")}`,
    };
    await file.writeFile(`${JSON.stringify(config, null, 2)}\n`);
    await file.close();
  } catch (error) {
    await file.close().catch(() => undefined);
    await unlink(options.configPath).catch(() => undefined);
    // Never leave a Keychain key that no plugin config carries.
    if (stored) await options.keys.remove("relay-v1").catch(() => undefined);
    throw error;
  } finally {
    key.fill(0);
  }
}

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
        const code =
          error instanceof Error && /^[a-z_]{1,64}$/.test(error.message)
            ? error.message
            : "relay_setup_failed";
        process.stdout.write(`Relay setup failed: ${code}\n`);
        process.exitCode = 1;
      },
    );
  }
}
