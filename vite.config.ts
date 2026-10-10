import { defineConfig } from "vite-plus";
export default defineConfig({
  lint: { options: { typeAware: true, typeCheck: true } },
  fmt: { printWidth: 100 },
  run: {
    tasks: {
      "verify-all": {
        command: ["vp check", "tsc --noEmit", "vp test"],
        cache: false,
      },
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
    // Self-contained dist: release archives and the app ship without node_modules.
    deps: { alwaysBundle: [/.*/] },
  },
  // Tests that spawn dist/*.mjs share one build made before any test runs.
  test: { include: ["test/**/*.test.ts"], testTimeout: 10000, globalSetup: ["test/build-once.ts"] },
});
