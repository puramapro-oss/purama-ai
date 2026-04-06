# 🧬 AGENT CRÉATEUR D'AGENTS PURAMA — BRIEF V1.0

## VISION

Le **meta-agent** qui permet à n'importe quel utilisateur de **créer ses propres agents IA Purama** sans code, en décrivant simplement ce qu'il veut en français.

Concrètement :
- L'utilisateur tape : « Je veux un agent qui répond aux DM Instagram à ma place avec mon style »
- L'IA génère automatiquement : nom, emoji, prompt système expert, liste d'outils, planification recommandée
- L'utilisateur peut le tester en chat puis le déployer
- L'agent créé peut tourner à la demande OU sur cron (autonomie 24/7)
- Templates pré-construits (« Agent Closer », « Agent Veille concurrentielle », « Agent Recap quotidien », etc.) en 1 clic
- Marketplace : partager ses agents avec la communauté Purama

C'est l'équivalent du GPT Builder d'OpenAI, mais propulsé par Claude Sonnet 4 et intégré à tout l'écosystème Purama.

---

## ARCHITECTURE

### Stack
- **Frontend** : Pages dans Purama AI (`/dashboard/creator-agent/*`)
- **Backend** : Supabase (4 tables `creator_agent_*` dans schema `purama_ai`)
- **Moteur IA** : Claude API (sonnet-4 par défaut, haiku-4-5 pour les agents légers)
- **Orchestrateur** : n8n (1 workflow scheduler pour les agents cron)
- **Notifications** : système partagé `agent_notifications` + push PWA

### Concepts
1. **Agent custom** = un objet stocké en DB avec un system prompt + outils + config
2. **Run** = une exécution unique d'un agent (peut être déclenchée par chat, par cron, ou par webhook)
3. **Template** = un agent pré-construit que tout le monde peut cloner
4. **Marketplace** = liste publique des templates officiels Purama + partagés par les users

---

## BASE DE DONNÉES SUPABASE

### Table : `creator_agents`

```sql
CREATE TABLE creator_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Identité
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  emoji TEXT DEFAULT '🤖',
  color TEXT DEFAULT '#8B5CF6',
  category TEXT, -- productivity, marketing, sales, support, content, dev, finance, autre

  -- Cerveau
  system_prompt TEXT NOT NULL,
  model TEXT DEFAULT 'claude-sonnet-4-20250514', -- sonnet ou haiku
  temperature DECIMAL(3,2) DEFAULT 0.7,
  max_tokens INTEGER DEFAULT 4000,

  -- Capacités
  tools_enabled TEXT[] DEFAULT '{}', -- web_search, send_email, gen_image, calc, supabase_query, etc.

  -- Mode autonome (optionnel)
  schedule_enabled BOOLEAN DEFAULT false,
  schedule_cron TEXT, -- ex: "0 9 * * *" pour tous les jours 9h
  schedule_input JSONB, -- input par défaut quand le cron déclenche

  -- État
  is_active BOOLEAN DEFAULT true,
  is_public BOOLEAN DEFAULT false, -- partagé sur le marketplace
  is_template BOOLEAN DEFAULT false, -- template pré-construit Purama

  -- Stats
  total_runs INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  avg_rating DECIMAL(3,2),

  -- Source
  cloned_from UUID, -- si cloné depuis un template

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, slug)
);
```

### Table : `creator_agent_runs`

```sql
CREATE TABLE creator_agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES creator_agents(id) ON DELETE CASCADE,

  trigger TEXT NOT NULL, -- chat, manual, cron, webhook
  input TEXT,
  output TEXT,

  status TEXT DEFAULT 'pending', -- pending, running, success, error
  error_message TEXT,

  tokens_input INTEGER,
  tokens_output INTEGER,
  duration_ms INTEGER,

  created_at TIMESTAMPTZ DEFAULT now()
);
```

### Table : `creator_agent_chats`

```sql
CREATE TABLE creator_agent_chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES creator_agents(id) ON DELETE CASCADE,

  session_id UUID NOT NULL,
  role TEXT NOT NULL, -- user, assistant
  content TEXT NOT NULL,

  tokens INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### Table : `creator_agent_marketplace`

(Vue ou table séparée des templates publics + agents partagés.)

```sql
-- On utilise simplement creator_agents avec is_template=true OR is_public=true
-- Les templates Purama ont user_id=NULL et is_template=true.
```

### RLS

```sql
ALTER TABLE creator_agents ENABLE ROW LEVEL SECURITY;
-- Les users voient leurs propres agents + tous les templates publics
CREATE POLICY "Users see own + public" ON creator_agents
  FOR SELECT USING (auth.uid() = user_id OR is_public = true OR is_template = true);
