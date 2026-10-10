// Writes dist/THIRD_PARTY_LICENSES.md for the packages bundled into dist/*.mjs.
// The bundled set is read from the source maps, so it lists exactly what ships.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist");
const packages = new Map();
for (const name of await readdir(dist)) {
  if (!name.endsWith(".map")) continue;
  const { sources } = JSON.parse(await readFile(join(dist, name), "utf8"));
  for (const source of sources) {
    const match = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(source);
    if (!match) continue;
    // The package root is the last node_modules segment, which handles nesting.
    const index = source.lastIndexOf(`node_modules/${match[1]}`);
    const dir = resolve(dist, source.slice(0, index + `node_modules/${match[1]}`.length));
    packages.set(dir, match[1]);
  }
}

const licenseFile = async (dir) => {
  const names = await readdir(dir);
  const found = names.find((n) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(n));
  return found ? (await readFile(join(dir, found), "utf8")).trim() : undefined;
};

const sections = [];
for (const [dir, name] of [...packages].sort((a, b) => a[1].localeCompare(b[1]))) {
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  const text = await licenseFile(dir);
  if (!text) throw new Error(`no license file for bundled package ${name}`);
  // Apache-2.0 requires carrying a NOTICE file when the package has one.
  const notice = (await readdir(dir)).find((n) => /^notice(\.(md|txt))?$/i.test(n));
  const noticeText = notice
    ? `\n\nNOTICE:\n\n${(await readFile(join(dir, notice), "utf8")).trim()}`
    : "";
  sections.push(
    `## ${pkg.name} ${pkg.version} (${pkg.license})\n\n\`\`\`text\n${text}${noticeText}\n\`\`\`\n`,
  );
}
await writeFile(
  join(dist, "THIRD_PARTY_LICENSES.md"),
  `# Third-party licenses\n\nPackages bundled into this build of orca-dots-bridge, with their license texts.\n\n${sections.join("\n")}`,
);
process.stdout.write(`dist/THIRD_PARTY_LICENSES.md: ${sections.length} packages\n`);
