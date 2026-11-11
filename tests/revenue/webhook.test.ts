import { handler } from "./serve-fixture.ts";
import { OTHER_USER_ID, PARTNER_USER_ID, PLAN_PRICE, reset, sign, state, USER_ID } from "./provider-fixture.ts";
import { normalizeStripeReconciliationEvent } from "../../supabase/functions/_shared/stripe-reconciliation.ts";

await import("../../supabase/functions/stripe-webhook/index.ts");
const webhook = handler();
await import("../../supabase/functions/create-checkout/index.ts");
const checkout = handler();

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
function setup() {
  reset();
  Deno.env.set("STRIPE_SECRET_KEY", "sk_test_fixture_only");
  Deno.env.set("STRIPE_WEBHOOK_SECRET", "whsec_revenue_test_only");
  Deno.env.set("SUPABASE_URL", "https://database.example.test");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service_test_only");
  Deno.env.set("SUPABASE_ANON_KEY", "anon_test_only");
  Deno.env.set("PURAMA_BILLING_ORIGIN", "https://purama-ai.purama.dev");
}
function event(type: string, object: Record<string, unknown>, id = "evt_one") {
  return {
    id,
    object: "event",
    type,
    api_version: "2025-08-27.basil",
    created: 1794254400,
    livemode: false,
    data: { object },
  };
}
function invoice(id = "in_first", reason = "subscription_create", paid = 9950) {
  return {
    id,
    object: "invoice",
    status: "paid",
    billing_reason: reason,
    customer: "cus_a",
    currency: "eur",
    amount_paid: paid,
    amount_due: paid,
    amount_remaining: 0,
    total: paid,
    total_excluding_tax: 8292,
    parent: {
      type: "subscription_details",
      subscription_details: {
        subscription: "sub_a",
        metadata: { user_id: USER_ID, influencer_id: "partner_a" },
      },
    },
    lines: {
      data: [{
        id: `il_${id}`,
        amount: paid,
        pricing: { price_details: { price: "price_a" } },
        period: { start: 1794254400, end: 1796846400 },
      }],
      has_more: false,
    },
    payments: {
      data: [{
        id: `ip_${id}`,
        status: "paid",
        amount_paid: paid,
        payment: { type: "payment_intent", payment_intent: "pi_a" },
      }],
      has_more: false,
    },
  };
}
function packSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "cs_pack",
    object: "checkout.session",
    mode: "payment",
    status: "complete",
    created: 1794254000,
    livemode: false,
    payment_status: "paid",
    payment_intent: "pi_pack",
    amount_total: 1900,
    currency: "eur",
    metadata: {
      user_id: "00000000-0000-4000-8000-000000000001",
      type: "overage_pack",
    },
    ...overrides,
  };
}
async function deliver(value: unknown, changePayload = false) {
  const payload = JSON.stringify(value);
  return await webhook(
    new Request("https://edge.example.test/stripe-webhook", {
      method: "POST",
      headers: {
        "stripe-signature": await sign(payload),
        "content-type": "application/json",
      },
      body: changePayload ? payload.replace("9950", "9999") : payload,
    }),
  );
}
function onlyEvent() {
  assert(state.events.size === 1);
  return [...state.events.values()][0];
}

Deno.test("real Stripe signature rejects altered body before any observation or mutation", async () => {
  setup();
  const response = await deliver(
    event("invoice.payment_succeeded", invoice()),
    true,
  );
  equal(response.status, 400);
  equal(state.rpcCalls, 0);
  equal(state.writes, []);
});

Deno.test("missing signature and unsupported method cannot create financial evidence", async () => {
  setup();
  equal(
    (await webhook(
      new Request("https://edge.example.test", { method: "POST", body: "{}" }),
    )).status,
    400,
  );
  equal((await webhook(new Request("https://edge.example.test"))).status, 405);
  equal(state.rpcCalls, 0);
});

for (
  const missing of [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]
) {
  Deno.test(`missing ${missing} prevents acknowledgement`, async () => {
    setup();
    Deno.env.delete(missing);
    equal((await deliver(event("invoice.paid", invoice()))).status, 503);
    equal(state.rpcCalls, 0);
  });
}

