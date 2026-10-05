import { defineConfig } from "vite-plus";
export default defineConfig({
  lint: { options: { typeAware: true, typeCheck: true } },
  fmt: { printWidth: 100 },
  run: {
    tasks: {
      "verify-all": { command: ["vp check", "tsc --noEmit", "vp test", "vp pack"], cache: false },
    },
  },
  pack: {
    entry: ["src/cli.ts", "src/mcp.ts"],
    format: ["esm"],
    platform: "node",
    target: "node22",
    dts: false,
    sourcemap: true,
  },
  test: { include: ["test/**/*.test.ts"], testTimeout: 10000 },
});
