import { defineConfig } from "@playwright/test";

// Only the live smoke suite lives under e2e/. It targets a deployed site, so there is no webServer.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  workers: 2,
  reporter: [["list"]],
  use: {
    baseURL: process.env.BASE_URL || "https://nightshift-ai.studio",
    trace: "off",
  },
});