Deno.test("database failure is non-2xx and retry durably records the same invoice", async () => {
  setup();
  state.rpcFailure = true;
  const value = event("invoice.payment_succeeded", invoice());
  equal((await deliver(value)).status, 503);
  equal(state.events.size, 0);
  state.rpcFailure = false;
  equal((await deliver(value)).status, 200);
  equal(onlyEvent().source_facts.invoice_id, "in_first");
  equal(state.writes, []);
});

Deno.test("empty or malformed database receipt is not treated as durable success", async () => {
  setup();
  state.invalidReceipt = true;
  equal((await deliver(event("invoice.paid", invoice()))).status, 503);
  equal(state.events.size, 0);
});

Deno.test("first discounted invoice and two renewals remain separate provider facts with no annual entitlement", async () => {
  setup();
  for (let i = 0; i < 3; i++) {
    const response = await deliver(
      event(
        "invoice.payment_succeeded",
        invoice(
          `in_${i}`,
          i ? "subscription_cycle" : "subscription_create",
          i ? 19900 : 9950,
        ),
        `evt_${i}`,
      ),
    );
    equal(response.status, 200);
    equal((await response.json()).reconciliation, "required");
  }
  equal(state.events.size, 3);
  equal(
    [...state.events.values()].map((row) => row.source_facts.money),
    [9950, 19900, 19900].map((paid) => ({
      amount_paid: paid,
      amount_due: paid,
      amount_remaining: 0,
      total: paid,
      total_excluding_tax: 8292,
    })),
  );
  equal(state.writes, []);
});

Deno.test("same event is idempotent, distinct events for one invoice remain observations not two rights", async () => {
  setup();
  const value = event("invoice.payment_succeeded", invoice());
  equal((await deliver(value)).status, 200);
  equal((await (await deliver(value)).json()).duplicate, true);
  equal(state.events.size, 1);
  equal(
    (await deliver(event("invoice.paid", invoice(), "evt_other"))).status,
    200,
  );
  equal(state.events.size, 2);
  equal(state.writes, []);
});

Deno.test("one event id may occur in distinct connected account and live/test contexts", async () => {
  setup();
  const value = event("invoice.paid", invoice());
  for (
    const context of [{ account: "acct_a", livemode: false }, {
      account: "acct_b",
      livemode: false,
    }, { account: "acct_a", livemode: true }]
  ) {
    equal((await deliver({ ...value, ...context })).status, 200);
  }
  equal(state.events.size, 3);
});

Deno.test("conflicting replay fails without overwriting original financial evidence", async () => {
  setup();
  await deliver(event("invoice.paid", invoice()));
  equal(
    (await deliver(
      event("invoice.paid", invoice("in_first", "subscription_create", 9999)),
    )).status,
    503,
  );
  equal(
    (onlyEvent().source_facts.money as Record<string, unknown>).amount_paid,
    9950,
  );
});

Deno.test("invoice before checkout is retained and trial checkout grants no commission", async () => {
  setup();
  await deliver(
    event(
      "invoice.payment_succeeded",
      invoice("in_trial", "subscription_create", 0),
    ),
  );
  const response = await deliver(event("checkout.session.completed", {
    id: "cs_a",
    object: "checkout.session",
    mode: "subscription",
    status: "complete",
    livemode: false,
    subscription: "sub_a",
    customer: "cus_a",
    customer_email: "buyer@example.test",
    payment_status: "no_payment_required",
    amount_total: 0,
    metadata: {
      user_id: USER_ID,
      influencer_id: "partner_a",
      referral_code: "PARTNER",
    },
  }, "evt_checkout"));
  equal(response.status, 200);
  equal(state.events.size, 2);
  assert(state.writes.some((write) => write.table === "subscriptions"));
  assert(state.writes.every((write) => write.table === "subscriptions"));
  equal(state.writes[0].value.status, "trialing");
  equal(state.writes[0].value.plan_type, "pro");
  equal(state.writes[0].value.has_used_trial, true);
  equal(state.writes[0].value.trial_ends_at, new Date(state.subscription.trial_end * 1000).toISOString());
});

