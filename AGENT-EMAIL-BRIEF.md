# 🤖 AGENT EMAIL PURAMA — BRIEF CLAUDE CODE V1.0

## VISION
Agent IA email 100% autonome qui tourne 24/7 sur n8n + Claude API.
Il lit TOUS les emails Gmail de l'utilisateur, comprend le contexte, et :
- Répond automatiquement aux emails simples (confirmations, remerciements, questions FAQ)
- Rédige des brouillons pour les emails complexes (en attente de validation)
- Notifie l'utilisateur pour les emails urgents/importants
- Classe et catégorise automatiquement
- Apprend les préférences de réponse de l'utilisateur au fil du temps

L'utilisateur contrôle TOUT : activer/désactiver, régler le niveau d'autonomie, personnaliser le ton, exclure des contacts, définir des règles.

---

## ARCHITECTURE TECHNIQUE

### Stack
- **Frontend** : Page dans Purama AI (akasha.purama.dev) — Next.js + Tailwind + shadcn/ui
- **Backend** : Supabase (tables dédiées agent email)
- **Moteur IA** : Claude API (claude-sonnet-4-20250514) via n8n
- **Orchestrateur** : n8n (VPS 72.62.191.111, n8n.srv1286148.hstgr.cloud)
- **Email** : Gmail API via OAuth (Google OAuth déjà configuré, wildcard GOTRUE)
- **Notifications** : Push via Supabase Realtime + email digest

### Flux principal (n8n workflow)
```
[CRON toutes les 2 min] 
  → Gmail API : fetch nouveaux emails (depuis dernier check)
  → Pour chaque email :
    → Claude API analyse :
      - Catégorie (urgent/important/normal/spam/newsletter)
      - Intention (question/demande/info/relance/facturation/partenariat)
      - Action recommandée (répondre_auto/brouillon/notifier/archiver/ignorer)
      - Sentiment (positif/neutre/négatif/urgent)
    → Si répondre_auto ET autonomie >= 3 :
      → Claude API rédige réponse
      → Gmail API envoie (ou brouillon si autonomie < 4)
    → Si brouillon :
      → Gmail API crée brouillon
      → Notification "Brouillon prêt à valider"
    → Si notifier :
      → Push notification + entrée dashboard
    → Log dans Supabase (tout est tracé)
```

---

## BASE DE DONNÉES SUPABASE

### Table : `email_agent_config`
```sql
CREATE TABLE email_agent_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  is_active BOOLEAN DEFAULT true,
  autonomy_level INTEGER DEFAULT 2 CHECK (autonomy_level BETWEEN 1 AND 5),
  -- 1 = Notifie tout, ne fait rien
  -- 2 = Classe + notifie les importants
  -- 3 = Répond aux simples + brouillons pour le reste
  -- 4 = Répond à presque tout, brouillon pour complexe
  -- 5 = 100% autonome, répond à tout
  tone TEXT DEFAULT 'professionnel_amical',
  -- professionnel_strict, professionnel_amical, decontracte, custom
  custom_tone_prompt TEXT,
  signature TEXT,
  language TEXT DEFAULT 'fr',
  excluded_emails TEXT[] DEFAULT '{}',
  excluded_domains TEXT[] DEFAULT '{}',
  auto_reply_categories TEXT[] DEFAULT '{confirmation,remerciement,faq}',
  notify_categories TEXT[] DEFAULT '{urgent,important,partenariat,facturation}',
  archive_categories TEXT[] DEFAULT '{newsletter,spam,promo}',
  working_hours_only BOOLEAN DEFAULT false,
  working_hours_start TIME DEFAULT '08:00',
  working_hours_end TIME DEFAULT '19:00',
  daily_digest BOOLEAN DEFAULT true,
  daily_digest_time TIME DEFAULT '08:00',
  gmail_refresh_token TEXT, -- encrypted
  gmail_access_token TEXT, -- encrypted
  gmail_token_expiry TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  last_email_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### Table : `email_agent_logs`
```sql
CREATE TABLE email_agent_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  gmail_message_id TEXT NOT NULL,
  gmail_thread_id TEXT,
  from_email TEXT NOT NULL,
  from_name TEXT,
  subject TEXT,
  received_at TIMESTAMPTZ,
  category TEXT NOT NULL, -- urgent/important/normal/spam/newsletter/promo
  intention TEXT, -- question/demande/info/relance/facturation/partenariat
  sentiment TEXT, -- positif/neutre/negatif/urgent
  action_taken TEXT NOT NULL, -- auto_reply/draft/notify/archive/ignore
  ai_response TEXT, -- ce que l'IA a répondu ou proposé
  ai_reasoning TEXT, -- pourquoi l'IA a pris cette décision
  confidence_score FLOAT, -- 0-1
  user_approved BOOLEAN, -- null=pending, true=approved, false=rejected
  user_feedback TEXT, -- feedback utilisateur pour améliorer
  tokens_used INTEGER,
  processing_time_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### Table : `email_agent_rules`
