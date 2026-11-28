import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./src/test/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    // The big page tests (leads drawer, leads page, dashboard) take up to ~3 s each on a normal full run and several
    // times longer when the machine is busy; the 5 s default then failed a passing test on time alone (2026-11-28).
    // A test that really hangs still fails, after 30 s. Don't give a test its own lower limit.
    testTimeout: 30_000,
    // Also the time each test process gets to shut down; under the same load the 10 s default crashed a run whose
    // tests had all finished ("Failed to terminate worker").
    teardownTimeout: 30_000,
  },
});
