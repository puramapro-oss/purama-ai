# 🤝 AGENT PARTENARIAT IA PURAMA — BRIEF CLAUDE CODE V1.0

## VISION
Agent IA partenariat 100% autonome 24/7 qui gère TOUT le programme partenariat Purama :
- Trouve des partenaires potentiels (influenceurs, sites, associations, médias, commerces)
- Envoie des emails de prospection personnalisés automatiquement
- Relance intelligemment (timing + contenu adapté)
- Génère et envoie les contrats de partenariat (pré-signés par l'utilisateur)
- Suit les performances de chaque partenaire (clics, inscrits, CA généré)
- Gère les commissions (50% 1er paiement + 10% récurrent)
- Envoie les kits partenaires (lien téléchargement)
- Accompagne les partenaires via un "Claude Partner Coach"
- L'utilisateur configure et l'agent fait TOUT

---

## ARCHITECTURE TECHNIQUE

### Stack
- **Frontend** : Pages dans Purama AI (akasha.purama.dev)
- **Backend** : Supabase
- **Moteur IA** : Claude API via n8n
- **Orchestrateur** : n8n (VPS 72.62.191.111)
- **Email** : Resend API (prospection + relances + contrats)
- **Contrats** : DocuSeal (self-hosted, signatures électroniques)
- **Recherche** : Tavily API (recherche web de prospects) + Claude API
- **Notifications** : Push PWA + Email (système partagé agent_notifications)

---

## BASE DE DONNÉES SUPABASE

### Table : `partner_agent_config`
```sql
CREATE TABLE partner_agent_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  is_active BOOLEAN DEFAULT true,
  
  -- Identité expéditeur
  sender_name TEXT NOT NULL, -- "Tissma Dornier" ou "Équipe Purama"
  sender_email TEXT NOT NULL, -- email d'envoi
  sender_title TEXT, -- "Fondateur de Purama"
  company_name TEXT DEFAULT 'Purama',
  
  -- Signature pré-enregistrée
  signature_image_url TEXT, -- image de la signature manuscrite
  signature_name TEXT, -- nom complet pour signature
  signature_title TEXT, -- titre pour signature
  
  -- Prospection
  daily_outreach_limit INTEGER DEFAULT 20, -- max emails/jour
  outreach_hours_start TIME DEFAULT '09:00',
  outreach_hours_end TIME DEFAULT '18:00',
  outreach_days TEXT[] DEFAULT '{MO,TU,WE,TH,FR}',
  
  -- Relances
  relance_1_delay_days INTEGER DEFAULT 3,
  relance_2_delay_days INTEGER DEFAULT 7,
  relance_3_delay_days INTEGER DEFAULT 14,
  max_relances INTEGER DEFAULT 3,
  
  -- Commissions
  commission_first_payment DECIMAL(4,2) DEFAULT 50.00, -- %
  commission_recurring DECIMAL(4,2) DEFAULT 10.00, -- %
  
  -- Contrat
  contract_template_id TEXT, -- DocuSeal template ID
  auto_send_contract BOOLEAN DEFAULT true, -- envoie contrat quand prospect accepte
  
  -- Ciblage
  target_niches TEXT[], -- ['fitness', 'finance', 'tech', 'ecologie', 'juridique']
  target_min_followers INTEGER DEFAULT 1000,
  target_countries TEXT[] DEFAULT '{FR}',
  target_languages TEXT[] DEFAULT '{fr}',
  
  -- Ton
  outreach_tone TEXT DEFAULT 'professionnel_enthousiaste',
  custom_tone_prompt TEXT,
  
  require_approval_new_prospect BOOLEAN DEFAULT false, -- true = valider chaque prospect avant envoi
  require_approval_contract BOOLEAN DEFAULT true, -- true = valider avant envoi contrat
  
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### Table : `partner_prospects`
```sql
CREATE TABLE partner_prospects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  
  -- Identité
  name TEXT NOT NULL,
  email TEXT,
  website TEXT,
  social_links JSONB, -- {instagram, youtube, tiktok, twitter, linkedin}
  type TEXT, -- 'influencer', 'website', 'association', 'media', 'commerce', 'other'
  niche TEXT, -- 'fitness', 'finance', 'tech', etc.
  
  -- Métriques
  followers_count INTEGER,
  monthly_visitors INTEGER,
  engagement_rate DECIMAL(5,2),
  audience_country TEXT,
  
  -- Pipeline
  status TEXT DEFAULT 'identified',
  -- identified → contacted → relance_1 → relance_2 → relance_3 → 
  -- interested → contract_sent → contract_signed → active → inactive → rejected
  
  -- Prospection
  first_contact_at TIMESTAMPTZ,
  last_contact_at TIMESTAMPTZ,
  relance_count INTEGER DEFAULT 0,
  next_action_at TIMESTAMPTZ, -- quand la prochaine relance est prévue
  
  -- Réponses
  has_replied BOOLEAN DEFAULT false,
  reply_sentiment TEXT, -- positif, neutre, negatif
  reply_summary TEXT, -- résumé IA de la réponse
  
  -- Contrat
  contract_sent_at TIMESTAMPTZ,
  contract_signed_at TIMESTAMPTZ,
  contract_url TEXT, -- DocuSeal URL
  
  -- Scoring IA
  ai_score INTEGER, -- 0-100 potentiel partenaire
  ai_reasoning TEXT,
  
  -- Notes
  notes TEXT,
  tags TEXT[],
  
  -- Source
  source TEXT, -- 'ai_search', 'manual', 'referral', 'inbound'
  found_by_ai BOOLEAN DEFAULT false,
  
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### Table : `partner_emails`
```sql
CREATE TABLE partner_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  prospect_id UUID REFERENCES partner_prospects(id) ON DELETE CASCADE,
  
  type TEXT NOT NULL, -- 'outreach', 'relance_1', 'relance_2', 'relance_3', 'contract', 'welcome', 'custom'
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  body_text TEXT,
  
  -- Tracking
  sent_at TIMESTAMPTZ,
  delivered BOOLEAN,
  opened BOOLEAN DEFAULT false,
  opened_at TIMESTAMPTZ,
  clicked BOOLEAN DEFAULT false,
  clicked_at TIMESTAMPTZ,
  replied BOOLEAN DEFAULT false,
  replied_at TIMESTAMPTZ,
  bounced BOOLEAN DEFAULT false,
  
  -- Resend
  resend_message_id TEXT,
  
  -- Approval
  status TEXT DEFAULT 'draft', -- draft, pending_approval, approved, sent, failed
  approved_at TIMESTAMPTZ,
  
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### Table : `partner_active`
```sql
CREATE TABLE partner_active (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  prospect_id UUID REFERENCES partner_prospects(id),
  
  -- Partenaire actif
  partner_name TEXT NOT NULL,
  partner_email TEXT NOT NULL,
  referral_code TEXT UNIQUE NOT NULL, -- code unique de parrainage
  referral_link TEXT NOT NULL, -- lien avec tracking
  
  -- Performances
  total_clicks INTEGER DEFAULT 0,
  total_signups INTEGER DEFAULT 0,
  total_conversions INTEGER DEFAULT 0,
  total_revenue_generated DECIMAL(12,2) DEFAULT 0,
  total_commission_earned DECIMAL(12,2) DEFAULT 0,
  total_commission_paid DECIMAL(12,2) DEFAULT 0,
  
  -- Niveau
  level TEXT DEFAULT 'starter', -- starter, silver, gold, platinum, diamond
  -- starter: 0-49 referrals, silver: 50-149, gold: 150-249, platinum: 250-499, diamond: 500+
  
  -- Récompenses
  equity_granted BOOLEAN DEFAULT false, -- à 250 referrals
  hereditary_commissions BOOLEAN DEFAULT false, -- à 500 referrals
  tesla_reward BOOLEAN DEFAULT false, -- à 500 referrals
  
  is_active BOOLEAN DEFAULT true,
  joined_at TIMESTAMPTZ DEFAULT now(),
  last_activity_at TIMESTAMPTZ,
  
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### Table : `partner_commissions`
```sql
CREATE TABLE partner_commissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  partner_id UUID REFERENCES partner_active(id),
  
  type TEXT NOT NULL, -- 'first_payment', 'recurring'
  amount DECIMAL(12,2) NOT NULL,
  percentage DECIMAL(4,2) NOT NULL,
  source_payment_id TEXT, -- Stripe payment ID
  source_customer_email TEXT,
  source_app TEXT, -- quelle app Purama
  
  status TEXT DEFAULT 'pending', -- pending, approved, paid
  paid_at TIMESTAMPTZ,
  payment_method TEXT, -- virement, stripe_connect, paypal
  
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### Table : `partner_email_templates`
```sql
CREATE TABLE partner_email_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  
  name TEXT NOT NULL,
  type TEXT NOT NULL, -- 'outreach', 'relance_1', 'relance_2', 'relance_3', 'welcome', 'contract'
  target_type TEXT, -- 'influencer', 'website', 'association', etc.
  target_niche TEXT, -- 'fitness', 'finance', etc.
  
  subject_template TEXT NOT NULL,
  body_template TEXT NOT NULL, -- HTML avec {{variables}}
  
  -- Variables disponibles : {{partner_name}}, {{partner_website}}, {{niche}},
  -- {{company_name}}, {{sender_name}}, {{referral_link}}, {{commission_rate}},
  -- {{app_name}}, {{app_description}}, {{unique_selling_point}}
  
  performance_score DECIMAL(5,2), -- taux de réponse de ce template
  times_used INTEGER DEFAULT 0,
  
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

---

## WORKFLOWS N8N

### Workflow 1 : "Partner Agent - Find Prospects" (CRON quotidien)
```
[CRON tous les jours à 7h]
→ Fetch users actifs
→ Pour chaque user :
  → Tavily API : recherche prospects par niche
    Queries : "influenceur {{niche}} français email contact",
              "blog {{niche}} france partenariat",
              "association {{niche}} france"
  → Claude API : analyser résultats + scorer chaque prospect
    System: "Tu es un expert en développement de partenariats.
    Analyse ces résultats et identifie les meilleurs prospects.
    Score chacun de 0-100 basé sur : taille audience, pertinence niche,
    engagement, facilité de contact. Retourne un JSON."
  → Insert nouveaux prospects dans partner_prospects
  → Si require_approval_new_prospect :
    → Notification "5 nouveaux prospects trouvés. [Voir et approuver]"
  → Sinon : marquer comme ready_to_contact
```

### Workflow 2 : "Partner Agent - Outreach" (CRON toutes les 30 min pendant heures ouvrées)
```
[CRON toutes les 30 min, 9h-18h, lun-ven]
→ Fetch users actifs
→ Pour chaque user :
  → Check quota journalier (daily_outreach_limit)
  → Fetch prospects status='identified' ou status='ready_to_contact'
    ORDER BY ai_score DESC LIMIT remaining_quota
  → Pour chaque prospect :
    → Claude API : rédiger email personnalisé
      System: "Tu rédiges un email de prospection partenariat pour {{company_name}}.
      Prospect : {{prospect_info}}.
      Ton : {{outreach_tone}}.
      L'email doit être court (5-8 lignes), personnalisé (mentionne leur contenu),
      et proposer clairement le partenariat avec les avantages
      ({{commission_rate}}% commission, kit gratuit, coach IA).
      Objet accrocheur et unique. Aucun spam, aucun template générique."
    → Resend API : envoyer email
    → Update prospect status → 'contacted'
    → Log dans partner_emails
```

### Workflow 3 : "Partner Agent - Smart Relances" (CRON quotidien)
```
[CRON tous les jours à 10h]
→ Fetch prospects où next_action_at <= now() ET has_replied=false
→ Pour chaque :
  → Claude API : rédiger relance contextuelle
    - Relance 1 : angle différent, plus court, valeur ajoutée
    - Relance 2 : preuve sociale, résultats d'autres partenaires
    - Relance 3 : dernière chance, offre exclusive limitée
  → Resend API : envoyer
  → Update status + next_action_at
  → Si relance_count >= max_relances → status='rejected'
```

### Workflow 4 : "Partner Agent - Reply Handler" (CRON toutes les 5 min)
```
[CRON toutes les 5 min]
→ Check inbox (via Gmail API ou Resend webhooks) pour réponses aux emails de prospection
→ Pour chaque réponse :
  → Claude API : analyser la réponse
    { "sentiment": "positif|neutre|negatif",
      "intent": "interested|question|not_interested|spam",
      "summary": "...",
      "suggested_action": "send_contract|reply_answer|reply_convince|close|escalate" }
  → Si interested :
    → Status → 'interested'
    → Si auto_send_contract :
      → DocuSeal API : générer contrat pré-signé
      → Resend : envoyer contrat + welcome info
    → Sinon : Notification "[Prospect] est intéressé ! [Envoyer contrat] [Répondre]"
  → Si question :
    → Claude API : rédiger réponse
    → Envoyer ou soumettre pour approbation
  → Si not_interested :
    → Status → 'rejected', réponse polie automatique
```

### Workflow 5 : "Partner Agent - Contract & Onboarding" (Webhook)
```
[Webhook DocuSeal : contrat signé]
→ Update prospect → status='contract_signed'
→ Créer entrée partner_active avec referral_code unique
→ Générer lien de parrainage
→ Claude API : rédiger email de bienvenue personnalisé
  - Lien dashboard partenaire
  - Kit téléchargement (visuels, textes, vidéos)
  - Guide démarrage rapide
  - Accès Claude Partner Coach
→ Resend : envoyer welcome pack
→ Notification : "Nouveau partenaire signé : [Nom] !"
```

### Workflow 6 : "Partner Agent - Performance Report" (CRON hebdo)
```
[CRON tous les lundis à 9h]
→ Pour chaque user :
  → Fetch stats semaine : nouveaux prospects, emails envoyés,
    réponses, contrats signés, clics, inscriptions, CA généré
  → Claude API : analyse + recommandations
  → Email rapport hebdomadaire
  → Check niveaux partenaires (upgrades silver→gold, etc.)
  → Si upgrade : email félicitations + nouvelles récompenses
```

---

## PAGES FRONTEND

### `/agent-partenariat` — Dashboard
- **Toggle ON/OFF**
- **Pipeline visuel** : Kanban (identifié → contacté → intéressé → contrat → actif)
- **Stats temps réel** : prospects trouvés, emails envoyés, taux réponse, taux conversion
- **Top partenaires** (par CA généré)
- **Commissions en attente** de paiement
- **Actions requises** (contrats à valider, réponses à traiter)

### `/agent-partenariat/prospects`
- Liste complète avec filtres (statut, niche, score, date)
- Pour chaque : profil, historique emails, score IA, actions
- Ajout manuel de prospects
- Import CSV
- Boutons : [Contacter] [Envoyer contrat] [Rejeter]

### `/agent-partenariat/partners`
- Liste partenaires actifs
- Stats par partenaire (clics, inscrits, CA, commissions)
- Niveaux (starter → diamond) avec progression
- Paiement des commissions

### `/agent-partenariat/emails`
- Tous les emails envoyés/reçus
- Métriques : ouverture, clic, réponse
- Templates : créer/éditer
- A/B testing automatique

### `/agent-partenariat/settings`
- Identité expéditeur
- Signature uploadée
- Limites quotidiennes
- Délais de relance
- Taux de commission
- Niches ciblées
- Template contrat (DocuSeal)
- Ton de communication

### `/agent-partenariat/contract`
- Upload signature manuscrite (image)
- Preview contrat avec signature intégrée
- Historique contrats envoyés/signés

---

## SIGNATURE PRÉ-ENREGISTRÉE

L'utilisateur upload UNE FOIS son image de signature.
Elle est stockée dans Supabase Storage.
DocuSeal l'intègre automatiquement dans chaque contrat avant envoi.
Le prospect n'a plus qu'à signer de son côté → contrat complet.

```
Flux signature :
1. User upload image signature → Supabase Storage
2. Agent génère contrat DocuSeal
3. Signature user auto-appliquée côté "Purama"
4. Prospect reçoit le contrat → signe → terminé
```

---

## ENV VARS REQUISES

```
# Déjà dans CLAUDE.md
NEXT_PUBLIC_SUPABASE_URL=https://auth.purama.dev
SUPABASE_SERVICE_ROLE_KEY=<from CLAUDE.md>
ANTHROPIC_API_KEY=<from CLAUDE.md>

# Nouvelles
RESEND_API_KEY=<à obtenir>
TAVILY_API_KEY=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
DOCUSEAL_API_KEY=<from existing setup>
DOCUSEAL_URL=<DocuSeal self-hosted URL>

# Partagé avec Agent Email
VAPID_PUBLIC_KEY=<généré>
VAPID_PRIVATE_KEY=<généré>
```

---

## CRITÈRES DE SUCCÈS

- [ ] Trouve 10+ prospects qualifiés par jour automatiquement
- [ ] Emails personnalisés (pas de spam générique)
- [ ] Taux de réponse > 15%
- [ ] Relances intelligentes avec timing optimal
- [ ] Contrat pré-signé envoyé en 1 clic
- [ ] Onboarding partenaire 100% automatisé
- [ ] Suivi performances temps réel
- [ ] Commissions calculées automatiquement
- [ ] Pipeline visuel clair
- [ ] Tout configurable par l'utilisateur
