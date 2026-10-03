import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const settings = readFileSync(new URL("../mobile/app/(tabs)/settings.tsx", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../mobile/app/(tabs)/index.tsx", import.meta.url), "utf8");
const agent = readFileSync(new URL("../mobile/app/agent/[slug].tsx", import.meta.url), "utf8");
const actions = readFileSync(new URL("../mobile/lib/mobileActions.ts", import.meta.url), "utf8");
const webRouter = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

test("mobile actions contain no empty press handlers", () => {
  for (const source of [settings, dashboard, agent]) {
    assert.doesNotMatch(source, /onPress=\{\(\) => \{\}\}/);
  }
});

test("every external mobile destination has a canonical web route", () => {
  const routes = [...actions.matchAll(/:\s*"(\/[^"\n]+)"/g)].map((match) => match[1]);
  assert.ok(routes.length > 0);
  for (const route of routes) {
    assert.match(webRouter, new RegExp(`path=["']${route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`));
  }
});

test("unavailable actions expose an accessible state instead of doing nothing", () => {
  assert.match(actions, /Alert\.alert\("Bientôt disponible"/);
  assert.match(settings, /showComingSoon/);
  assert.match(dashboard, /showComingSoon/);
});

test("chat clear uses the real hook action with confirmation", () => {
  assert.match(agent, /clearMessages/);
  assert.match(agent, /Alert\.alert\("Effacer la conversation"/);
  assert.match(agent, /onPress:\s*clearMessages/);
  assert.match(agent, /disabled=\{messages\.length === 0\}/);
});
