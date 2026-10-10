import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// Builds dist once before any test file runs. Rebuilding inside a test file
// replaced hashed chunks while other files were spawning dist/*.mjs.
export default function buildOnce() {
  execFileSync(resolve("node_modules/.bin/vp"), ["pack"], { stdio: "pipe" });
  // Same output as `npm run build`, so a test run leaves a complete dist behind.
  execFileSync(process.execPath, ["scripts/bundled-licenses.mjs"], { stdio: "pipe" });
}