Deno.test("partial and full refunds, failed refund, credit note and dispute are retained without cancelling unrelated rights", async () => {
  setup();
  const values = [
    event("charge.refunded", {
      id: "ch_a",
      object: "charge",
      invoice: "in_first",
      currency: "eur",
      amount: 9950,
      amount_refunded: 2500,
      refunded: false,
      refunds: {
        data: [{ id: "re_a", amount: 2500, status: "succeeded" }],
        has_more: false,
      },
    }, "evt_partial"),
    event("charge.refunded", {
      id: "ch_a",
      object: "charge",
      invoice: "in_first",
      currency: "eur",
      amount: 9950,
      amount_refunded: 9950,
      refunded: true,
    }, "evt_full"),
    event("refund.updated", {
      id: "re_b",
      object: "refund",
      charge: "ch_a",
      amount: 1000,
      status: "failed",
      currency: "eur",
    }, "evt_failed_refund"),
    event("credit_note.created", {
      id: "cn_a",
      object: "credit_note",
      invoice: "in_first",
      amount: 2500,
      status: "issued",
      currency: "eur",
    }, "evt_credit"),
    event("charge.dispute.created", {
      id: "dp_a",
      object: "dispute",
      charge: "ch_a",
      amount: 9950,
      status: "needs_response",
      currency: "eur",
    }, "evt_dispute"),
  ];
  for (const value of values) equal((await deliver(value)).status, 200);
  equal(state.events.size, 5);
  const facts = [...state.events.values()].map((row) => row.source_facts);
  equal((facts[0].money as Record<string, unknown>).amount_refunded, 2500);
  equal((facts[1].money as Record<string, unknown>).amount_refunded, 9950);
  equal(facts[2].status, "failed");
  equal(state.writes, []);
});

Deno.test("overage pack waits for actual paid status and accepts asynchronous success", async () => {
  setup();
  const session = packSession({ payment_status: "unpaid" });
  await deliver(event("checkout.session.completed", session));
  equal(state.writes, []);
  await deliver(
    event("checkout.session.async_payment_succeeded", {
      ...session,
      payment_status: "paid",
    }, "evt_async"),
  );
  equal(state.writes.length, 1);
  equal(state.writes[0].table, "overage_credits");
  equal(state.writes[0].value.actions, 2000);
});

Deno.test("legacy and Basil subscription references normalize; conflict is retained for review", () => {
  setup();
  for (const subscription of ["sub_a", { id: "sub_a" }]) {
    const result = normalizeStripeReconciliationEvent(
      event("invoice.paid", { id: "in_a", object: "invoice", subscription }),
    );
    equal(result?.source_facts.subscription_id, "sub_a");
  }
  const result = normalizeStripeReconciliationEvent(
    event("invoice.paid", { ...invoice(), subscription: "sub_other" }),
  );
  equal(result?.source_facts.subscription_id, null);
  assert(
    (result?.source_facts.review_reasons as string[]).includes(
      "conflicting_subscription_references",
    ),
  );
});

Deno.test("unknown currencies, invalid amounts and partial lists are not repaired with invented values", () => {
  const result = normalizeStripeReconciliationEvent(
    event("invoice.paid", {
      ...invoice(),
      currency: "EURO",
      amount_paid: "9950",
      lines: { data: [], has_more: true },
    }),
  );
  equal(
    (result?.source_facts.money as Record<string, unknown>).amount_paid,
    null,
  );
  const reasons = result?.source_facts.review_reasons as string[];
  assert(reasons.includes("invalid_currency"));
  assert(reasons.includes("invalid_amount_paid"));
  assert(reasons.includes("invoice_lines_incomplete"));
});

Deno.test("provider evidence omits personal addresses, card data and arbitrary metadata", () => {
  const result = normalizeStripeReconciliationEvent(event("invoice.paid", {
    ...invoice(),
    customer_email: "private@example.test",
    customer_address: { line1: "private street" },
    metadata: { user_id: USER_ID, secret: "do-not-store" },
    payment_method: { card: { number: "4111111111111111" } },
  }));
  const stored = JSON.stringify(result);
  assert(
    !stored.includes("private@example.test") &&
      !stored.includes("private street") && !stored.includes("do-not-store") &&
      !stored.includes("4111111111111111"),
  );
});

