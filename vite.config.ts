import { defineConfig } from "vite-plus";
export default defineConfig({
  lint: { options: { typeAware: true, typeCheck: true } },
  fmt: { printWidth: 100 },
  run: {
    tasks: {
      "verify-all": { command: ["vp check", "tsc --noEmit", "vp pack", "vp test"], cache: false },
    },
  },
  pack: {
    entry: [
      "src/cli.ts",
      "src/mcp.ts",
      "src/mcp2.ts",
      "src/mcp-events.ts",
      "src/notification-trial.ts",
      "src/notification-two-phase.ts",
      "src/notification-preflight.ts",
      "src/notification-approval-check.ts",
      "src/relay-key-setup.ts",
      "src/setup.ts",
      "src/trial-key-setup.ts",
    ],
    format: ["esm"],
    platform: "node",
    target: "node22",
    dts: false,
    sourcemap: true,
  },
  test: { include: ["test/**/*.test.ts"], testTimeout: 10000 },
});
