import { expect, test, type Page } from "@playwright/test";
import type {} from "./harness";

async function open(page: Page, strict = false) {
  await page.goto(strict ? "/?strict" : "/");
  await expect.poll(() => page.evaluate(() => window.mobileAuth?.listenerCount() ?? 0)).toBe(1);
}

async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function queries(page: Page, count: number) {
  await expect.poll(() => page.evaluate(() => window.mobileAuth.queryCount())).toBe(count);
}

async function bootA(page: Page) {
  await open(page);
  await page.evaluate(() => window.mobileAuth.resolveSnapshot("A"));
  await queries(page, 1);
  await page.evaluate(() => window.mobileAuth.resolveProfile(0, "A-current"));
  await expect(page.getByTestId("label")).toHaveText("A-current");
}

test.beforeEach(async ({ page }) => {
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:4199") return route.continue();
    throw new Error(`Unexpected real transport in mobile auth fixture: ${url.origin}`);
  });
});

test("initial session and its profile remain available", async ({ page }) => {
  await bootA(page);
  await expect(page.getByTestId("user")).toHaveText("A");
  await expect(page.getByTestId("session")).toHaveText("A");
  await expect(page.getByTestId("profile")).toHaveText("A");
  await expect(page.getByTestId("loading")).toHaveText("false");
});

test("new auth event wins over an older startup session snapshot", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.mobileAuth.emit("B"));
  await queries(page, 1);
  await page.evaluate(() => window.mobileAuth.resolveProfile(0, "B-current"));
  await expect(page.getByTestId("user")).toHaveText("B");
  await page.evaluate(() => window.mobileAuth.resolveSnapshot("A"));
  await settle(page);
  await expect(page.getByTestId("user")).toHaveText("B");
  await expect(page.getByTestId("session")).toHaveText("B");
  await expect(page.getByTestId("label")).toHaveText("B-current");
  expect(await page.evaluate(() => window.mobileAuth.queryUsers())).toEqual(["B"]);
});

test("signed-out event invalidates an older startup snapshot", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.mobileAuth.emit(null));
  await page.evaluate(() => window.mobileAuth.resolveSnapshot("A"));
  await settle(page);
  await expect(page.getByTestId("user")).toHaveText("none");
  await expect(page.getByTestId("profile")).toHaveText("none");
  await expect(page.getByTestId("loading")).toHaveText("false");
  expect(await page.evaluate(() => window.mobileAuth.queryCount())).toBe(0);
});

test("startup session rejection releases loading without an unhandled rejection", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page);
  await page.evaluate(() => window.mobileAuth.rejectSnapshot());
  await expect(page.getByTestId("loading")).toHaveText("false");
  await expect(page.getByTestId("user")).toHaveText("none");
  expect(errors).toEqual([]);
});

test("failed old snapshot cannot erase a newer authenticated user", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page);
  await page.evaluate(() => window.mobileAuth.emit("B"));
  await queries(page, 1);
  await page.evaluate(() => window.mobileAuth.resolveProfile(0, "B-current"));
  await page.evaluate(() => window.mobileAuth.rejectSnapshot());
  await settle(page);
  await expect(page.getByTestId("user")).toHaveText("B");
  await expect(page.getByTestId("loading")).toHaveText("false");
  expect(errors).toEqual([]);
});

test("late profile for A cannot replace B's resolved profile", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.mobileAuth.resolveSnapshot("A"));
  await queries(page, 1);
  await page.evaluate(() => window.mobileAuth.emit("B"));
  await queries(page, 2);
  await page.evaluate(() => window.mobileAuth.resolveProfile(1, "B-current"));
  await expect(page.getByTestId("label")).toHaveText("B-current");
  await page.evaluate(() => window.mobileAuth.resolveProfile(0, "A-late"));
  await settle(page);
  await expect(page.getByTestId("profile")).toHaveText("B");
  await expect(page.getByTestId("label")).toHaveText("B-current");
});