Deno.test("checkout copies only server-resolved attribution without a second free trial", async () => {
  setup();
  state.subscriptionList = [];
  state.influencer = {
    id: "partner_a",
    user_id: PARTNER_USER_ID,
    promo_code: "PARTNER",
    expires_at: "2099-01-01T00:00:00Z",
    beneficiary_name: "Partner",
    contract_status: "signed",
  };
  const response = await checkout(
    new Request("https://edge.example.test/create-checkout", {
      method: "POST",
      headers: {
        authorization: "Bearer fixture",
        origin: "https://purama-ai.purama.dev",
      },
      body: JSON.stringify({
        priceId: PLAN_PRICE,
        referralCode: "PARTNER",
        influencer_id: "attacker",
        commission_rate: 100,
      }),
    }),
  );
  equal(response.status, 200);
  const params = state.checkoutRequests[0];
  equal(params.subscription_data?.metadata, {
    user_id: USER_ID,
    referral_code: "PARTNER",
    influencer_id: "partner_a",
  });
  equal(params.subscription_data?.trial_period_days, undefined);
  equal(params.discounts, [{ coupon: "lHDOePig" }]);
  assert(
    !JSON.stringify(params.subscription_data?.metadata).includes("attacker"),
  );
});

Deno.test("self referral is rejected before creating any discounted checkout", async () => {
  setup();
  state.subscriptionList = [];
  state.influencer = {
    id: "partner_a",
    user_id: USER_ID,
    promo_code: "PARTNER",
    expires_at: "2099-01-01T00:00:00Z",
    beneficiary_name: "Partner",
    contract_status: "signed",
  };
  const response = await checkout(
    new Request("https://edge.example.test/create-checkout", {
      method: "POST",
      headers: { authorization: "Bearer fixture" },
      body: JSON.stringify({ priceId: PLAN_PRICE, referralCode: "PARTNER" }),
    }),
  );
  equal(response.status, 400);
  equal(state.checkoutRequests, []);
  equal(state.writes, []);
});

function subscriptionCheckout(overrides: Record<string, unknown> = {}) {
  return event("checkout.session.completed", {
    id: "cs_subscription",
    object: "checkout.session",
    mode: "subscription",
    status: "complete",
    livemode: false,
    subscription: "sub_a",
    customer: "cus_a",
    payment_status: "no_payment_required",
    metadata: { user_id: USER_ID },
    ...overrides,
  });
}

Deno.test("server user attribution works without email and binds an unbound customer", async () => {
  setup();
  state.subscriptionRows[0].stripe_customer_id = null;
  equal((await deliver(subscriptionCheckout())).status, 200);
  equal(state.subscriptionRows[0].stripe_customer_id, "cus_a");
  equal(state.subscriptionRows[0].status, "trialing");
});

Deno.test("legacy checkout without metadata uses only a unique stable customer binding", async () => {
  setup();
  equal((await deliver(subscriptionCheckout({ metadata: {} }))).status, 200);
  equal(state.writes[0].value.status, "trialing");
  setup();
  state.subscriptionRows[0].stripe_customer_id = null;
  equal(
    (await deliver(
      subscriptionCheckout({
        metadata: {},
        customer_email: "buyer@example.test",
      }),
    )).status,
    503,
  );
  equal(state.events.size, 1);
  equal(state.writes, []);
});

Deno.test("conflicting user and customer attribution cannot modify either account", async () => {
  for (const conflict of ["metadata", "customer", "binding", "duplicate"]) {
    setup();
    if (conflict === "metadata") {
      state.subscription.metadata.user_id = OTHER_USER_ID;
    }
    if (conflict === "customer") state.subscription.customer = "cus_other";
    if (conflict === "binding") {
      state.subscriptionRows[0].stripe_customer_id = "cus_other";
    }
    if (conflict === "duplicate") {
      state.subscriptionRows.push({
        ...structuredClone(state.subscriptionRows[0]),
        id: "00000000-0000-4000-8000-000000000102",
        user_id: OTHER_USER_ID,
        stripe_customer_id: "cus_a",
      });
    }
    equal((await deliver(subscriptionCheckout())).status, 503);
    equal(state.events.size, 1);
    equal(state.writes, []);
  }
});

Deno.test("subscription SQL errors and zero-row updates are not acknowledged, retry can apply", async () => {
  for (
    const failure of [
      "subscriptions:select",
      "subscriptions:update",
      "zero_rows",
    ]
  ) {
    setup();
    state.queryFailure = failure;
    state.updateReturnsNoRow = failure === "zero_rows";
    equal((await deliver(subscriptionCheckout())).status, 503);
    equal(state.events.size, 1);
    equal(state.writes, []);
    state.queryFailure = null;
    state.updateReturnsNoRow = false;
    const retry = await deliver(subscriptionCheckout());
    equal(retry.status, 200);
    equal((await retry.json()).duplicate, true);
    equal(state.events.size, 1);
    equal(state.writes[0].value.status, "trialing");
  }
});

