-- Server-authoritative rewards and wallet ledger.
-- Additive and replayable: legacy rows are preserved; new writes go through RPCs.

CREATE SCHEMA IF NOT EXISTS purama_ai;

CREATE TABLE IF NOT EXISTS purama_ai.wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  balance NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  total_earned NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total_earned >= 0),
  total_withdrawn NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total_withdrawn >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS purama_ai.wallet_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('credit', 'debit', 'withdrawal')),
  source TEXT NOT NULL,
  description TEXT,
  idempotency_key UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purama_ai.withdrawals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 5),
  iban TEXT NOT NULL,
  beneficiary_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'rejected')),
  idempotency_key UUID,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS purama_ai.purama_points (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  lifetime_earned INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_earned >= 0),
  streak_days INTEGER NOT NULL DEFAULT 0 CHECK (streak_days >= 0),
  last_active_date DATE,
  streak_multiplier NUMERIC(3,1) NOT NULL DEFAULT 1.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS purama_ai.point_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  description TEXT,
  idempotency_key UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purama_ai.point_shop_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  cost_points INTEGER NOT NULL CHECK (cost_points > 0),
  type TEXT NOT NULL CHECK (type IN ('reduction', 'subscription', 'ticket', 'feature', 'cash')),
  value TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purama_ai.point_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES purama_ai.point_shop_items(id),
  points_spent INTEGER NOT NULL CHECK (points_spent > 0),
  idempotency_key UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purama_ai.daily_gifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  gift_type TEXT NOT NULL,
  gift_value TEXT NOT NULL,
  streak_count INTEGER NOT NULL DEFAULT 0 CHECK (streak_count >= 0),
  gift_day DATE NOT NULL DEFAULT ((now() AT TIME ZONE 'UTC')::DATE),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purama_ai.lottery_draws (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draw_date DATE NOT NULL,
  pool_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (pool_amount >= 0),
  status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'live', 'completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purama_ai.lottery_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  draw_id UUID NOT NULL REFERENCES purama_ai.lottery_draws(id),
  source TEXT NOT NULL CHECK (source IN ('inscription', 'parrainage', 'mission', 'partage', 'note', 'challenge', 'streak', 'abo', 'achat_points')),
  idempotency_key UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purama_ai.lottery_winners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draw_id UUID NOT NULL REFERENCES purama_ai.lottery_draws(id),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ticket_id UUID REFERENCES purama_ai.lottery_tickets(id),
  rank INTEGER NOT NULL CHECK (rank > 0),
  amount_won NUMERIC(12,2) NOT NULL CHECK (amount_won >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (draw_id, rank),
  UNIQUE (ticket_id)
);

-- Reconcile installations where the legacy p3_schema.sql was applied manually.
ALTER TABLE purama_ai.wallet_transactions ADD COLUMN IF NOT EXISTS idempotency_key UUID;
ALTER TABLE purama_ai.withdrawals ADD COLUMN IF NOT EXISTS idempotency_key UUID;
ALTER TABLE purama_ai.point_transactions ADD COLUMN IF NOT EXISTS idempotency_key UUID;
ALTER TABLE purama_ai.point_purchases ADD COLUMN IF NOT EXISTS idempotency_key UUID;
ALTER TABLE purama_ai.daily_gifts ADD COLUMN IF NOT EXISTS gift_day DATE;
ALTER TABLE purama_ai.daily_gifts ALTER COLUMN gift_day SET DEFAULT ((now() AT TIME ZONE 'UTC')::DATE);
ALTER TABLE purama_ai.lottery_tickets ADD COLUMN IF NOT EXISTS idempotency_key UUID;

CREATE UNIQUE INDEX IF NOT EXISTS withdrawals_user_idempotency_uidx
  ON purama_ai.withdrawals (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS wallet_tx_user_idempotency_uidx
  ON purama_ai.wallet_transactions (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS point_tx_user_idempotency_uidx
  ON purama_ai.point_transactions (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS point_purchase_user_idempotency_uidx
  ON purama_ai.point_purchases (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS daily_gift_user_day_uidx
  ON purama_ai.daily_gifts (user_id, gift_day) WHERE gift_day IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS lottery_ticket_user_idempotency_uidx
  ON purama_ai.lottery_tickets (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS wallet_tx_user_created_idx ON purama_ai.wallet_transactions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS point_tx_user_created_idx ON purama_ai.point_transactions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS lottery_ticket_user_draw_idx ON purama_ai.lottery_tickets (user_id, draw_id);

ALTER TABLE purama_ai.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.withdrawals ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.purama_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.point_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.point_shop_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.point_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.daily_gifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.lottery_draws ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.lottery_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.lottery_winners ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'purama_ai' AND tablename = 'wallets' AND policyname = 'ledger_wallet_select_own') THEN
    CREATE POLICY ledger_wallet_select_own ON purama_ai.wallets FOR SELECT TO authenticated USING (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'purama_ai' AND tablename = 'wallet_transactions' AND policyname = 'ledger_wallet_tx_select_own') THEN
    CREATE POLICY ledger_wallet_tx_select_own ON purama_ai.wallet_transactions FOR SELECT TO authenticated USING (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'purama_ai' AND tablename = 'withdrawals' AND policyname = 'ledger_withdrawal_select_own') THEN
    CREATE POLICY ledger_withdrawal_select_own ON purama_ai.withdrawals FOR SELECT TO authenticated USING (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'purama_ai' AND tablename = 'purama_points' AND policyname = 'ledger_points_select_own') THEN
    CREATE POLICY ledger_points_select_own ON purama_ai.purama_points FOR SELECT TO authenticated USING (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'purama_ai' AND tablename = 'point_transactions' AND policyname = 'ledger_point_tx_select_own') THEN
    CREATE POLICY ledger_point_tx_select_own ON purama_ai.point_transactions FOR SELECT TO authenticated USING (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'purama_ai' AND tablename = 'point_shop_items' AND policyname = 'ledger_shop_read_active') THEN
    CREATE POLICY ledger_shop_read_active ON purama_ai.point_shop_items FOR SELECT TO authenticated USING (is_active);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'purama_ai' AND tablename = 'point_purchases' AND policyname = 'ledger_purchase_select_own') THEN
    CREATE POLICY ledger_purchase_select_own ON purama_ai.point_purchases FOR SELECT TO authenticated USING (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'purama_ai' AND tablename = 'daily_gifts' AND policyname = 'ledger_gift_select_own') THEN
    CREATE POLICY ledger_gift_select_own ON purama_ai.daily_gifts FOR SELECT TO authenticated USING (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'purama_ai' AND tablename = 'lottery_draws' AND policyname = 'ledger_draw_read') THEN
    CREATE POLICY ledger_draw_read ON purama_ai.lottery_draws FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'purama_ai' AND tablename = 'lottery_tickets' AND policyname = 'ledger_ticket_select_own') THEN
    CREATE POLICY ledger_ticket_select_own ON purama_ai.lottery_tickets FOR SELECT TO authenticated USING (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'purama_ai' AND tablename = 'lottery_winners' AND policyname = 'ledger_winner_read') THEN
    CREATE POLICY ledger_winner_read ON purama_ai.lottery_winners FOR SELECT TO authenticated USING (true);
  END IF;
END
$$;

-- No direct client mutation: SECURITY DEFINER RPCs below are the only write boundary.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  purama_ai.wallets, purama_ai.wallet_transactions, purama_ai.withdrawals,
  purama_ai.purama_points, purama_ai.point_transactions, purama_ai.point_shop_items,
  purama_ai.point_purchases, purama_ai.daily_gifts, purama_ai.lottery_draws,
  purama_ai.lottery_tickets, purama_ai.lottery_winners
FROM anon, authenticated;

GRANT USAGE ON SCHEMA purama_ai TO authenticated, service_role;
GRANT SELECT ON
  purama_ai.wallets, purama_ai.wallet_transactions, purama_ai.withdrawals,
  purama_ai.purama_points, purama_ai.point_transactions, purama_ai.point_shop_items,
  purama_ai.point_purchases, purama_ai.daily_gifts, purama_ai.lottery_draws,
  purama_ai.lottery_tickets, purama_ai.lottery_winners
TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  purama_ai.wallets, purama_ai.wallet_transactions, purama_ai.withdrawals,
  purama_ai.purama_points, purama_ai.point_transactions, purama_ai.point_shop_items,
  purama_ai.point_purchases, purama_ai.daily_gifts, purama_ai.lottery_draws,
  purama_ai.lottery_tickets, purama_ai.lottery_winners
TO service_role;

-- Only ticket rewards have an implemented, transactional delivery path.
INSERT INTO purama_ai.point_shop_items (category, name, description, cost_points, type, value, is_active)
SELECT 'tickets', '1 ticket tirage mensuel', 'Une chance supplémentaire au prochain tirage mensuel', 500, 'ticket', '1', true
WHERE NOT EXISTS (
  SELECT 1 FROM purama_ai.point_shop_items WHERE type = 'ticket' AND is_active
);

CREATE OR REPLACE FUNCTION purama_ai.claim_daily_gift()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, purama_ai
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_day DATE := (clock_timestamp() AT TIME ZONE 'UTC')::DATE;
  v_points INTEGER;
  v_streak INTEGER;
  v_last_day DATE;
  v_roll DOUBLE PRECISION;
  v_existing purama_ai.daily_gifts%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501';
  END IF;

  INSERT INTO purama_ai.purama_points (user_id) VALUES (v_user)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT streak_days INTO v_streak
  FROM purama_ai.purama_points
  WHERE user_id = v_user
  FOR UPDATE;

  SELECT * INTO v_existing
  FROM purama_ai.daily_gifts
  WHERE user_id = v_user AND gift_day = v_day;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'gift_type', v_existing.gift_type,
      'gift_value', v_existing.gift_value,
      'streak_count', v_existing.streak_count,
      'label', '+' || v_existing.gift_value || ' points',
      'already_claimed', true,
      'opened_at', v_existing.opened_at
    );
  END IF;

  SELECT max(gift_day) INTO v_last_day
  FROM purama_ai.daily_gifts
  WHERE user_id = v_user AND gift_day < v_day;
  v_streak := CASE WHEN v_last_day = v_day - 1 THEN COALESCE(v_streak, 0) + 1 ELSE 1 END;

  v_roll := random();
  v_points := CASE
    WHEN v_roll < 0.55 THEN 5
    WHEN v_roll < 0.80 THEN 10
    WHEN v_roll < 0.94 THEN 15
    WHEN v_roll < 0.985 THEN 20
    WHEN v_roll < 0.998 THEN 50
    ELSE 100
  END;

  INSERT INTO purama_ai.daily_gifts (user_id, gift_type, gift_value, streak_count, gift_day)
  VALUES (v_user, 'points', v_points::TEXT, COALESCE(v_streak, 0), v_day);

  UPDATE purama_ai.purama_points
  SET balance = balance + v_points,
      lifetime_earned = lifetime_earned + v_points,
      streak_days = v_streak,
      last_active_date = v_day,
      updated_at = clock_timestamp()
  WHERE user_id = v_user;

  INSERT INTO purama_ai.point_transactions (user_id, amount, type, source, description, idempotency_key)
  VALUES (v_user, v_points, 'credit', 'daily_gift', 'Coffre quotidien ' || v_day, gen_random_uuid());

  RETURN jsonb_build_object(
    'gift_type', 'points',
    'gift_value', v_points::TEXT,
    'streak_count', v_streak,
    'label', '+' || v_points || ' points',
    'already_claimed', false,
    'opened_at', clock_timestamp()
  );
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.purchase_shop_item(
  p_item_id UUID,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, purama_ai
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_item purama_ai.point_shop_items%ROWTYPE;
  v_balance INTEGER;
  v_draw UUID;
  v_purchase UUID;
  v_existing_item UUID;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501'; END IF;
  IF p_item_id IS NULL OR p_idempotency_key IS NULL THEN RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_user::TEXT || ':' || p_idempotency_key::TEXT, 0));
  SELECT id, item_id INTO v_purchase, v_existing_item FROM purama_ai.point_purchases
  WHERE user_id = v_user AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing_item <> p_item_id THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '22023'; END IF;
    RETURN jsonb_build_object('purchase_id', v_purchase, 'already_processed', true);
  END IF;

  SELECT * INTO v_item FROM purama_ai.point_shop_items
  WHERE id = p_item_id AND is_active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'item_unavailable' USING ERRCODE = 'P0001'; END IF;
  IF v_item.type <> 'ticket' THEN RAISE EXCEPTION 'reward_delivery_not_available' USING ERRCODE = 'P0001'; END IF;

  SELECT id INTO v_draw FROM purama_ai.lottery_draws
  WHERE status IN ('upcoming', 'live') AND draw_date >= (clock_timestamp() AT TIME ZONE 'UTC')::DATE
  ORDER BY draw_date ASC LIMIT 1 FOR UPDATE;
  IF v_draw IS NULL THEN RAISE EXCEPTION 'no_active_draw' USING ERRCODE = 'P0001'; END IF;

  SELECT balance INTO v_balance FROM purama_ai.purama_points
  WHERE user_id = v_user FOR UPDATE;
  IF v_balance IS NULL OR v_balance < v_item.cost_points THEN RAISE EXCEPTION 'insufficient_points' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO purama_ai.point_purchases (user_id, item_id, points_spent, idempotency_key)
  VALUES (v_user, v_item.id, v_item.cost_points, p_idempotency_key)
  RETURNING id INTO v_purchase;

  UPDATE purama_ai.purama_points SET balance = balance - v_item.cost_points, updated_at = clock_timestamp()
  WHERE user_id = v_user;
  INSERT INTO purama_ai.point_transactions (user_id, amount, type, source, description, idempotency_key)
  VALUES (v_user, -v_item.cost_points, 'debit', 'shop_purchase', v_item.name, p_idempotency_key);
  INSERT INTO purama_ai.lottery_tickets (user_id, draw_id, source, idempotency_key)
  VALUES (v_user, v_draw, 'achat_points', p_idempotency_key);

  RETURN jsonb_build_object('purchase_id', v_purchase, 'ticket_delivered', true, 'points_spent', v_item.cost_points, 'already_processed', false);
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.request_wallet_withdrawal(
  p_amount NUMERIC,
  p_iban TEXT,
  p_beneficiary_name TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, purama_ai
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_balance NUMERIC(12,2);
  v_iban TEXT := upper(regexp_replace(COALESCE(p_iban, ''), '[[:space:]]', '', 'g'));
  v_name TEXT := btrim(COALESCE(p_beneficiary_name, ''));
  v_withdrawal UUID;
  v_existing_amount NUMERIC(12,2);
  v_existing_iban TEXT;
  v_existing_name TEXT;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501'; END IF;
  IF p_idempotency_key IS NULL OR p_amount IS NULL OR p_amount < 5 OR p_amount > 100000 OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'invalid_amount' USING ERRCODE = '22023';
  END IF;
  IF v_iban !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$' THEN RAISE EXCEPTION 'invalid_iban' USING ERRCODE = '22023'; END IF;
  IF char_length(v_name) < 2 OR char_length(v_name) > 120 THEN RAISE EXCEPTION 'invalid_beneficiary' USING ERRCODE = '22023'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_user::TEXT || ':' || p_idempotency_key::TEXT, 0));
  SELECT id, amount, iban, beneficiary_name
  INTO v_withdrawal, v_existing_amount, v_existing_iban, v_existing_name
  FROM purama_ai.withdrawals
  WHERE user_id = v_user AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing_amount <> p_amount OR v_existing_iban <> v_iban OR v_existing_name <> v_name THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('withdrawal_id', v_withdrawal, 'already_processed', true);
  END IF;

  INSERT INTO purama_ai.wallets (user_id) VALUES (v_user) ON CONFLICT (user_id) DO NOTHING;
  SELECT balance INTO v_balance FROM purama_ai.wallets WHERE user_id = v_user FOR UPDATE;
  IF v_balance < p_amount THEN RAISE EXCEPTION 'insufficient_balance' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO purama_ai.withdrawals (user_id, amount, iban, beneficiary_name, idempotency_key)
  VALUES (v_user, p_amount, v_iban, v_name, p_idempotency_key)
  RETURNING id INTO v_withdrawal;

  UPDATE purama_ai.wallets SET balance = balance - p_amount, updated_at = clock_timestamp() WHERE user_id = v_user;
  INSERT INTO purama_ai.wallet_transactions (user_id, amount, type, source, description, idempotency_key)
  VALUES (v_user, -p_amount, 'withdrawal', 'withdrawal_request', 'Retrait en attente', p_idempotency_key);

  RETURN jsonb_build_object('withdrawal_id', v_withdrawal, 'reserved_amount', p_amount, 'already_processed', false);
END;
$$;

REVOKE ALL ON FUNCTION purama_ai.claim_daily_gift() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION purama_ai.purchase_shop_item(UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION purama_ai.request_wallet_withdrawal(NUMERIC, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION purama_ai.claim_daily_gift() TO authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.purchase_shop_item(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.request_wallet_withdrawal(NUMERIC, TEXT, TEXT, UUID) TO authenticated;