-- Les users peuvent muter uniquement leurs propres agents
CREATE POLICY "Users mutate own" ON creator_agents
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE creator_agent_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own runs" ON creator_agent_runs
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE creator_agent_chats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own chats" ON creator_agent_chats
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
```

---

## EDGE FUNCTIONS

### 1. `creator-agent-generate` (POST)
Body : `{ description: "Je veux un agent qui ..." }`

→ Claude génère un objet `{ name, slug, emoji, color, category, system_prompt, suggested_tools, suggested_model, suggested_temperature, suggested_schedule }`.

### 2. `creator-agent-chat` (POST)
Body : `{ agent_id, session_id, message }`

→ Charge le system prompt de l'agent + l'historique de la session → Claude répond → persist user + assistant messages → return reply.

### 3. `creator-agent-run` (POST)
Body : `{ agent_id, input, trigger?: "manual" }`

→ Run one-shot : execute l'agent avec un input donné, persiste dans `creator_agent_runs`, retourne l'output. Utilisé par le bouton « Tester » et par le scheduler n8n.

---

## PAGES FRONTEND

### `/dashboard/creator-agent` — Dashboard
- Liste « Mes agents » (cards avec emoji, name, last_run, total_runs)
- Bouton **« Créer un agent »** géant
- Section **Templates Purama** (les is_template=true, filtrables par catégorie)
- Stats globales (agents créés, runs cette semaine, tokens consommés)

### `/dashboard/creator-agent/new` — Wizard de création
2 modes :
- **Mode IA** : champ texte « Décris l'agent que tu veux » → bouton « Générer » → Claude propose un agent complet → l'utilisateur peut éditer → « Créer »
- **Mode manuel** : formulaire complet (name, emoji, prompt, model, tools, schedule)

### `/dashboard/creator-agent/[id]` — Détail
3 onglets :
- **Chat** : interface de conversation avec l'agent
- **Runs** : historique des exécutions
- **Settings** : éditer la config, planning cron, partager

### `/dashboard/creator-agent/templates` — Marketplace
Liste des templates officiels Purama + agents publics partagés. Chaque card a un bouton « Cloner » qui copie l'agent dans le compte de l'utilisateur.

### `/dashboard/creator-agent/runs` — Historique global
Tous les runs de tous les agents de l'utilisateur, filtrable par agent / status / date.

---

## N8N WORKFLOW

### `Creator Agent — Scheduler` (cron toutes les 5 min)

```
[CRON 5 min]
→ Fetch agents avec is_active=true ET schedule_enabled=true
→ Pour chaque agent, vérifier si l'expression cron correspond à l'heure actuelle (+ tolérance 5 min)
→ Si oui : POST /functions/v1/creator-agent-run avec { agent_id, input: schedule_input, trigger: "cron" }
→ Le résultat se stocke dans creator_agent_runs
→ Si erreur : push notification
```

---

## TEMPLATES PRÉ-CONSTRUITS

L'agent vient avec ~10 templates prêts à cloner :

1. **🎯 Sales Closer** — Répond aux objections, suggère la prochaine action
2. **📝 Content Writer** — Rédige des articles de blog optimisés SEO
3. **📊 Daily Recap** — Résume ta journée chaque soir (cron 20h)
4. **🔍 Veille concurrence** — Surveille un secteur via Tavily, alerte en cas de news (cron daily)
5. **💼 Cold Email Writer** — Rédige des emails B2B personnalisés
6. **🎨 Brand Voice Coach** — Vérifie qu'un texte respecte ta charte de marque
7. **🌟 Idea Generator** — Génère 10 idées sur un sujet
8. **📱 Social Media Caption** — Légendes optimisées par plateforme
9. **🧠 Decision Helper** — Pour/contre + recommandation
10. **🎓 Personal Tutor** — Explique un concept avec exemples

Chaque template est inséré en DB avec `user_id=NULL` + `is_template=true`.

---

## CRITÈRES DE SUCCÈS

- [ ] Créer un agent en 30 secondes via le mode IA
- [ ] Chat fluide avec l'agent (latence < 3s)
- [ ] Templates clonables en 1 clic
- [ ] Mode autonome cron fonctionnel
- [ ] Marketplace navigable
- [ ] Stats d'usage visibles
- [ ] RLS sécurisée (users ne voient pas les agents privés des autres)
