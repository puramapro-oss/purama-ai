/**
 * Provider observations, not a commission ledger or an authorization to pay.
 * Only call this after Stripe has authenticated the original webhook body.
 * Amounts stay in their provider currency's smallest unit. No nominal prices,
 * commission rate, tax assumption or promotion duration is inferred here.
 */
type RecordValue = Record<string, unknown>;

export interface StripeReconciliationEvent {
  version: 1;
  stripe_account_key: string;
  livemode: boolean;
  event_id: string;
  event_type: string;
  event_created: number;
  api_version: string | null;
  object_id: string | null;
  source_facts: RecordValue;
}

const prefixes = [
  "checkout.session.",
  "invoice.",
  "invoice_payment.",
  "charge.",
  "refund.",
  "credit_note.",
  "customer.subscription.",
];

const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : {};

const text = (value: unknown, max = 255): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : null;

function reference(value: unknown): string | null {
  return text(typeof value === "string" ? value : record(value).id);
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

function attributionHints(value: unknown): RecordValue {
  const metadata = record(value);
  // Provider metadata helps reconciliation but never proves entitlement.
  return Object.fromEntries(
    ["user_id", "influencer_id", "referral_code"].flatMap((key) => {
      const value = text(metadata[key]);
      return value === null ? [] : [[key, value]];
    }),
  );
}

function listFacts(
  value: unknown,
  label: string,
  notes: string[],
  project: (item: RecordValue) => RecordValue,
): RecordValue {
  const list = record(value);
  const data = Array.isArray(list.data) ? list.data : [];
  const incomplete = list.has_more === true || data.length > 100;
  if (incomplete) notes.push(`${label}_incomplete`);
  return {
    present: value !== undefined && value !== null,
    has_more: incomplete,
    data: data.slice(0, 100).map((item) => project(record(item))),
  };
}

/** Return null for events that cannot affect this legacy revenue flow. */
export function normalizeStripeReconciliationEvent(
  value: unknown,
): StripeReconciliationEvent | null {
  const event = record(value);
  const eventType = text(event.type);
  if (!eventType || !prefixes.some((prefix) => eventType.startsWith(prefix))) {
    return null;
  }
  const eventId = text(event.id);
  const created = integer(event.created);
  if (
    !eventId?.startsWith("evt_") || created === null || created < 0 ||
    typeof event.livemode !== "boolean"
  ) {
    throw new Error("Invalid authenticated Stripe event envelope");
  }
  const account = event.account === undefined || event.account === null
    ? "platform"
    : text(event.account);
  if (!account) throw new Error("Invalid Stripe account context");

  const object = record(record(event.data).object);
  const notes = ["commission_policy_and_settlement_require_reconciliation"];
  const legacySubscription = reference(object.subscription);
  const parentDetails = record(record(object.parent).subscription_details);
  const basilSubscription = reference(parentDetails.subscription);
  const conflictingSubscription = Boolean(
    legacySubscription && basilSubscription &&
      legacySubscription !== basilSubscription,
  );
  if (conflictingSubscription) {
    notes.push("conflicting_subscription_references");
  }
  if (!reference(object)) notes.push("object_id_missing");

  const money: RecordValue = {};
  for (
    const key of [
      "amount",
      "amount_paid",
      "amount_due",
      "amount_remaining",
      "amount_overpaid",
      "amount_total",
      "amount_subtotal",
      "amount_captured",
      "amount_refunded",
      "amount_shipping",
      "total",
      "subtotal",
      "total_excluding_tax",
      "subtotal_excluding_tax",
      "tax",
      "starting_balance",
      "ending_balance",
      "pre_payment_credit_notes_amount",
      "post_payment_credit_notes_amount",
      "pre_payment_amount",
      "post_payment_amount",
      "out_of_band_amount",
    ]
  ) {
    if (object[key] !== undefined && object[key] !== null) {
      money[key] = integer(object[key]);
      if (money[key] === null) notes.push(`invalid_${key}`);
    }
  }

  const currency = text(object.currency, 3);
  if (object.currency !== undefined && !currency?.match(/^[a-z]{3}$/)) {
    notes.push("invalid_currency");
  }
  const facts: RecordValue = {
    object: text(object.object),
    status: text(object.status),
    currency,
    money,
    customer_id: reference(object.customer),
    subscription_id: conflictingSubscription
      ? null
      : basilSubscription || legacySubscription,
    legacy_subscription_id: legacySubscription,
    parent_subscription_id: basilSubscription,
    invoice_id: object.object === "invoice"
      ? reference(object)
      : reference(object.invoice),
    charge_id: object.object === "charge"
      ? reference(object)
      : reference(object.charge),
    payment_intent_id: reference(object.payment_intent),
    refund_id: object.object === "refund"
      ? reference(object)
      : reference(object.refund),
    billing_reason: text(object.billing_reason),
    checkout_mode: text(object.mode),
    checkout_payment_status: text(object.payment_status),
    checkout_purchase_type: text(record(object.metadata).type),
    checkout_total_details: {
      amount_discount: integer(record(object.total_details).amount_discount),
      amount_tax: integer(record(object.total_details).amount_tax),
      amount_shipping: integer(record(object.total_details).amount_shipping),
    },
    paid: typeof object.paid === "boolean" ? object.paid : null,
    paid_out_of_band: typeof object.paid_out_of_band === "boolean"
      ? object.paid_out_of_band
      : null,
    captured: typeof object.captured === "boolean" ? object.captured : null,
    refunded: typeof object.refunded === "boolean" ? object.refunded : null,
    period_start: integer(object.period_start),
    period_end: integer(object.period_end),
    attribution_hints: attributionHints(object.metadata),
    subscription_attribution_hints: attributionHints(
      parentDetails.metadata ?? record(object.subscription_details).metadata,
    ),
    review_reasons: notes,
  };
  facts.lines = listFacts(object.lines, "invoice_lines", notes, (line) => {
    const pricing = record(record(line.pricing).price_details);
    const parent = record(line.parent);
    if (
      Array.isArray(line.discount_amounts) && line.discount_amounts.length > 100
    ) notes.push("invoice_line_discounts_incomplete");
    if (Array.isArray(line.tax_amounts) && line.tax_amounts.length > 100) {
      notes.push("invoice_line_taxes_incomplete");
    }
    return {
      id: reference(line),
      amount: integer(line.amount),
      amount_excluding_tax: integer(line.amount_excluding_tax),
      currency: text(line.currency, 3),
      price_id: reference(pricing.price) || reference(line.price),
      subscription_id:
        reference(record(parent.subscription_item_details).subscription) ||
        reference(line.subscription),
      subscription_item_id:
        reference(record(parent.subscription_item_details).subscription_item) ||
        reference(line.subscription_item),
      period_start: integer(record(line.period).start),
      period_end: integer(record(line.period).end),
      quantity: integer(line.quantity),
      discount_amounts: Array.isArray(line.discount_amounts)
        ? line.discount_amounts.slice(0, 100).map((discount) => ({
          amount: integer(record(discount).amount),
        }))
        : [],
      tax_amounts: Array.isArray(line.tax_amounts)
        ? line.tax_amounts.slice(0, 100).map((tax) => ({
          amount: integer(record(tax).amount),
        }))
        : [],
    };
  });
  facts.payments = listFacts(
    object.payments,
    "invoice_payments",
    notes,
    (payment) => ({
      id: reference(payment),
      status: text(payment.status),
      amount_paid: integer(payment.amount_paid),
      currency: text(payment.currency, 3),
      payment_type: text(record(payment.payment).type),
      payment_intent_id: reference(record(payment.payment).payment_intent),
      charge_id: reference(record(payment.payment).charge),
    }),
  );
  facts.refunds = listFacts(
    object.refunds,
    "charge_refunds",
    notes,
    (refund) => ({
      id: reference(refund),
      status: text(refund.status),
      amount: integer(refund.amount),
      currency: text(refund.currency, 3),
      charge_id: reference(refund.charge),
      payment_intent_id: reference(refund.payment_intent),
    }),
  );

  return {
    version: 1,
    stripe_account_key: account,
    livemode: event.livemode,
    event_id: eventId,
    event_type: eventType,
    event_created: created,
    api_version: text(event.api_version),
    object_id: reference(object),
    source_facts: facts,
  };
}

export interface ReconciliationReceipt {
  event_id: string;
  duplicate: boolean;
  reconciliation: "required";
}

interface ReconciliationStore {
  rpc(
    name: string,
    args: RecordValue,
  ): PromiseLike<{ data: unknown; error: unknown }>;
}

/** Acknowledgement is allowed only after the database confirms a durable row. */
export async function persistStripeReconciliationEvent(
  store: ReconciliationStore,
  event: StripeReconciliationEvent,
): Promise<ReconciliationReceipt> {
  const { data, error } = await store.rpc(
    "record_stripe_reconciliation_event",
    { p_event: event },
  );
  const receipt = record(data);
  if (
    error || receipt.recorded !== true || receipt.event_id !== event.event_id ||
    typeof receipt.duplicate !== "boolean" ||
    receipt.reconciliation !== "required"
  ) {
    throw new Error("Stripe reconciliation event was not durably recorded");
  }
  return {
    event_id: event.event_id,
    duplicate: receipt.duplicate,
    reconciliation: "required",
  };
}
