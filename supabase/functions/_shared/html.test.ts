import assert from "node:assert/strict";
import test from "node:test";

import { escapeHtml } from "./html.ts";

test("escapeHtml neutralizes HTML markup and quoted attributes", () => {
  assert.equal(
    escapeHtml('<img src=x onerror="alert(1)"> & \'quoted\''),
    "&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;quoted&#39;",
  );
});

test("escapeHtml handles nullish and scalar values", () => {
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(42), "42");
});
