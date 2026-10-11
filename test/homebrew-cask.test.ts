import { expect, it } from "vite-plus/test";
// @ts-expect-error -- plain .mjs script without types
import { renderCask } from "../scripts/homebrew-cask.mjs";

const arm = "a".repeat(64);
const x64 = "b".repeat(64);
const sums = `${"c".repeat(64)}  orca-dots-bridge-1.2.3.tar.gz
${arm}  Orca-Dots-Bridge-1.2.3-mac-arm64.zip
${x64}  Orca-Dots-Bridge-1.2.3-mac-x64.zip
`;

it("renders the cask with the version and per-arch checksums", () => {
  const cask = renderCask("1.2.3", sums);
  expect(cask).toContain('version "1.2.3"');
  expect(cask).toContain(`arm:   "${arm}"`);
  expect(cask).toContain(`intel: "${x64}"`);
  expect(cask).toContain('app "Orca Dots Bridge-darwin-#{arch}/Orca Dots Bridge.app"');
  // Upgrades run uninstall; only zap may stop the services.
  expect(cask).not.toMatch(/^\s*uninstall /m);
});

it("refuses a missing checksum or a malformed version", () => {
  expect(() => renderCask("1.2.4", sums)).toThrow(/no checksum/);
  expect(() => renderCask("1.2", sums)).toThrow(/invalid version/);
});