```sql
CREATE TABLE email_agent_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  rule_name TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  priority INTEGER DEFAULT 0,
  -- Conditions (toutes optionnelles, combinées en AND)
  condition_from_email TEXT, -- regex ou exact
  condition_from_domain TEXT,
  condition_subject_contains TEXT,
  condition_body_contains TEXT,
  condition_category TEXT,
  -- Actions
  action TEXT NOT NULL, -- auto_reply/draft/notify/archive/ignore/forward/label
  action_reply_template TEXT, -- template de réponse si auto_reply
  action_forward_to TEXT, -- email si forward
  action_label TEXT, -- label Gmail si label
  action_notify_message TEXT, -- message custom de notification
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### Table : `email_agent_memory`
```sql
CREATE TABLE email_agent_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_email TEXT NOT NULL,
  contact_name TEXT,
  relationship TEXT, -- client/partenaire/fournisseur/ami/inconnu
  preferred_tone TEXT, -- ton spécifique pour ce contact
  context_notes TEXT, -- ce que l'IA sait sur cette relation
  last_interaction TIMESTAMPTZ,
  interaction_count INTEGER DEFAULT 0,
  auto_reply_ok BOOLEAN DEFAULT true, -- l'utilisateur peut bloquer l'auto-reply pour ce contact
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, contact_email)
);
```

### Table : `email_agent_templates`
```sql
CREATE TABLE email_agent_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  template_name TEXT NOT NULL,
  template_category TEXT, -- confirmation/relance/partenariat/facturation/custom
  subject_template TEXT,
  body_template TEXT NOT NULL, -- supporte {{variables}}
  is_active BOOLEAN DEFAULT true,
  usage_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### RLS Policies (toutes les tables)
```sql
-- Même pattern pour chaque table :
ALTER TABLE email_agent_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage their own config"
  ON email_agent_config FOR ALL
  USING (auth.uid() = user_id);
-- Répéter pour logs, rules, memory, templates
```

---

## PAGES FRONTEND (dans Purama AI / Akasha)

