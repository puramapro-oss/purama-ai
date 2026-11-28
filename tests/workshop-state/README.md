# Atelier browser checks

These tests render the real Workshop page, React router, CSS and API response validator.
Only authentication and transport are replaced by explicit fixtures. They do not prove a live AI run.

Run from repository root:

    PLAYWRIGHT_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node_modules/.bin/playwright test --config tests/workshop-state/playwright.config.ts

Omit PLAYWRIGHT_EXECUTABLE_PATH when the bundled browser is installed.
A private test server listens on 127.0.0.1:4198 and is stopped by Playwright.