test("switching users immediately clears the previously displayed profile", async ({ page }) => {
  await bootA(page);
  await page.evaluate(() => window.mobileAuth.emit("B"));
  await expect(page.getByTestId("user")).toHaveText("B");
  await expect(page.getByTestId("profile")).toHaveText("none");
  expect(await page.evaluate(() => window.mobileAuth.renders().some((state) => state.user === "B" && state.profile === "A"))).toBe(false);
});

test("late profile cannot reappear after a signed-out event", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.mobileAuth.resolveSnapshot("A"));
  await queries(page, 1);
  await page.evaluate(() => window.mobileAuth.emit(null));
  await page.evaluate(() => window.mobileAuth.resolveProfile(0, "A-late"));
  await settle(page);
  await expect(page.getByTestId("user")).toHaveText("none");
  await expect(page.getByTestId("profile")).toHaveText("none");
});

test("explicit sign-out invalidates profile reads before transport completes", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.mobileAuth.resolveSnapshot("A"));
  await queries(page, 1);
  await page.evaluate(() => window.mobileAuth.signOut());
  await expect.poll(() => page.evaluate(() => window.mobileAuth.signOutCount())).toBe(1);
  await page.evaluate(() => window.mobileAuth.resolveProfile(0, "A-late"));
  await settle(page);
  await expect(page.getByTestId("user")).toHaveText("none");
  await expect(page.getByTestId("profile")).toHaveText("none");
  await page.evaluate(() => window.mobileAuth.resolveSignOut());
});

test("old sign-out completion cannot erase a subsequent sign-in", async ({ page }) => {
  await bootA(page);
  await page.evaluate(() => window.mobileAuth.signOut());
  await page.evaluate(() => window.mobileAuth.emit("B"));
  await queries(page, 2);
  await page.evaluate(() => window.mobileAuth.resolveProfile(1, "B-current"));
  await expect(page.getByTestId("label")).toHaveText("B-current");
  await page.evaluate(() => window.mobileAuth.resolveSignOut());
  await settle(page);
  await expect(page.getByTestId("user")).toHaveText("B");
  await expect(page.getByTestId("profile")).toHaveText("B");
});

test("refresh started for A is invalid after switching to B", async ({ page }) => {
  await bootA(page);
  await page.evaluate(() => window.mobileAuth.refresh());
  await queries(page, 2);
  await page.evaluate(() => window.mobileAuth.emit("B"));
  await queries(page, 3);
  await page.evaluate(() => window.mobileAuth.resolveProfile(2, "B-current"));
  await expect(page.getByTestId("label")).toHaveText("B-current");
  await page.evaluate(() => window.mobileAuth.resolveProfile(1, "A-refreshed-late"));
  await settle(page);
  await expect(page.getByTestId("label")).toHaveText("B-current");
});

test("refresh started for A is invalid after sign-out", async ({ page }) => {
  await bootA(page);
  await page.evaluate(() => window.mobileAuth.refresh());
  await queries(page, 2);
  await page.evaluate(() => window.mobileAuth.emit(null));
  await page.evaluate(() => window.mobileAuth.resolveProfile(1, "A-refreshed-late"));
  await settle(page);
  await expect(page.getByTestId("profile")).toHaveText("none");
});

test("latest refresh wins when responses for one user arrive out of order", async ({ page }) => {
  await bootA(page);
  await page.evaluate(() => { window.mobileAuth.refresh(); window.mobileAuth.refresh(); });
  await queries(page, 3);
  await page.evaluate(() => window.mobileAuth.resolveProfile(2, "A-newest"));
  await expect(page.getByTestId("label")).toHaveText("A-newest");
  await page.evaluate(() => window.mobileAuth.resolveProfile(1, "A-old-refresh"));
  await settle(page);
  await expect(page.getByTestId("label")).toHaveText("A-newest");
});

