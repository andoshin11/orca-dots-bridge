import { rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packager } from "@electron/packager";

// Builds an unsigned "Orca Dots Bridge.app" for this Mac. The app keeps using the
// bridge checkout it was built from, so the checkout must stay in place.
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const location = join(appDir, "bridge-location.json");
await writeFile(location, `${JSON.stringify({ bridgeDir: resolve(appDir, "..") })}\n`);
try {
  const [output] = await packager({
    dir: appDir,
    out: join(appDir, "out"),
    overwrite: true,
    platform: "darwin",
    arch: process.arch,
    name: "Orca Dots Bridge",
    appBundleId: "dev.orca-dots-bridge.app",
    extendInfo: { LSUIElement: true },
    // The app has no runtime dependencies; Electron itself is the runtime.
    ignore: [/^\/out($|\/)/, /^\/scripts($|\/)/, /^\/node_modules($|\/)/, /\.d\.mts$/],
    prune: true,
  });
  process.stdout.write(`Built ${output}\n`);
} finally {
  await rm(location, { force: true });
}
