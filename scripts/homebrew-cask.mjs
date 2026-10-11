// Prints the Homebrew cask for the menu bar app, for the andoshin11/homebrew-tap repo.
// Usage: node scripts/homebrew-cask.mjs <version> <SHA256SUMS path>
import { readFile } from "node:fs/promises";

export function renderCask(version, sums) {
  const sha = (arch) => {
    const name = `Orca-Dots-Bridge-${version}-mac-${arch}.zip`;
    const line = sums.split("\n").find((l) => l.trim().endsWith(`  ${name}`));
    const hash = line?.split(/\s+/)[0];
    if (!hash || !/^[0-9a-f]{64}$/.test(hash)) throw new Error(`no checksum for ${name}`);
    return hash;
  };
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`invalid version ${version}`);
  return `cask "orca-dots-bridge" do
  arch arm: "arm64", intel: "x64"

  version "${version}"
  sha256 arm:   "${sha("arm64")}",
         intel: "${sha("x64")}"

  url "https://github.com/andoshin11/orca-dots-bridge/releases/download/v#{version}/Orca-Dots-Bridge-#{version}-mac-#{arch}.zip"
  name "Orca Dots Bridge"
  desc "Menu bar app connecting local Orca agents to ChatGPT dot"
  homepage "https://github.com/andoshin11/orca-dots-bridge"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: :ventura

  app "Orca Dots Bridge-darwin-#{arch}/Orca Dots Bridge.app"

  # Upgrades must not stop the services: the new app re-points them itself.
  zap launchctl: [
        "dev.orca-dots-bridge.notification-tunnel",
        "dev.orca-dots-bridge.notifications",
        "dev.orca-dots-bridge.status-tunnel",
      ],
      trash:     "~/.orca-dots-bridge"

  caveats <<~EOS
    The app is not notarized by Apple. On first launch macOS shows
    "Orca Dots Bridge" Not Opened: press Done, then open
    System Settings > Privacy & Security and choose Open Anyway.
  EOS
end
`;
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  const [version, sumsPath] = process.argv.slice(2);
  if (!version || !sumsPath) {
    console.error("usage: node scripts/homebrew-cask.mjs <version> <SHA256SUMS>");
    process.exit(2);
  }
  process.stdout.write(renderCask(version, await readFile(sumsPath, "utf8")));
}