test("returning to A does not make a pre-switch A request current again", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.mobileAuth.resolveSnapshot("A"));
  await queries(page, 1);
  await page.evaluate(() => window.mobileAuth.emit("B"));
  await queries(page, 2);
  await page.evaluate(() => window.mobileAuth.emit("A"));
  await queries(page, 3);
  await page.evaluate(() => window.mobileAuth.resolveProfile(2, "A-new-session"));
  await expect(page.getByTestId("label")).toHaveText("A-new-session");
  await page.evaluate(() => { window.mobileAuth.resolveProfile(0, "A-old-session"); window.mobileAuth.resolveProfile(1, "B-late"); });
  await settle(page);
  await expect(page.getByTestId("user")).toHaveText("A");
  await expect(page.getByTestId("label")).toHaveText("A-new-session");
});

test("auth callback stays synchronous and releases the Supabase lock before profile work", async ({ page }) => {
  await open(page);
  const callback = await page.evaluate(() => window.mobileAuth.emit("A", true));
  expect(callback.returns).toEqual(["undefined"]);
  expect(callback.callsInsideCallback).toBe(0);
  await queries(page, 1);
  expect(await page.evaluate(() => window.mobileAuth.stats())).toEqual({ heldLocks: 0, callsInsideCallback: 0, callsWhileLocked: 0 });
  await expect(page.getByTestId("loading")).toHaveText("false");
  await page.evaluate(() => window.mobileAuth.resolveProfile(0, "A-after-lock"));
  await expect(page.getByTestId("label")).toHaveText("A-after-lock");
});

test("unmount unsubscribes and prevents pending session reads from starting profile work", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.mobileAuth.unmount());
  expect(await page.evaluate(() => window.mobileAuth.listenerCount())).toBe(0);
  await page.evaluate(() => window.mobileAuth.resolveSnapshot("A"));
  await settle(page);
  expect(await page.evaluate(() => window.mobileAuth.queryCount())).toBe(0);
});

test("StrictMode cleanup rejects the discarded mount's snapshot", async ({ page }) => {
  await open(page, true);
  await expect.poll(() => page.evaluate(() => window.mobileAuth.snapshotCount())).toBe(2);
  await page.evaluate(() => window.mobileAuth.resolveSnapshot("A", 0));
  await settle(page);
  expect(await page.evaluate(() => window.mobileAuth.queryCount())).toBe(0);
  await page.evaluate(() => window.mobileAuth.resolveSnapshot("B", 1));
  await queries(page, 1);
  await page.evaluate(() => window.mobileAuth.resolveProfile(0, "B-current"));
  await expect(page.getByTestId("user")).toHaveText("B");
});

test("current profile failure clears stale profile data", async ({ page }) => {
  await bootA(page);
  await page.evaluate(() => window.mobileAuth.refresh());
  await queries(page, 2);
  await page.evaluate(() => window.mobileAuth.rejectProfile(1));
  await expect(page.getByTestId("profile")).toHaveText("none");
  await expect(page.getByTestId("loading")).toHaveText("false");
});

test("profile payload for a different owner is rejected", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.mobileAuth.resolveSnapshot("A"));
  await queries(page, 1);
  await page.evaluate(() => window.mobileAuth.resolveProfile(0, "wrong-owner", "B"));
  await settle(page);
  await expect(page.getByTestId("profile")).toHaveText("none");
});

test("a saved refresh callback uses the current identity", async ({ page }) => {
  await bootA(page);
  await page.evaluate(() => window.mobileAuth.saveRefresh());
  await page.evaluate(() => window.mobileAuth.emit("B"));
  await queries(page, 2);
  await page.evaluate(() => window.mobileAuth.resolveProfile(1, "B-current"));
  await expect(page.getByTestId("label")).toHaveText("B-current");
  await page.evaluate(() => window.mobileAuth.savedRefresh());
  await queries(page, 3);
  expect(await page.evaluate(() => window.mobileAuth.queryUsers())).toEqual(["A", "B", "B"]);
});
