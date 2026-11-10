import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 12_000,
  expect: { timeout: 2_000 },
  outputDir: "results",
  reporter: [["line"], ["json", { outputFile: process.env.MOBILE_AUTH_RESULTS ?? "tests/mobile-auth/results/report.json" }]],
  use: {
    baseURL: "http://127.0.0.1:4199",
    browserName: "chromium",
    headless: true,
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--disable-gpu"],
    },
  },
  webServer: {
    command: "node node_modules/vite/bin/vite.js --configLoader runner --config tests/mobile-auth/vite.config.ts",
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
    url: "http://127.0.0.1:4199",
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
