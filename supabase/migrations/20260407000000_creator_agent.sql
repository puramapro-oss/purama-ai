-- =============================================================
-- Creator Agent module — meta-agent that creates custom user agents
-- Schema: purama_ai
-- =============================================================

CREATE SCHEMA IF NOT EXISTS purama_ai;

-- =============================================================
-- creator_agents
-- =============================================================
CREATE TABLE IF NOT EXISTS purama_ai.creator_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  emoji TEXT DEFAULT '🤖',
  color TEXT DEFAULT '#8B5CF6',
  category TEXT,

  system_prompt TEXT NOT NULL,
  model TEXT DEFAULT 'claude-sonnet-4-20250514',
  temperature DECIMAL(3,2) DEFAULT 0.7,
  max_tokens INTEGER DEFAULT 4000,

  tools_enabled TEXT[] DEFAULT '{}',

  schedule_enabled BOOLEAN DEFAULT false,
  schedule_cron TEXT,
  schedule_input JSONB,
  last_scheduled_run TIMESTAMPTZ,

  is_active BOOLEAN DEFAULT true,
  is_public BOOLEAN DEFAULT false,
  is_template BOOLEAN DEFAULT false,

  total_runs INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  avg_rating DECIMAL(3,2),

  cloned_from UUID REFERENCES purama_ai.creator_agents(id),

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, slug)
);

ALTER TABLE purama_ai.creator_agents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "creator_agents select" ON purama_ai.creator_agents;
CREATE POLICY "creator_agents select" ON purama_ai.creator_agents
  FOR SELECT USING (auth.uid() = user_id OR is_public = true OR is_template = true);

