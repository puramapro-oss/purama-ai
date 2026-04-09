-- P3 Tables for Purama AI

-- WALLET
CREATE TABLE IF NOT EXISTS purama_ai.wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  balance NUMERIC(12,2) DEFAULT 0,
  total_earned NUMERIC(12,2) DEFAULT 0,
  total_withdrawn NUMERIC(12,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id)
);

CREATE TABLE IF NOT EXISTS purama_ai.wallet_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('credit', 'debit', 'withdrawal')),
  source TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purama_ai.withdrawals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 5),
  iban TEXT NOT NULL,
  beneficiary_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'rejected')),
  requested_at TIMESTAMPTZ DEFAULT now(),
  processed_at TIMESTAMPTZ
);

-- POINTS
CREATE TABLE IF NOT EXISTS purama_ai.purama_points (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  balance INTEGER DEFAULT 0,
  lifetime_earned INTEGER DEFAULT 0,
  streak_days INTEGER DEFAULT 0,
  last_active_date DATE,
  streak_multiplier NUMERIC(3,1) DEFAULT 1.0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id)
);

CREATE TABLE IF NOT EXISTS purama_ai.point_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purama_ai.point_shop_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  cost_points INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('reduction', 'subscription', 'ticket', 'feature', 'cash')),
  value TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purama_ai.point_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  item_id UUID REFERENCES purama_ai.point_shop_items(id),
  points_spent INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- DAILY GIFT
CREATE TABLE IF NOT EXISTS purama_ai.daily_gifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  gift_type TEXT NOT NULL,
  gift_value TEXT NOT NULL,
  streak_count INTEGER DEFAULT 0,
  opened_at TIMESTAMPTZ DEFAULT now()
);

-- LOTTERY
CREATE TABLE IF NOT EXISTS purama_ai.lottery_draws (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draw_date DATE NOT NULL,
  pool_amount NUMERIC(12,2) DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'live', 'completed')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purama_ai.lottery_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  draw_id UUID REFERENCES purama_ai.lottery_draws(id),
  source TEXT NOT NULL CHECK (source IN ('inscription', 'parrainage', 'mission', 'partage', 'note', 'challenge', 'streak', 'abo', 'achat_points')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purama_ai.lottery_winners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draw_id UUID NOT NULL REFERENCES purama_ai.lottery_draws(id),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ticket_id UUID REFERENCES purama_ai.lottery_tickets(id),
  rank INTEGER NOT NULL,
  amount_won NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- SOCIAL SHARES
CREATE TABLE IF NOT EXISTS purama_ai.social_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  share_code TEXT NOT NULL,
  platform_hint TEXT,
  points_given INTEGER DEFAULT 0,
  shared_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purama_ai.share_conversions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id UUID NOT NULL REFERENCES purama_ai.social_shares(id),
  new_user_id UUID REFERENCES auth.users(id),
  bonus_points_given INTEGER DEFAULT 0,
  converted_at TIMESTAMPTZ DEFAULT now()
);

-- CROSS PROMO
CREATE TABLE IF NOT EXISTS purama_ai.cross_promos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_app TEXT NOT NULL,
  target_app TEXT NOT NULL,
  target_name TEXT NOT NULL,
  target_description TEXT,
  target_url TEXT NOT NULL,
  target_color TEXT,
  target_icon TEXT,
  coupon_code TEXT DEFAULT 'CROSS50',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- FAQ
CREATE TABLE IF NOT EXISTS purama_ai.faq_articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  search_keywords TEXT[],
  view_count INTEGER DEFAULT 0,
  helpful_count INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- RLS
ALTER TABLE purama_ai.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.withdrawals ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.purama_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.point_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.point_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.daily_gifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.lottery_draws ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.lottery_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.lottery_winners ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.social_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.share_conversions ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.cross_promos ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.faq_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.point_shop_items ENABLE ROW LEVEL SECURITY;

