import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { packager } from "@electron/packager";

// Builds an unsigned "Orca Dots Bridge.app".
//   npm run package            for this Mac: the app uses the bridge checkout it was
//                              built from, so the checkout must stay in place.
//   npm run package -- --bundle  for a release: the built bridge (dist/) is copied into
//                              the app, so it needs neither the checkout nor Node.
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bridgeDir = resolve(appDir, "..");
const bundle = process.argv.includes("--bundle");
const location = join(appDir, "bridge-location.json");
const staging = join(appDir, "out", "bridge");

async function stageBridge() {
  await rm(staging, { recursive: true, force: true });
  await mkdir(join(staging, "dist"), { recursive: true });
  // dist is self-contained (dependencies are bundled); source maps stay out of the app.
  for (const name of await readdir(join(bridgeDir, "dist")))
    if (name.endsWith(".mjs") || name === "THIRD_PARTY_LICENSES.md")
      await cp(join(bridgeDir, "dist", name), join(staging, "dist", name));
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"])
    await cp(join(bridgeDir, name), join(staging, name));
}

const version =
  process.env.RELEASE_VERSION ??
  JSON.parse(await readFile(join(bridgeDir, "package.json"), "utf8")).version;
if (bundle) await stageBridge();
else await writeFile(location, `${JSON.stringify({ bridgeDir })}\n`);
try {
  const [output] = await packager({
    dir: appDir,
    out: join(appDir, "out"),
    overwrite: true,
    platform: "darwin",
    arch: process.env.RELEASE_ARCH ?? process.arch,
    name: "Orca Dots Bridge",
    appVersion: version,
    appBundleId: "dev.orca-dots-bridge.app",
    extendInfo: { LSUIElement: true },
    ...(bundle ? { extraResource: [staging] } : {}),
    // The app has no runtime dependencies; Electron itself is the runtime.
    ignore: [/^\/out($|\/)/, /^\/scripts($|\/)/, /^\/node_modules($|\/)/, /\.d\.mts$/],
    prune: true,
  });
  // Renaming Electron leaves its ad-hoc signature without resources, which macOS
  // reports as "damaged" for downloaded copies. Re-sign the whole bundle ad hoc;
  // it is still unsigned by a developer, so Gatekeeper asks the user once.
  execFileSync("/usr/bin/codesign", [
    "--force",
    "--deep",
    "--sign",
    "-",
    join(output, "Orca Dots Bridge.app"),
  ]);
  process.stdout.write(`Built ${output}${bundle ? " (bridge bundled)" : ""}\n`);
} finally {
  await rm(location, { force: true });
}
