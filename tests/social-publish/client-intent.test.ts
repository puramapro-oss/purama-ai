import { strict as assert } from "node:assert";
import { publicationLabel, readPublicationResult, stablePublicationRequestId } from "../../src/lib/social-publish-request.ts";
import { resolveSocialSchema } from "../../supabase/functions/_shared/social-db.ts";

Deno.test("client: same owner and prepared intent retain a request key across calls and platform ordering", async () => {
  const a = await stablePublicationRequestId({ content: "PURAMA", platforms: ["facebook", "linkedin"] }, "owner");
  const b = await stablePublicationRequestId({ content: "PURAMA", platforms: ["linkedin", "facebook"], mediaUrls: [], contentType: "text", forceCaption: false }, "owner");
  assert.equal(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{16,128}$/);
  assert.notEqual(a, await stablePublicationRequestId({ content: "Changed", platforms: ["facebook", "linkedin"] }, "owner"));
  assert.notEqual(a, await stablePublicationRequestId({ content: "PURAMA", platforms: ["facebook", "linkedin"] }, "other-owner"));
});

Deno.test("client: partial and unconfirmed responses cannot become a success label", () => {
  for (const status of ["partial", "publish_unconfirmed", "failed"] as const) {
    const result = readPublicationResult({ post_id: "post-id", status, success: true });
    assert.equal(result.success, false);
    assert.notEqual(publicationLabel(result.status), "Publication confirmée");
  }
  assert.throws(() => readPublicationResult({ success: true }), /non confirmé/);
});

Deno.test("schema: existing runtime default is preserved and unsupported schema fails closed", () => {
  assert.equal(resolveSocialSchema(), "purama_ai");
  assert.equal(resolveSocialSchema("public"), "public");
  assert.equal(resolveSocialSchema("purama_ai"), "purama_ai");
  assert.throws(() => resolveSocialSchema(""), /SOCIAL_DB_SCHEMA/);
  assert.throws(() => resolveSocialSchema("unexpected"), /SOCIAL_DB_SCHEMA/);
});