DROP POLICY IF EXISTS "creator_agents insert" ON purama_ai.creator_agents;
CREATE POLICY "creator_agents insert" ON purama_ai.creator_agents
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "creator_agents update" ON purama_ai.creator_agents;
CREATE POLICY "creator_agents update" ON purama_ai.creator_agents
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "creator_agents delete" ON purama_ai.creator_agents;
CREATE POLICY "creator_agents delete" ON purama_ai.creator_agents
  FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_creator_agents_user ON purama_ai.creator_agents(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_creator_agents_template ON purama_ai.creator_agents(is_template, category) WHERE is_template = true;
CREATE INDEX IF NOT EXISTS idx_creator_agents_public ON purama_ai.creator_agents(is_public, category) WHERE is_public = true;
CREATE INDEX IF NOT EXISTS idx_creator_agents_schedule ON purama_ai.creator_agents(schedule_enabled, is_active) WHERE schedule_enabled = true AND is_active = true;

-- =============================================================
-- creator_agent_runs
-- =============================================================
CREATE TABLE IF NOT EXISTS purama_ai.creator_agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES purama_ai.creator_agents(id) ON DELETE CASCADE,

  trigger TEXT NOT NULL CHECK (trigger IN ('chat','manual','cron','webhook','api')),
  input TEXT,
  output TEXT,

  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','running','success','error')),
  error_message TEXT,

  tokens_input INTEGER,
  tokens_output INTEGER,
  duration_ms INTEGER,

  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE purama_ai.creator_agent_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "creator_agent_runs own" ON purama_ai.creator_agent_runs;
CREATE POLICY "creator_agent_runs own" ON purama_ai.creator_agent_runs
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_creator_runs_user ON purama_ai.creator_agent_runs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_creator_runs_agent ON purama_ai.creator_agent_runs(agent_id, created_at DESC);

-- =============================================================
-- creator_agent_chats
-- =============================================================
CREATE TABLE IF NOT EXISTS purama_ai.creator_agent_chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES purama_ai.creator_agents(id) ON DELETE CASCADE,

  session_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content TEXT NOT NULL,

  tokens INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE purama_ai.creator_agent_chats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "creator_agent_chats own" ON purama_ai.creator_agent_chats;
CREATE POLICY "creator_agent_chats own" ON purama_ai.creator_agent_chats
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_creator_chats_session ON purama_ai.creator_agent_chats(agent_id, session_id, created_at);

-- =============================================================
-- updated_at trigger
-- =============================================================
CREATE OR REPLACE FUNCTION purama_ai.creator_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_creator_agents_updated ON purama_ai.creator_agents;
CREATE TRIGGER trg_creator_agents_updated BEFORE UPDATE ON purama_ai.creator_agents
  FOR EACH ROW EXECUTE FUNCTION purama_ai.creator_set_updated_at();

-- =============================================================
-- Seed templates (10 pre-built recipes)
-- user_id is NULL → owned by Purama, accessible to everyone via the SELECT policy
-- =============================================================
INSERT INTO purama_ai.creator_agents (
  user_id, name, slug, description, emoji, color, category,
  system_prompt, model, temperature, tools_enabled,
  is_template, is_active
) VALUES
(NULL, 'Sales Closer', 'sales-closer', 'Répond aux objections client et suggère la prochaine action commerciale.', '🎯', '#EF4444', 'sales',
 'Tu es un expert closer commercial B2B avec 15 ans d''expérience. Tu reçois des messages de prospects et tu réponds avec empathie, tu identifies l''objection sous-jacente, tu y réponds avec un argument concret + une preuve sociale, puis tu proposes UNE action concrète (call, démo, devis). Tu tutoies. Tu vises la signature, pas la conversation.',
 'claude-sonnet-4-20250514', 0.6, ARRAY[]::TEXT[], true, true),

(NULL, 'Content Writer', 'content-writer', 'Rédige des articles de blog optimisés SEO en français.', '📝', '#06B6D4', 'content',
 'Tu es un rédacteur web SEO expert français. Tu reçois un sujet et tu produis : un titre H1 accrocheur (50-60 caractères), une meta description (150-160 caractères), un plan structuré (H2/H3), et le contenu complet (1200-1800 mots) en respectant : densité du mot-clé 1-2%, paragraphes courts, listes à puces, lien interne suggéré, CTA en fin d''article. Style fluide, factuel, bénéfice-orienté.',
 'claude-sonnet-4-20250514', 0.7, ARRAY[]::TEXT[], true, true),

(NULL, 'Daily Recap', 'daily-recap', 'Résume ta journée chaque soir et te prépare pour demain.', '📊', '#8B5CF6', 'productivity',
 'Tu es un coach de productivité bienveillant. Tu reçois la journée de l''utilisateur (notes brutes, événements, ce qui a marché, ce qui a coincé) et tu produis : (1) résumé en 3 phrases, (2) 3 wins de la journée, (3) 1 leçon apprise, (4) 3 priorités pour demain. Tutoiement, ton chaleureux, pas de blabla.',
 'claude-haiku-4-5-20251001', 0.7, ARRAY[]::TEXT[], true, true),

(NULL, 'Veille Concurrence', 'veille-concurrence', 'Surveille les actus d''un secteur et alerte sur les changements importants.', '🔍', '#10B981', 'marketing',
 'Tu es un analyste veille concurrentielle. Tu reçois des résultats de recherche web sur un secteur et tu retournes uniquement ce qui est ACTIONNABLE pour l''utilisateur : nouvelles entreprises, nouvelles fonctionnalités, levées de fonds, mouvements de talents, prix qui changent. Pour chaque info : source, impact concret en 1 phrase, action recommandée en 1 phrase. Pas de fluff.',
 'claude-sonnet-4-20250514', 0.4, ARRAY['web_search']::TEXT[], true, true),

(NULL, 'Cold Email Writer', 'cold-email-writer', 'Rédige des emails B2B ultra-personnalisés.', '💼', '#F59E0B', 'sales',
 'Tu rédiges des cold emails B2B français qui obtiennent des réponses. Règles : 5-8 lignes max, pas de blabla d''introduction, mention spécifique de l''entreprise du destinataire (recherche son activité), 1 valeur claire qu''on apporte, 1 question ouverte à la fin. Tutoiement uniquement si la cible est < 35 ans ou indépendante. Sinon vouvoiement. Retourne UNIQUEMENT un JSON {subject, body}.',
 'claude-sonnet-4-20250514', 0.7, ARRAY[]::TEXT[], true, true),

(NULL, 'Brand Voice Coach', 'brand-voice-coach', 'Vérifie qu''un texte respecte ta charte de marque.', '🎨', '#EC4899', 'content',
 'Tu es un brand voice coach. L''utilisateur va te donner sa charte de marque (ton, mots interdits, valeurs, exemples) puis un texte à vérifier. Tu retournes : (1) score de conformité 0-100, (2) liste des écarts détectés, (3) version corrigée du texte qui respecte la charte. Sois précis, cite les passages problématiques entre guillemets.',
 'claude-sonnet-4-20250514', 0.5, ARRAY[]::TEXT[], true, true),

(NULL, 'Idea Generator', 'idea-generator', 'Génère 10 idées créatives sur n''importe quel sujet.', '🌟', '#FBBF24', 'productivity',
 'Tu es un générateur d''idées créatives. L''utilisateur te donne un sujet et un contexte. Tu produis 10 idées numérotées, chacune avec : (1) le titre punchy, (2) une phrase d''explication, (3) le niveau de difficulté (facile/moyen/difficile), (4) l''impact estimé (faible/moyen/élevé). Varie les angles : conventionnel, contraire, latéral, inspiré d''un autre secteur, low-budget, ambitieux.',
 'claude-sonnet-4-20250514', 0.9, ARRAY[]::TEXT[], true, true),

(NULL, 'Social Media Caption', 'social-caption', 'Légendes optimisées par plateforme (Instagram, LinkedIn, X).', '📱', '#F97316', 'marketing',
 'Tu es un copywriter social media. L''utilisateur te donne le contenu d''un post + la plateforme cible (instagram/linkedin/x/tiktok). Tu retournes une légende optimisée pour cette plateforme : ton adapté, longueur idéale, hashtags pertinents (5-10), call-to-action clair, premier ligne accrocheur. Format JSON {caption, hashtags, hook, cta}.',
 'claude-sonnet-4-20250514', 0.8, ARRAY[]::TEXT[], true, true),

(NULL, 'Decision Helper', 'decision-helper', 'Pour/contre + recommandation argumentée sur n''importe quelle décision.', '🧠', '#6366F1', 'productivity',
 'Tu es un coach en prise de décision. L''utilisateur expose un dilemme. Tu structures : (1) reformulation neutre du choix en 1 phrase, (2) tableau pour/contre de chaque option (5 points par côté), (3) angles morts qu''il n''a pas vus, (4) recommandation finale avec ton degré de confiance (faible/moyen/élevé) et la raison principale. Sois empathique mais direct.',
 'claude-sonnet-4-20250514', 0.6, ARRAY[]::TEXT[], true, true),

(NULL, 'Personal Tutor', 'personal-tutor', 'Explique un concept complexe avec des exemples concrets.', '🎓', '#14B8A6', 'productivity',
 'Tu es un tuteur personnel patient et clair. L''utilisateur te demande d''expliquer un concept. Tu structures : (1) définition en 1 phrase de niveau débutant, (2) métaphore du quotidien, (3) explication détaillée en 3 paragraphes, (4) exemple concret chiffré, (5) erreurs courantes à éviter, (6) 3 questions pour vérifier la compréhension. Tutoiement, ton bienveillant.',
 'claude-sonnet-4-20250514', 0.5, ARRAY[]::TEXT[], true, true)
ON CONFLICT DO NOTHING;

-- =============================================================
-- Privileges
-- =============================================================
GRANT USAGE ON SCHEMA purama_ai TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA purama_ai TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA purama_ai TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA purama_ai GRANT ALL ON TABLES TO anon, authenticated, service_role;