-- RLS Policies
DO $$ BEGIN CREATE POLICY wallet_own ON purama_ai.wallets FOR ALL USING (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY wallet_tx_own ON purama_ai.wallet_transactions FOR ALL USING (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY withdrawal_own ON purama_ai.withdrawals FOR ALL USING (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY points_own ON purama_ai.purama_points FOR ALL USING (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY point_tx_own ON purama_ai.point_transactions FOR ALL USING (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY point_purchase_own ON purama_ai.point_purchases FOR ALL USING (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY daily_gift_own ON purama_ai.daily_gifts FOR ALL USING (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY lottery_draws_read ON purama_ai.lottery_draws FOR SELECT USING (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY lottery_tickets_own ON purama_ai.lottery_tickets FOR ALL USING (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY lottery_winners_read ON purama_ai.lottery_winners FOR SELECT USING (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY shares_own ON purama_ai.social_shares FOR ALL USING (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY share_conv_read ON purama_ai.share_conversions FOR SELECT USING (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY cross_promos_read ON purama_ai.cross_promos FOR SELECT USING (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY faq_read ON purama_ai.faq_articles FOR SELECT USING (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY shop_items_read ON purama_ai.point_shop_items FOR SELECT USING (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_wallet_user ON purama_ai.wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_user ON purama_ai.wallet_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON purama_ai.withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_points_user ON purama_ai.purama_points(user_id);
CREATE INDEX IF NOT EXISTS idx_point_tx_user ON purama_ai.point_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_daily_gifts_user ON purama_ai.daily_gifts(user_id);
CREATE INDEX IF NOT EXISTS idx_lottery_tickets_user ON purama_ai.lottery_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_shares_user ON purama_ai.social_shares(user_id);

-- Seed FAQ
INSERT INTO purama_ai.faq_articles (category, question, answer, search_keywords, sort_order) VALUES
('general', 'Qu''est-ce que Purama AI ?', 'Purama AI est une plateforme d''agents IA autonomes pour automatiser tes tâches business : social media, emails, comptabilité, juridique, partenariats et création de contenu.', ARRAY['purama', 'ia', 'agent', 'plateforme'], 1),
('general', 'Comment commencer ?', 'Inscris-toi gratuitement, choisis tes agents dans le dashboard, et lance ta première tâche en quelques clics. Le plan gratuit inclut des essais sur chaque agent.', ARRAY['commencer', 'inscription', 'gratuit', 'debut'], 2),
('general', 'Quels agents sont disponibles ?', 'Social (autopilote réseaux sociaux), Email (tri et réponses), Compta (factures et déclarations), Juridique (contrats et veille), Partenariat (prospection) et Créateur d''agents.', ARRAY['agents', 'social', 'email', 'compta', 'juridique'], 3),
('abonnement', 'Quels sont les plans disponibles ?', '4 plans : Gratuit (essais limités), Starter (9.90€/mois), Pro (24.90€/mois, le plus populaire) et Unlimited (49.90€/mois). -33% en annuel. 14 jours d''essai.', ARRAY['prix', 'plan', 'abonnement', 'tarif', 'cout'], 4),
('abonnement', 'Comment changer de plan ?', 'Va dans Dashboard > Abonnement et clique sur le bouton Gérer. Tu peux upgrader, downgrader ou annuler à tout moment.', ARRAY['changer', 'plan', 'upgrade', 'downgrade', 'annuler'], 5),
('abonnement', 'Y a-t-il un essai gratuit ?', 'Oui, 14 jours d''essai gratuit sur tous les plans payants. Aucune carte bancaire requise pour commencer.', ARRAY['essai', 'gratuit', 'trial', 'test'], 6),
('parrainage', 'Comment fonctionne le parrainage ?', 'Partage ton lien unique. Tu gagnes 50%% du 1er mois + 10%% à vie sur chaque filleul qui s''abonne. Plus tu parraines, plus ta commission augmente (jusqu''à 30%%).', ARRAY['parrainage', 'filleul', 'commission', 'gagner'], 7),
('parrainage', 'Quand suis-je payé ?', 'Les commissions sont versées mensuellement sur ton wallet. Tu peux retirer dès 5€ par virement IBAN.', ARRAY['paiement', 'retrait', 'wallet', 'iban', 'virement'], 8),
('wallet', 'Comment retirer mes gains ?', 'Va dans la section Wallet, entre ton IBAN et le montant (minimum 5€). Le virement est traité sous 3-5 jours ouvrés.', ARRAY['retrait', 'iban', 'virement', 'gains', 'argent'], 9),
('wallet', 'Qu''est-ce que les Points Purama ?', '1 point = 0,01€. Gagne des points en utilisant les agents, parrainant, partageant, etc. Échange-les contre des réductions, abonnements gratuits ou de l''argent.', ARRAY['points', 'purama', 'gagner', 'echanger'], 10),
('agents', 'Comment connecter mes réseaux sociaux ?', 'Va dans Dashboard > Réseaux sociaux et connecte tes comptes via OAuth. L''agent social gérera automatiquement tes publications.', ARRAY['reseaux', 'sociaux', 'connecter', 'oauth', 'instagram', 'tiktok'], 11),
('agents', 'L''IA peut-elle gérer ma comptabilité ?', 'Oui ! L''agent Compta catégorise tes transactions, génère tes factures (format Factur-X), prépare tes déclarations et produit des rapports mensuels.', ARRAY['comptabilite', 'facture', 'declaration', 'rapport'], 12),
('agents', 'L''agent juridique remplace-t-il un avocat ?', 'Non, il t''assiste en générant des contrats, suivant les deadlines légales et faisant de la veille réglementaire. Pour des cas complexes, consulte un professionnel.', ARRAY['juridique', 'avocat', 'contrat', 'legal'], 13),
('securite', 'Mes données sont-elles protégées ?', 'Oui, infrastructure hébergée en France (VPS dédié), chiffrement de bout en bout, conformité RGPD. Tu peux exporter ou supprimer tes données à tout moment.', ARRAY['securite', 'donnees', 'rgpd', 'protection', 'chiffrement'], 14),
('securite', 'Puis-je supprimer mon compte ?', 'Oui, va dans Paramètres > Supprimer mon compte. Toutes tes données seront supprimées définitivement sous 30 jours.', ARRAY['supprimer', 'compte', 'donnees', 'rgpd'], 15)
ON CONFLICT DO NOTHING;

-- Seed shop items
INSERT INTO purama_ai.point_shop_items (category, name, description, cost_points, type, value) VALUES
('reductions', '-10%% sur ton prochain mois', 'Coupon de réduction 10%% applicable sur n''importe quel plan', 1000, 'reduction', '10'),
('reductions', '-30%% sur ton prochain mois', 'Coupon de réduction 30%% applicable sur n''importe quel plan', 3000, 'reduction', '30'),
('reductions', '-50%% sur ton prochain mois', 'Coupon de réduction 50%% applicable sur n''importe quel plan', 5000, 'reduction', '50'),
('abonnements', '1 mois Starter GRATUIT', 'Profite d''un mois complet du plan Starter', 15000, 'subscription', 'starter_1m'),
('abonnements', '1 mois Pro GRATUIT', 'Profite d''un mois complet du plan Pro', 30000, 'subscription', 'pro_1m'),
('abonnements', '1 mois Unlimited GRATUIT', 'Profite d''un mois complet du plan Unlimited', 50000, 'subscription', 'unlimited_1m'),
('tickets', '1 ticket tirage mensuel', 'Une chance supplémentaire au tirage mensuel', 500, 'ticket', '1'),
('cash', '1€ sur ton wallet', 'Convertis tes points en argent réel', 10000, 'cash', '1')
ON CONFLICT DO NOTHING;

-- Seed cross promos
INSERT INTO purama_ai.cross_promos (source_app, target_app, target_name, target_description, target_url, target_color, target_icon) VALUES
('purama_ai', 'jurispurama', 'JurisPurama', 'Ton assistant juridique IA — contrats, veille légale, recouvrement', 'https://jurispurama.purama.dev', '#6D28D9', 'Scale'),
('purama_ai', 'midas', 'MIDAS', 'Trading IA — analyses, signaux, portefeuille automatisé', 'https://midas.purama.dev', '#F59E0B', 'TrendingUp'),
('purama_ai', 'kash', 'KASH', 'Épargne intelligente — automatise et optimise ton épargne', 'https://kash.purama.dev', '#F59E0B', 'PiggyBank'),
('purama_ai', 'akasha', 'AKASHA', 'Multi-expert IA — recherche, analyse, création tout-en-un', 'https://akasha.purama.dev', '#00d4ff', 'Brain')
ON CONFLICT DO NOTHING;

SELECT 'ALL P3 TABLES CREATED OK';
