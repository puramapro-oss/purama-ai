/** Legacy overage packs only. This does not define PURAMA ONE prices or quotas. */
type RecordValue = Record<string, unknown>;

export interface OverageCreditParameters extends Record<string, unknown> {
  p_user_id: string;
  p_stripe_session_id: string;
  p_stripe_payment_intent_id: string;
  p_stripe_event_id: string;
  p_payment_confirmed_at: string;
  p_payment_amount_total: number;
  p_payment_currency: string;
  p_payment_livemode: boolean;
  p_actions: number;
}

type RecordCredit = (parameters: OverageCreditParameters) => PromiseLike<{
  data: unknown;
  error: { message?: string } | null;
}>;

function object(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue : undefined;
}

function stripeId(value: unknown, prefix: string): value is string {
  return typeof value === 'string' && value.length <= 255
    && new RegExp(`^${prefix}_[A-Za-z0-9_]+$`).test(value);
}

function epochSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value > 0 && value <= 253402300799;
}

/** Call only after Stripe signature verification. No provider/network calls here. */
export async function applyOveragePayment(
  eventValue: unknown,
  actions: number,
  recordCredit: RecordCredit,
): Promise<{ status: 'ignored' | 'awaiting_payment' | 'credited' | 'duplicate'; periodStart?: string }> {
  const event = object(eventValue);
  if (!event || !['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(String(event.type))) {
    return { status: 'ignored' };
  }
  const session = object(object(event.data)?.object);
  const metadata = object(session?.metadata);
  if (session?.mode !== 'payment' || metadata?.type !== 'overage_pack') return { status: 'ignored' };

  // A completed Checkout can still be unpaid with delayed payment methods.
  // No free/promotion credit is inferred from no_payment_required.
  if (session.payment_status !== 'paid') {
    if (event.type === 'checkout.session.completed') return { status: 'awaiting_payment' };
    throw new Error('overage_payment_not_confirmed');
  }

  const userId = metadata.user_id;
  const intentId = typeof session.payment_intent === 'string'
    ? session.payment_intent : object(session.payment_intent)?.id;
  if (session.status !== 'complete'
    || typeof userId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(userId)
    || !stripeId(session.id, 'cs') || !stripeId(intentId, 'pi') || !stripeId(event.id, 'evt')
    || !epochSeconds(event.created) || !epochSeconds(session.created) || event.created < session.created
    || typeof session.amount_total !== 'number' || !Number.isSafeInteger(session.amount_total) || session.amount_total <= 0
    || typeof session.currency !== 'string' || !/^[a-z]{3}$/.test(session.currency)
    || typeof event.livemode !== 'boolean' || session.livemode !== event.livemode
    || !Number.isSafeInteger(actions) || actions <= 0 || actions > 2147483647) {
    throw new Error('overage_payment_evidence_invalid');
  }

  // Preserve the legacy calendar-month contract. The signed successful-event
  // timestamp is stable on redelivery; delivery time must never move a credit.
  // PURAMA ONE's paid subscription periods are a separate existing implementation.
  const confirmedAt = new Date(event.created * 1000).toISOString();
  const periodStart = `${confirmedAt.slice(0, 7)}-01`;
  const { data, error } = await recordCredit({
    p_user_id: userId.toLowerCase(),
    p_stripe_session_id: session.id,
    p_stripe_payment_intent_id: intentId,
    p_stripe_event_id: event.id,
    p_payment_confirmed_at: confirmedAt,
    p_payment_amount_total: session.amount_total,
    p_payment_currency: session.currency,
    p_payment_livemode: event.livemode,
    p_actions: actions,
  });
  if (error) throw new Error(`overage_credit_persistence_failed: ${error.message ?? 'database_error'}`);
  const receipt = object(data);
  if (!receipt || typeof receipt.credited !== 'boolean'
    || typeof receipt.credit_id !== 'string' || !receipt.credit_id
    || receipt.period_start !== periodStart) {
    throw new Error('overage_credit_receipt_invalid');
  }
  return { status: receipt.credited ? 'credited' : 'duplicate', periodStart };
}
