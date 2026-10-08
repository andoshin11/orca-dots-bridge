import { expect, it, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat, symlink, mkdir, chmod, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAtomicStore } from "../src/events/file-store.js";
import { createMacKeychain, type KeychainCommand } from "../src/events/keychain.js";
import { createServiceKeyResolver } from "../src/events/service-key.js";
const directories: string[] = [];
afterEach(async () => {
  for (const p of directories.splice(0)) await rm(p, { recursive: true, force: true });
});
async function directory() {
  const p = await realpath(await mkdtemp(join(tmpdir(), "orca-store-fixture-")));
  directories.push(p);
  return p;
}
it("persists atomically, survives reopen, rejects a second writer, and removes state on explicit close", async () => {
  const dir = await directory();
  const store = await openAtomicStore(dir);
  expect(await store.load()).toBeNull();
  await store.save("synthetic-encrypted-blob");
  expect(await readFile(join(dir, "state.enc"), "utf8")).toBe("synthetic-encrypted-blob");
  expect((await stat(join(dir, "state.enc"))).mode & 0o777).toBe(0o600);
  await expect(openAtomicStore(dir)).rejects.toThrow();
  await store.close();
  const reopened = await openAtomicStore(dir);
  expect(await reopened.load()).toBe("synthetic-encrypted-blob");
  await reopened.close(true);
  await expect(readFile(join(dir, "state.enc"))).rejects.toThrow();
  await expect(reopened.save("late")).rejects.toThrow("store_closed");
});
it("refuses symlinked and permissive directories", async () => {
  const root = await directory();
  const target = join(root, "target"),
    link = join(root, "link");
  await mkdir(target, { mode: 0o700 });
  await symlink(target, link);
  await expect(openAtomicStore(link)).rejects.toThrow("unsafe_store_directory");
  await chmod(target, 0o755);
  await expect(openAtomicStore(target)).rejects.toThrow("unsafe_store_directory");
});
it("refuses symlinked state without reading its destination", async () => {
  const dir = await directory();
  const store = await openAtomicStore(dir);
  await symlink(join(dir, "outside"), join(dir, "state.enc"));
  await expect(store.load()).rejects.toThrow();
  await store.close(true);
});
it("does not replace durable state when writing an oversized update fails", async () => {
  const dir = await directory();
  const store = await openAtomicStore(dir);
  await store.save("old");
  await expect(store.save("x".repeat(48000001))).rejects.toThrow("store_too_large");
  expect(await store.load()).toBe("old");
  await store.close(true);
});
it("checks only the configured service key, expiry and explicit revocation", async () => {
  let clock = 100;
  const key = Buffer.alloc(32, 3);
  const auth = createServiceKeyResolver({
    keyId: "fixture",
    secret: key,
    expiresAt: 200,
    now: () => clock,
  });
  const header = `Bearer ${key.toString("base64url")}`;
  expect(await auth.resolve(header)).toBe("service:fixture");
  for (const value of [undefined, "", "Bearer wrong", `${header}, Bearer other`])
    await expect(auth.resolve(value)).rejects.toThrow("unauthorized");
  clock = 200;
  await expect(auth.resolve(header)).rejects.toThrow("unauthorized");
  clock = 100;
  auth.revoke();
  await expect(auth.resolve(header)).rejects.toThrow("unauthorized");
});
it("Keychain adapter passes secrets only through stdin and confirms persistence", async () => {
  const key = Buffer.alloc(32, 8);
  const calls: { args: string[]; input?: string }[] = [];
  const command: KeychainCommand = async (args, input) => {
    calls.push({ args, input });
    return args[0] === "find-generic-password"
      ? args.includes("-w")
        ? { code: 0, stdout: key.toString("base64") }
        : { code: 44, stdout: "" }
      : { code: 0, stdout: "" };
  };
  const keys = createMacKeychain(command, "darwin");
  await keys.putNew("outbox-v1", key);
  expect(calls.every((c) => !c.args.join(" ").includes(key.toString("base64")))).toBe(true);
  expect(calls.find((c) => c.args[0] === "-i")?.input).toContain(key.toString("base64"));
  expect(await keys.read("outbox-v1")).toEqual(key);
  await keys.remove("outbox-v1");
});
it("Keychain refuses existing accounts and masks errors without reporting secrets", async () => {
  const keys = createMacKeychain(async () => ({ code: 0, stdout: "sensitive-fixture" }), "darwin");
  await expect(keys.putNew("service-v1", Buffer.alloc(32))).rejects.toThrow(
    "keychain_account_exists_or_unavailable",
  );
  await expect(keys.read("service-v1")).rejects.toThrow("invalid_keychain_key");
  expect(() => createMacKeychain(undefined, "linux")).toThrow("macos_keychain_required");
});
