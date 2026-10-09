import { timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
const service = "orca-dots-bridge.notifications-test";
export type KeyAccount = "outbox-v1" | "service-v1" | "relay-v1";
type Result = { code: number; stdout: string };
export type KeychainCommand = (args: string[], input?: string) => Promise<Result>;
const runSecurity: KeychainCommand = (args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    let output = "",
      overflow = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("keychain_timeout"));
    }, 10000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.length > 8192) {
        overflow = true;
        child.kill();
      }
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("keychain_unavailable"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (overflow) reject(new Error("keychain_output_limit"));
      else resolve({ code: code ?? -1, stdout: output });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input ?? "");
  });
/** Explicit calls only; secrets go over stdin, never command-line arguments. */
export function createMacKeychain(
  command: KeychainCommand = runSecurity,
  platform = process.platform,
) {
  if (platform !== "darwin") throw new Error("macos_keychain_required");
  const accountName = (account: KeyAccount) => {
    if (account !== "outbox-v1" && account !== "service-v1" && account !== "relay-v1")
      throw new Error("invalid_key_account");
    return account;
  };
  return {
    read: async (account: KeyAccount) => {
      const result = await command([
        "find-generic-password",
        "-s",
        service,
        "-a",
        accountName(account),
        "-w",
      ]);
      if (result.code !== 0) throw new Error("keychain_read_failed");
      const value = result.stdout.trim(),
        key = Buffer.from(value, "base64");
      if (key.length !== 32 || key.toString("base64") !== value)
        throw new Error("invalid_keychain_key");
      return key;
    },
    putNew: async (account: KeyAccount, key: Buffer) => {
      if (key.length !== 32) throw new Error("invalid_keychain_key");
      const name = accountName(account);
      const existing = await command(["find-generic-password", "-s", service, "-a", name]);
      if (existing.code !== 44) throw new Error("keychain_account_exists_or_unavailable");
      const result = await command(
        ["-i"],
        `add-generic-password -s ${service} -a ${name} -w ${key.toString("base64")}\n`,
      );
      if (result.code !== 0) throw new Error("keychain_write_failed");
      const verify = await command(["find-generic-password", "-s", service, "-a", name, "-w"]);
      const actual = Buffer.from(verify.stdout.trim(), "base64");
      try {
        if (verify.code !== 0 || actual.length !== key.length || !timingSafeEqual(actual, key))
          throw new Error("keychain_write_unconfirmed");
      } finally {
        actual.fill(0);
      }
    },
    remove: async (account: KeyAccount) => {
      const result = await command([
        "delete-generic-password",
        "-s",
        service,
        "-a",
        accountName(account),
      ]);
      if (result.code !== 0 && result.code !== 44) throw new Error("keychain_delete_failed");
    },
  };
}