### Page principale : `/agent-email`
Dashboard avec :
- **Toggle ON/OFF** géant (activer/désactiver l'agent)
- **Niveau d'autonomie** : slider 1-5 avec description de chaque niveau
- **Stats temps réel** : emails traités aujourd'hui, réponses auto, brouillons en attente, économie de temps estimée
- **Feed activité** : dernières actions de l'agent en temps réel (avec icônes par catégorie)
- **Bouton "Brouillons à valider"** avec badge compteur

### Page : `/agent-email/settings`
- Ton de réponse (sélecteur + custom prompt)
- Signature email
- Horaires de travail
- Contacts exclus
- Domaines exclus
- Catégories auto-reply / notify / archive
- Digest quotidien ON/OFF + heure
- Connexion Gmail (OAuth)

### Page : `/agent-email/rules`
- Liste des règles custom
- Créer/éditer/supprimer des règles
- Drag & drop pour réorganiser la priorité
- Templates de règles prédéfinies (ex: "Tout email de @impots.gouv.fr → notifier urgent")

### Page : `/agent-email/memory`
- Liste des contacts connus par l'agent
- Éditer la relation, le ton, les notes
- Bloquer/débloquer l'auto-reply par contact

### Page : `/agent-email/logs`
- Historique complet de toutes les actions
- Filtres par catégorie, action, date, contact
- Pour chaque log : voir l'email original, la réponse IA, le raisonnement
- Bouton "Approuver/Rejeter" pour les brouillons
- Bouton "Feedback" pour améliorer l'IA

### Page : `/agent-email/templates`
- Gérer les templates de réponse
- Créer/éditer avec variables {{nom}}, {{entreprise}}, {{sujet}}
- Tester un template avant de l'activer

---

## WORKFLOW N8N DÉTAILLÉ

### Workflow 1 : "Email Agent - Fetch & Process"
```
Trigger: CRON toutes les 2 minutes
→ HTTP Request: Supabase - fetch tous les users avec is_active=true
→ Pour chaque user (Loop) :
  → HTTP Request: Gmail API - list messages (after: last_sync_at)
  → Pour chaque email (Loop) :
    → HTTP Request: Gmail API - get full message
    → HTTP Request: Claude API - analyse email
      System prompt:
      """
      Tu es l'agent email IA de {{user_name}}.
      Niveau d'autonomie : {{autonomy_level}}
      Ton : {{tone}}
      Règles custom : {{rules}}
      Mémoire contact : {{contact_memory}}
      
      Analyse cet email et retourne un JSON :
      {
        "category": "urgent|important|normal|spam|newsletter|promo",
        "intention": "question|demande|info|relance|facturation|partenariat|autre",
        "sentiment": "positif|neutre|negatif|urgent",
        "action": "auto_reply|draft|notify|archive|ignore",
        "confidence": 0.0-1.0,
        "reasoning": "explication courte",
        "suggested_response": "réponse proposée si applicable",
        "contact_update": { "relationship": "...", "notes": "..." }
      }
      """
    → Switch (action) :
      → auto_reply : Gmail API send + log
      → draft : Gmail API create draft + log + notification
      → notify : Supabase insert notification + log
      → archive : Gmail API archive + log
      → ignore : log only
    → HTTP Request: Supabase - update contact memory
    → HTTP Request: Supabase - update last_sync_at
```

### Workflow 2 : "Email Agent - Daily Digest"
```
Trigger: CRON quotidien (heure configurable par user)
→ Fetch users avec daily_digest=true
→ Pour chaque user :
  → Fetch logs des dernières 24h
  → Claude API : résumé intelligent du jour
  → Gmail API : envoyer le digest à l'utilisateur
```

### Workflow 3 : "Email Agent - Draft Approval Webhook"
```
Trigger: Webhook (appelé depuis le frontend quand user approuve/rejette)
→ Si approved : Gmail API send le brouillon
→ Si rejected : log le feedback pour amélioration
→ Update email_agent_memory avec le feedback
```

---

## PROMPT SYSTÈME CLAUDE API (pour l'analyse)

```xml
<system>
Tu es un agent email IA ultra-intelligent au service de {{user_name}}.

<contexte>
- Niveau d'autonomie : {{autonomy_level}}/5
- Ton demandé : {{tone}}
- Langue : {{language}}
- Signature : {{signature}}
</contexte>

<regles_utilisateur>
{{custom_rules_json}}
</regles_utilisateur>

<memoire_contact>
{{contact_memory_json}}
</memoire_contact>

<regles_autonomie>
Niveau 1 : Tu NOTIFIES tout. Tu ne réponds JAMAIS automatiquement.
Niveau 2 : Tu classes + notifies les importants. Tu ne réponds pas.
Niveau 3 : Tu réponds aux emails simples (confirmations, remerciements, FAQ simples). Brouillon pour le reste.
Niveau 4 : Tu réponds à presque tout. Brouillon uniquement pour les décisions importantes ou financières.
Niveau 5 : Tu gères TOUT. Tu ne fais un brouillon que si le risque est critique (juridique, financier majeur).
</regles_autonomie>

<instructions>
1. Analyse l'email reçu
2. Vérifie les règles custom en priorité (si match → appliquer directement)
3. Catégorise et détermine l'intention
4. Décide de l'action selon le niveau d'autonomie
5. Si réponse : rédige dans le ton demandé, avec la signature
6. Met à jour la mémoire du contact si nouvelles infos
7. Retourne UNIQUEMENT un JSON valide, rien d'autre
</instructions>

<format_reponse>
{
  "category": "urgent|important|normal|spam|newsletter|promo",
  "intention": "question|demande|info|relance|facturation|partenariat|candidature|support|autre",
  "sentiment": "positif|neutre|negatif|urgent",
  "action": "auto_reply|draft|notify|archive|ignore",
  "confidence": 0.0-1.0,
  "reasoning": "explication en 1-2 phrases",
  "suggested_response": "réponse complète si auto_reply ou draft, null sinon",
  "suggested_subject": "objet de la réponse si différent de Re: original",
  "contact_update": {
    "relationship": "client|partenaire|fournisseur|institution|ami|inconnu",
    "notes": "info nouvelle apprise sur ce contact"
  },
  "urgency_score": 1-10,
  "tags": ["tag1", "tag2"]
}
</format_reponse>
</system>
```

---

## SÉCURITÉ

- Tokens Gmail chiffrés dans Supabase (pgcrypto)
- RLS sur toutes les tables
- Refresh token rotation
- Rate limiting sur les webhooks
- Logs de toutes les actions pour audit
- L'utilisateur peut supprimer TOUTES ses données (RGPD)
- Pas d'envoi auto d'emails avec pièces jointes (sécurité)
- Pas d'accès aux emails marqués "confidential" par défaut

---

## UX RÉVOLUTIONNAIRE

- **Onboarding en 30 secondes** : connecte Gmail → choisis ton niveau → c'est parti
- **Feedback loop** : chaque action peut être approuvée/rejetée → l'agent apprend
- **Transparence totale** : l'utilisateur voit TOUT ce que l'agent fait et pourquoi
- **Kill switch** : un bouton pour tout arrêter instantanément
- **Mode vacances** : réponse auto personnalisée pendant les absences
- **Stats gamifiées** : "Ton agent t'a fait gagner 2h47 cette semaine"

---

## ENV VARS REQUISES (dans .env.local, auto-créé par CLAUDE.md)

```
NEXT_PUBLIC_SUPABASE_URL=https://auth.purama.dev
NEXT_PUBLIC_SUPABASE_ANON_KEY=<from CLAUDE.md>
SUPABASE_SERVICE_ROLE_KEY=<from CLAUDE.md>
ANTHROPIC_API_KEY=<from CLAUDE.md>
GOOGLE_CLIENT_ID=<from CLAUDE.md>
GOOGLE_CLIENT_SECRET=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
GMAIL_SCOPES=https://www.googleapis.com/auth/gmail.modify
NEXT_PUBLIC_APP_URL=https://akasha.purama.dev
```

---

## INTÉGRATION PURAMA AI (Akasha)

Ce module s'ajoute à Akasha comme une section dédiée dans le menu :
- 🤖 Agent Email (avec badge "actif/inactif")
- Accessible depuis le dashboard principal
- Notifications intégrées au système de notifications Akasha existant

---

## CRITÈRES DE SUCCÈS

- [ ] Agent tourne 24/7 sans interruption
- [ ] Temps de réponse < 30 secondes après réception email
- [ ] Précision catégorisation > 90%
- [ ] 0 email important manqué
- [ ] Interface intuitive, configurable en < 1 minute
- [ ] Feedback loop fonctionnel (l'agent s'améliore)
- [ ] RGPD compliant (suppression données)
- [ ] Fonctionne pour tout utilisateur Purama (pas juste Tissma)
