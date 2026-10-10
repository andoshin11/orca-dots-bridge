import { spawnSync } from "node:child_process";
import { expect, it } from "vite-plus/test";
import { createMacKeychain, type KeychainCommand } from "../src/events/keychain.js";

// Runs the built entry points (verify packs before testing), so a bundling change
// that detaches a command's main block from its entry file fails here.
function runBuilt(entry: string, args: string[] = []) {
  return spawnSync(process.execPath, [`dist/${entry}`, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
  });
}

it("built trial-key-setup refuses a non-terminal stderr and shows usage for arguments", () => {
  const piped = runBuilt("trial-key-setup.mjs");
  expect(piped.status).toBe(1);
  expect(piped.stdout).toBe("Trial key setup failed: private_terminal_required\n");
  expect(piped.stderr).toBe("");
  const usage = runBuilt("trial-key-setup.mjs", ["--force"]);
  expect(usage.status).toBe(1);
  expect(usage.stdout).toMatch(/^Usage: trial-key-setup/);
});

it("built relay-key-setup shows usage without a port", () => {
  const usage = runBuilt("relay-key-setup.mjs");
  expect(usage.status).toBe(1);
  expect(usage.stdout).toMatch(/^Usage: relay-key-setup/);
});

it("built setup shows usage for unknown arguments", () => {
  const usage = runBuilt("setup.mjs", ["--force"]);
  expect(usage.status).toBe(1);
  expect(usage.stdout).toMatch(/^Usage: setup/);
});

function keychainFailingAt(phase: "find" | "add" | "verify"): KeychainCommand {
  return async (args) => {
    if (args[0] === "-i") {
      if (phase === "add") throw new Error("keychain_timeout");
      return { code: 0, stdout: "" };
    }
    if (args.includes("-w")) {
      if (phase === "verify") throw new Error("keychain_timeout");
      return { code: 0, stdout: Buffer.alloc(32, 1).toString("base64") };
    }
    if (phase === "find") throw new Error("keychain_timeout");
    return { code: 44, stdout: "" };
  };
}

it("putNew names failures by phase: nothing written before add, maybe written from add on", async () => {
  const key = () => Buffer.alloc(32, 1);
  await expect(
    createMacKeychain(keychainFailingAt("find"), "darwin").putNew("relay-v1", key()),
  ).rejects.toThrow("keychain_account_exists_or_unavailable");
  await expect(
    createMacKeychain(keychainFailingAt("add"), "darwin").putNew("relay-v1", key()),
  ).rejects.toThrow("keychain_write_unconfirmed");
  await expect(
    createMacKeychain(keychainFailingAt("verify"), "darwin").putNew("relay-v1", key()),
  ).rejects.toThrow("keychain_write_unconfirmed");
});