Deno.test("unknown products and multiple products never fall back to a paid pro plan", async () => {
  for (const unknown of ["unknown", "multiple", "truncated"]) {
    setup();
    if (unknown === "unknown") {
      state.subscription.items.data[0].price.product = "prod_unmapped";
    }
    if (unknown === "multiple") {
      state.subscription.items.data.push({
        price: { product: "prod_UHwPSU2o4DW6Ej" },
      });
    }
    if (unknown === "truncated") state.subscription.items.has_more = true;
    equal((await deliver(subscriptionCheckout())).status, 503);
    equal(state.events.size, 1);
    equal(state.writes, []);
  }
});

Deno.test("unmapped connected-account and wrong-mode events are durable observations only", async () => {
  for (const context of [{ account: "acct_unmapped" }, { livemode: true }]) {
    setup();
    const response = await deliver({ ...subscriptionCheckout(), ...context });
    equal(response.status, 200);
    equal((await response.json()).application, "deferred");
    equal(state.events.size, 1);
    equal(state.subscriptionRequests, []);
    equal(state.writes, []);
  }
});

Deno.test("delayed subscription events apply the current Stripe status, and real cancellation restores free", async () => {
  setup();
  state.subscription.status = "active";
  equal(
    (await deliver(
      event("customer.subscription.updated", {
        ...state.subscription,
        status: "past_due",
      }),
    )).status,
    200,
  );
  equal(state.writes[0].value.status, "active");
  equal(state.invoiceRequests, ["in_current"]);
  state.subscriptionRows[0].has_used_trial = true;
  state.subscription.status = "canceled";
  equal(
    (await deliver(
      event("customer.subscription.deleted", state.subscription, "evt_cancel"),
    )).status,
    200,
  );
  equal(state.writes[1].value.status, "canceled");
  equal(state.writes[1].value.plan_type, "free");
  equal(state.subscriptionRows[0].has_used_trial, true);
});

Deno.test("failed one-off invoices cannot downgrade a subscription; delayed subscription failure reads current state", async () => {
  setup();
  equal(
    (await deliver(
      event("invoice.payment_failed", {
        id: "in_oneoff",
        object: "invoice",
        customer: "cus_a",
      }),
    )).status,
    200,
  );
  equal(state.writes, []);
  equal(state.subscriptionRequests, []);
  equal(state.events.size, 1);
  state.subscription.status = "active";
  equal(
    (await deliver(
      event("invoice.payment_failed", invoice(), "evt_late_failed"),
    )).status,
    200,
  );
  equal(state.writes[0].value.status, "active");
  equal(state.invoiceRequests, ["in_current"]);
});

Deno.test("an old cancelled subscription cannot downgrade its customer's new open subscription", async () => {
  setup();
  state.subscription.status = "canceled";
  state.subscriptionRows[0].plan_type = "pro";
  state.subscriptionRows[0].has_used_trial = true;
  const before = structuredClone(state.subscriptionRows);
  state.subscriptionList = [
    structuredClone(state.subscription),
    { ...structuredClone(state.subscription), id: "sub_replacement", status: "active" },
  ];
  const response = await deliver(event("customer.subscription.deleted", state.subscription));
  equal(response.status, 503);
  equal(await response.json(), { error: "Webhook processing failed; event not acknowledged" });
  equal(state.events.size, 1);
  equal(state.writes, []);
  equal(state.subscriptionRows, before);
});

Deno.test("incomplete or ambiguous provider lists never select subscription rights", async () => {
  for (const shape of ["paginated", "multiple_open", "target_absent"]) {
    setup();
    state.subscription.status = "active";
    if (shape === "paginated") state.subscriptionListHasMore = true;
    if (shape === "multiple_open") {
      state.subscriptionList = [
        structuredClone(state.subscription),
        { ...structuredClone(state.subscription), id: "sub_other" },
      ];
    }
    if (shape === "target_absent") state.subscriptionList = [];
    equal((await deliver(event("customer.subscription.updated", state.subscription))).status, 503);
    equal(state.events.size, 1);
    equal(state.writes, []);
  }
});

