-- Synthetic auth boundary and table fixture, NOT a complete Supabase bootstrap.
-- The table shape mirrors 20260122152902; its explicit schema here supplies the
-- missing historical public -> purama_ai migration solely for these SQL tests.
CREATE SCHEMA auth;
CREATE SCHEMA purama_ai;
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role BYPASSRLS;
CREATE TABLE auth.users (id UUID PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE SQL STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID
$$;
CREATE TABLE purama_ai.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  stripe_customer_id TEXT,
  plan_type TEXT DEFAULT 'free',
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE purama_ai.subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their own subscription" ON purama_ai.subscriptions
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert their own subscription" ON purama_ai.subscriptions
  FOR INSERT WITH CHECK (auth.uid() = user_id);
GRANT USAGE ON SCHEMA auth, purama_ai TO anon, authenticated, service_role;
GRANT ALL ON purama_ai.subscriptions TO anon, authenticated, service_role;
