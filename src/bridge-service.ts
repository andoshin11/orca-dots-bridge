#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { z } from "zod";
import { mkdir, unlink } from "node:fs/promises";
import {
  bridgeServicePaths,
  defaultCallbackHosts,
  servicePort,
  startBridgeService,
  writePlain,
} from "./events/bridge-service.js";

// The always-on bridge service (status, send, ChatGPT settings and notifications
// behind the one Tunnel), normally started by the LaunchAgent that
// `setup --install-agent` installs. It prints only fixed status words.
const settingsSchema = z
  .object({
    relayPort: z.number().int().min(1024).max(65535).default(8788),
    notificationCallbackHosts: z
      .array(z.string().regex(/^[a-z0-9.-]{1,253}$/))
      .max(16)
      .optional(),
  })
  .passthrough();

const paths = bridgeServicePaths(homedir());
const settings = settingsSchema.parse(
  JSON.parse(await readFile(paths.bridgeSettings, "utf8").catch(() => "{}")),
);
const service = await startBridgeService({
  directory: paths.directory,
  settingsPath: paths.settingsPath,
  port: servicePort,
  relayPort: settings.relayPort,
  callbackHosts: settings.notificationCallbackHosts ?? defaultCallbackHosts,
}).catch(async (error: unknown) => {
  // launchd discards output, so the reason goes to a file `setup doctor` shows (fixed words only).
  const reason =
    error instanceof Error && "code" in error && error.code === "EADDRINUSE"
      ? "port_in_use"
      : error instanceof Error && /^[a-z_]{1,64}$/.test(error.message)
        ? error.message
        : "start_failed";
  await mkdir(paths.directory, { recursive: true, mode: 0o700 }).catch(() => undefined);
  await writePlain(paths.lastError, `${reason}\n`);
  process.stderr.write(`bridge service failed to start: ${reason}\n`);
  process.exit(1);
});
await unlink(paths.lastError).catch(() => undefined);
process.stdout.write("bridge service running\n");
const stop = () =>
  void service.close().finally(() => {
    process.stdout.write("bridge service stopped\n");
    process.exit(0);
  });
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