for (const type of ["customer.subscription.updated", "customer.subscription.deleted", "invoice.payment_failed"]) {
  Deno.test(`${type}: current active state still requires the exact paid invoice`, async () => {
    for (const problem of ["missing", "open", "wrong_invoice", "wrong_customer", "provider_failure"]) {
      setup();
      state.subscription.status = "active";
      if (problem === "missing") state.subscription.latest_invoice = null;
      if (problem === "open") state.invoice.status = "open";
      if (problem === "wrong_invoice") state.invoice.id = "in_other";
      if (problem === "wrong_customer") state.invoice.customer = "cus_other";
      if (problem === "provider_failure") state.invoiceFailure = true;
      const object = type.startsWith("invoice.") ? invoice() : state.subscription;
      const response = await deliver(event(type, object));
      equal(response.status, 503);
      equal(await response.json(), { error: "Webhook processing failed; event not acknowledged" });
      equal(state.events.size, 1);
      equal(state.writes, []);
    }
  });
}

Deno.test("a linked failed invoice from another customer cannot alter subscription rights", async () => {
  setup();
  const response = await deliver(event("invoice.payment_failed", { ...invoice(), customer: "cus_other" }));
  equal(response.status, 503);
  equal(state.events.size, 1);
  equal(state.writes, []);
});

Deno.test("conflicting legacy and Basil invoice references remain observations without selecting rights", async () => {
  setup();
  const response = await deliver(event("invoice.payment_failed", { ...invoice(), subscription: "sub_other" }));
  equal(response.status, 200);
  equal(onlyEvent().source_facts.subscription_id, null);
  equal(state.subscriptionRequests, []);
  equal(state.writes, []);
});

Deno.test("journal failure or missing receipt prevents all subscription and pack application", async () => {
  for (const failure of ["unavailable", "receipt"]) {
    for (const value of [subscriptionCheckout(), event("checkout.session.completed", packSession())]) {
      setup();
      state.rpcFailure = failure === "unavailable";
      state.invalidReceipt = failure === "receipt";
      equal((await deliver(value)).status, 503);
      equal(state.subscriptionRequests, []);
      equal(state.customerRequests, []);
      equal(state.writes, []);
      equal(state.overageCredits.size, 0);
    }
  }
});

Deno.test("replayed referred checkout records attribution without annual commissions or repeated entitlement", async () => {
  setup();
  const value = subscriptionCheckout({
    metadata: { user_id: USER_ID, influencer_id: "partner_a", referral_code: "PARTNER" },
  });
  equal((await deliver(value)).status, 200);
  const writes = structuredClone(state.writes);
  equal(writes.length, 1);
  equal(writes[0].table, "subscriptions");
  const repeat = await deliver(value);
  equal(repeat.status, 200);
  equal((await repeat.json()).duplicate, true);
  equal(state.writes.filter((write) => Object.keys(write.value).some((key) => key !== "updated_at")), writes);
  equal(state.writes.length, 2);
  equal(Object.keys(state.writes[1].value), ["updated_at"]);
  equal(onlyEvent().source_facts.attribution_hints, {
    user_id: USER_ID, influencer_id: "partner_a", referral_code: "PARTNER",
  });
  assert(state.operations.indexOf("journal:evt_one") < state.operations.indexOf("write:subscriptions:update"));
});

Deno.test("paid overage failure retries safely and distinct events for one session credit once", async () => {
  setup();
  const session = packSession({ payment_status: "paid" });
  const value = event("checkout.session.completed", session);
  state.overageFailure = true;
  equal((await deliver(value)).status, 503);
  equal(state.events.size, 1);
  equal(state.writes, []);
  state.overageFailure = false;
  equal((await deliver(value)).status, 200);
  equal(
    (await deliver(
      event("checkout.session.async_payment_succeeded", session, "evt_async"),
    )).status,
    200,
  );
  equal((await deliver(value)).status, 200);
  equal(state.overageCredits.size, 1);
  equal(state.writes.length, 1);
});

Deno.test("overage missing user or conflicting earlier beneficiary is not silently acknowledged", async () => {
  for (const conflict of ["missing_user", "earlier_owner"]) {
    setup();
    if (conflict === "earlier_owner") {
      state.overageCredits.set("cs_pack", { user_id: "other", actions: 2000 });
    }
    const metadata = conflict === "missing_user" ? { type: "overage_pack" } : {
      type: "overage_pack",
      user_id: "00000000-0000-4000-8000-000000000001",
    };
    equal(
      (await deliver(
        event("checkout.session.completed", packSession({ metadata })),
      )).status,
      503,
    );
    equal(state.events.size, 1);
    equal(state.writes, []);
  }
});
