# ⚖️ AGENT JURIDIQUE IA PURAMA — BRIEF CLAUDE CODE V1.0

## VISION
Agent juridique IA 100% autonome 24/7, le plus puissant assistant juridique au monde.
Il remplace un cabinet d'avocats à 300€/h. Il connaît TOUT le droit français,
européen et international. Il génère, analyse, négocie, surveille, alerte, défend.

L'utilisateur a un avocat virtuel disponible 24/7 qui :
- Répond à TOUTE question juridique (droit des affaires, travail, fiscal, pénal, immobilier, famille, consommation, RGPD, propriété intellectuelle, droit numérique)
- Génère des documents juridiques complets et conformes (contrats, CGV, CGU, statuts, PV, mises en demeure, lettres, conclusions)
- Analyse et vérifie des contrats avant signature (détecte les clauses abusives, risques, manques)
- Monte des dossiers complexes (création entreprise, licenciement, contentieux, propriété intellectuelle, redressement)
- Surveille les changements de loi et alerte automatiquement
- Relance les impayés automatiquement (mise en demeure → injonction de payer)
- Gère les délais de prescription et deadlines juridiques
- Connaît TOUTES les techniques d'avocats (montages, stratégies, jurisprudence, argumentation)
- Signature électronique intégrée (DocuSeal)
- Envoi recommandé (AR24 quand disponible)

---

## ARCHITECTURE TECHNIQUE

### Stack
- **Frontend** : Pages dans Purama AI (akasha.purama.dev)
- **Backend** : Supabase
- **Moteur IA** : Claude API (claude-sonnet-4-20250514) — le plus puissant pour le raisonnement juridique
- **Orchestrateur** : n8n (VPS 72.62.191.111)
- **Signatures** : DocuSeal (self-hosted, http://72.62.191.111:3001)
- **Recommandé** : AR24 (quand compte pro activé)
- **Recherche juridique** : Tavily API (Légifrance, jurisprudence, doctrine)
- **Notifications** : Push PWA + Email (système partagé agent_notifications)
- **Stockage docs** : Supabase Storage (tous documents juridiques chiffrés)

---

## BASE DE DONNÉES SUPABASE

### Table : `legal_agent_config`
```sql
CREATE TABLE legal_agent_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  is_active BOOLEAN DEFAULT true,

  -- Profil juridique utilisateur
  user_type TEXT DEFAULT 'particulier', -- particulier, auto_entrepreneur, sasu, sas, sarl, eurl, association, sci
  company_name TEXT,
  siren TEXT,
  siret TEXT,
  naf_code TEXT,
  activity_description TEXT,
  creation_date DATE,
  employee_count INTEGER DEFAULT 0,

  -- Adresse
  address TEXT,
  postal_code TEXT,
  city TEXT,
  country TEXT DEFAULT 'FR',

  -- Préférences
  expertise_areas TEXT[] DEFAULT '{commercial,travail,fiscal,rgpd,immobilier}',
  language TEXT DEFAULT 'fr',
  tone TEXT DEFAULT 'professionnel', -- professionnel, accessible, technique
  auto_veille BOOLEAN DEFAULT true, -- veille juridique automatique
  auto_relance_impayes BOOLEAN DEFAULT false, -- relance impayés auto
  notify_law_changes BOOLEAN DEFAULT true,
  notify_deadlines BOOLEAN DEFAULT true,
  notify_prescription BOOLEAN DEFAULT true,

  -- DocuSeal
  docuseal_api_key TEXT DEFAULT 'pKKLmvPpMi6SmX4FyjuwdFEky4K9tMUEoGP7oZYiGFZ',
  signature_image_url TEXT,

  -- AR24
  ar24_api_key TEXT, -- quand disponible

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### Table : `legal_documents`
```sql
CREATE TABLE legal_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Document
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  -- Types: contrat_travail, contrat_commercial, contrat_prestation, cdi, cdd,
  -- cgv, cgu, mentions_legales, politique_confidentialite, statuts_sasu,
  -- statuts_sas, statuts_sarl, statuts_sci, statuts_association,
  -- pv_ag, pv_ca, pv_nomination, pv_non_remuneration, pv_approbation_comptes,
  -- mise_en_demeure, lettre_resiliation, lettre_contestation, lettre_reclamation,
  -- conclusions, memoire, requete, assignation, injonction_payer,
  -- bail_habitation, bail_commercial, bail_professionnel,
  -- convention_cca, nda, pacte_associes, cession_parts,
  -- reglement_interieur, charte_informatique, duer,
  -- declaration_cnil, pia, registre_traitement,
  -- brevet, marque, licence, cession_pi,
  -- testament, donation, mandat_protection,
  -- custom

  category TEXT, -- affaires, travail, fiscal, immobilier, famille, penal, pi, rgpd, consommation
  status TEXT DEFAULT 'draft', -- draft, review, final, signed, sent, archived

  -- Contenu
  content_html TEXT NOT NULL, -- document complet en HTML
  content_pdf_url TEXT, -- PDF généré
  content_word_url TEXT, -- Word généré

  -- Contexte de génération
  user_brief TEXT, -- ce que l'utilisateur a demandé
  ai_analysis TEXT, -- analyse IA du contexte
  variables JSONB, -- variables utilisées {{nom}}, {{date}}, etc.

  -- Signature
  requires_signature BOOLEAN DEFAULT false,
  docuseal_submission_id TEXT,
  signed_at TIMESTAMPTZ,
  signed_pdf_url TEXT,
  signers JSONB, -- [{name, email, role, signed_at}]

  -- Envoi
  sent_via TEXT, -- email, ar24, courrier
  sent_at TIMESTAMPTZ,
  ar24_tracking_id TEXT,

  -- Versioning
  version INTEGER DEFAULT 1,
  parent_document_id UUID, -- pour les révisions
  changes_summary TEXT, -- résumé des modifications

  -- Tags
  tags TEXT[],
  related_contact TEXT, -- nom de la contrepartie
  related_contact_email TEXT,

  expires_at DATE, -- date d'expiration du document
  renewal_alert_days INTEGER, -- alerte X jours avant expiration

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### Table : `legal_cases`
```sql
CREATE TABLE legal_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Dossier
  title TEXT NOT NULL,
  case_number TEXT, -- référence interne
  type TEXT NOT NULL,
  -- Types: creation_entreprise, contentieux_commercial, litige_travail,
  -- recouvrement, propriete_intellectuelle, rgpd_conformite,
  -- redressement_fiscal, controle_urssaf, bail, divorce,
  -- succession, infraction, procedure_collective, custom

  status TEXT DEFAULT 'open', -- open, in_progress, waiting, won, lost, settled, closed
  priority TEXT DEFAULT 'normal', -- low, normal, high, urgent

  -- Parties
  parties JSONB NOT NULL, -- [{name, role, email, phone, address, siren, avocat}]
  -- roles: demandeur, defendeur, tiers, temoin, expert

  -- Faits et chronologie
  facts TEXT, -- résumé des faits
  timeline JSONB, -- [{date, event, description, documents:[]}]

  -- Stratégie juridique (générée par IA)
  ai_analysis TEXT, -- analyse complète du dossier
  ai_strategy TEXT, -- stratégie recommandée
  ai_arguments TEXT[], -- arguments principaux
  ai_risks TEXT[], -- risques identifiés
  ai_jurisprudence JSONB, -- [{reference, court, date, summary, relevance}]
  ai_success_probability INTEGER, -- 0-100
  ai_estimated_amount DECIMAL(12,2), -- montant estimé si applicable

  -- Deadlines
  deadlines JSONB, -- [{date, description, type, is_completed, reminder_days}]
  prescription_date DATE, -- date de prescription
  prescription_type TEXT, -- type de prescription

  -- Montants
  amount_claimed DECIMAL(12,2),
  amount_obtained DECIMAL(12,2),
  costs DECIMAL(12,2), -- frais engagés

  -- Documents liés
  document_ids UUID[],

  notes TEXT,
  tags TEXT[],

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### Table : `legal_veille`
```sql
CREATE TABLE legal_veille (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Veille
  title TEXT NOT NULL,
  type TEXT NOT NULL, -- new_law, law_change, jurisprudence, regulation, deadline, alert
  category TEXT, -- fiscal, travail, commercial, rgpd, etc.
  severity TEXT DEFAULT 'info', -- info, warning, action_required, urgent

  -- Contenu
  summary TEXT NOT NULL, -- résumé clair en langage simple
  impact TEXT, -- impact concret sur l'utilisateur
  action_required TEXT, -- ce que l'utilisateur doit faire
  source_url TEXT,
  source_name TEXT, -- Légifrance, JORF, Cour de Cassation, etc.
  reference TEXT, -- numéro de loi/décret/arrêt

  -- Dates
  effective_date DATE, -- date d'entrée en vigueur
  deadline DATE, -- deadline pour se conformer

  -- Status
  is_read BOOLEAN DEFAULT false,
  is_actioned BOOLEAN DEFAULT false,
  notification_sent BOOLEAN DEFAULT false,

  created_at TIMESTAMPTZ DEFAULT now()
);
```

### Table : `legal_impayes`
```sql
CREATE TABLE legal_impayes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Débiteur
  debtor_name TEXT NOT NULL,
  debtor_email TEXT,
  debtor_address TEXT,
  debtor_siren TEXT,

  -- Créance
  invoice_number TEXT,
  invoice_date DATE,
  due_date DATE,
  amount DECIMAL(12,2) NOT NULL,
  interest_rate DECIMAL(4,2) DEFAULT 11.62, -- taux légal + majoration

  -- Procédure de recouvrement automatique
  status TEXT DEFAULT 'overdue',
  -- overdue → reminder_1 → reminder_2 → mise_en_demeure → injonction → huissier → closed

  -- Étapes automatiques
  reminder_1_sent_at TIMESTAMPTZ, -- relance amiable J+7
  reminder_1_doc_id UUID,
  reminder_2_sent_at TIMESTAMPTZ, -- relance ferme J+15
  reminder_2_doc_id UUID,
  mise_en_demeure_sent_at TIMESTAMPTZ, -- LRAR J+30
  mise_en_demeure_doc_id UUID,
  mise_en_demeure_ar24_id TEXT,
  injonction_prepared_at TIMESTAMPTZ, -- requête tribunal J+45
  injonction_doc_id UUID,

  -- Résolution
  paid_at TIMESTAMPTZ,
  paid_amount DECIMAL(12,2),
  settled BOOLEAN DEFAULT false,
  settlement_terms TEXT,

  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### Table : `legal_chat_history`
```sql
CREATE TABLE legal_chat_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,

  session_id UUID NOT NULL,
  role TEXT NOT NULL, -- user, assistant
  content TEXT NOT NULL,

  -- Contexte
  category TEXT, -- domaine juridique détecté
  documents_referenced UUID[], -- documents mentionnés
  cases_referenced UUID[], -- dossiers mentionnés
  sources_cited JSONB, -- [{type, reference, url}] lois, articles, jurisprudence

  -- Qualité
  confidence FLOAT, -- 0-1
  disclaimer_shown BOOLEAN DEFAULT false,

  created_at TIMESTAMPTZ DEFAULT now()
);
```

### Table : `legal_templates`
```sql
CREATE TABLE legal_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  type TEXT NOT NULL, -- même types que legal_documents
  category TEXT,
  description TEXT,
  content_template TEXT NOT NULL, -- HTML avec {{variables}}
  variables_schema JSONB, -- [{name, label, type, required, default}]
  is_default BOOLEAN DEFAULT false, -- templates Purama pré-construits
  usage_count INTEGER DEFAULT 0,

  created_at TIMESTAMPTZ DEFAULT now()
);
```

### RLS toutes tables
```sql
ALTER TABLE legal_agent_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own data" ON legal_agent_config FOR ALL USING (auth.uid() = user_id);
-- Répéter pour TOUTES les tables legal_*
```

---

## WORKFLOWS N8N

### Workflow 1 : "Legal Agent - Veille Juridique" (CRON quotidien)
```
[CRON tous les jours à 7h]
→ Pour chaque user avec auto_veille=true :
  → Tavily API : chercher dans les sources juridiques
    Queries adaptées au profil :
    - "nouvelle loi {naf_code} {year}" 
    - "journal officiel décret entreprise"
    - "jurisprudence {expertise_areas}"
    - "RGPD nouvelle obligation"
    - "droit du travail modification"
  → Claude API : analyser pertinence pour cet utilisateur
    System: "Tu es un juriste veilleur spécialisé.
    Profil utilisateur : {{user_profile}}.
    Analyse ces résultats et identifie UNIQUEMENT ce qui impacte
    concrètement cet utilisateur. Pour chaque élément pertinent :
    résumé en langage simple, impact concret, action requise."
  → Insert dans legal_veille les éléments pertinents
  → Si action_required → Notification "⚖️ Nouvelle obligation : {{title}}"
  → Si urgent → Notification priorité haute
```

### Workflow 2 : "Legal Agent - Recouvrement Auto" (CRON quotidien)
```
[CRON tous les jours à 9h]
→ Fetch users avec auto_relance_impayes=true
→ Fetch legal_impayes par statut et délais :

  → Overdue + J+7 → Relance amiable :
    Claude API rédige email courtois rappelant la facture
    → Resend API envoie → status='reminder_1'

  → reminder_1 + J+15 → Relance ferme :
    Claude API rédige email plus ferme avec mention pénalités
    → Resend API envoie → status='reminder_2'

  → reminder_2 + J+30 → Mise en demeure :
    Claude API génère mise en demeure LRAR complète
    (articles L441-10, L441-6 Code de commerce,
    intérêts de retard, indemnité forfaitaire 40€)
    → Générer PDF → DocuSeal signature user
    → AR24 envoi recommandé (ou email si AR24 pas dispo)
    → status='mise_en_demeure'

  → mise_en_demeure + J+45 → Préparation injonction de payer :
    Claude API prépare requête en injonction de payer
    (formulaire CERFA, pièces justificatives)
    → Notification "Injonction de payer prête. [Voir] [Envoyer au tribunal]"
    → status='injonction'
```

### Workflow 3 : "Legal Agent - Deadline Watcher" (CRON quotidien)
```
[CRON tous les jours à 8h]
→ Fetch tous les deadlines (legal_cases + legal_documents + legal_impayes + legal_veille)
→ Calculer les alertes :
  - J-30 : rappel anticipé
  - J-14 : rappel
  - J-7 : alerte
  - J-3 : urgence
  - J-1 : dernière chance
  - Prescription approche : CRITIQUE
→ Notification avec urgence croissante
→ Pour les documents qui expirent : proposer renouvellement auto
```

### Workflow 4 : "Legal Agent - Document Renewal" (CRON mensuel)
```
[CRON le 1er de chaque mois]
→ Fetch documents avec expires_at dans les 60 prochains jours
→ Pour chaque :
  → Claude API : vérifier si la loi a changé depuis la dernière version
  → Si changement : générer nouvelle version mise à jour
  → Notification : "Vos CGV expirent dans 45 jours. Version mise à jour prête. [Voir] [Signer]"
```

### Workflow 5 : "Legal Agent - Conformité RGPD" (CRON trimestriel)
```
[CRON tous les 3 mois]
→ Pour chaque user avec 'rgpd' dans expertise_areas :
  → Claude API : audit RGPD automatique
    - Registre des traitements à jour ?
    - PIA nécessaire ?
    - Sous-traitants conformes ?
    - Mentions d'information complètes ?
    - Délégué à la protection des données nécessaire ?
  → Générer rapport de conformité
  → Notification : "Audit RGPD trimestriel terminé. Score : {{score}}/100. [Voir rapport]"
```

---

## PAGES FRONTEND

### `/agent-juridique` — Dashboard
- **Toggle ON/OFF**
- **Chat juridique** principal (conversation avec l'avocat IA)
- **Veille juridique** : dernières alertes + changements de loi
- **Dossiers en cours** avec statuts
- **Deadlines** proches (timeline visuelle)
- **Impayés** en cours de recouvrement
- **Documents récents** générés
- **Score conformité** RGPD

### `/agent-juridique/chat`
- Chat plein écran avec l'IA juridique
- L'IA cite ses sources (articles de loi, jurisprudence)
- Boutons contextuels : [Générer le document] [Ouvrir un dossier] [Voir la loi]
- Historique des conversations
- Mode vocal bidirectionnel

### `/agent-juridique/documents`
- Bibliothèque de tous les documents juridiques
- Filtres par type, catégorie, statut, date
- Pour chaque : preview, télécharger PDF/Word, signer, envoyer
- Templates réutilisables
- Versioning (historique des modifications)
- Génération : formulaire intelligent ou prompt libre
  "Génère-moi un contrat de prestation pour un développeur freelance, 500€/jour, mission de 3 mois, clause de non-concurrence 6 mois"
  → Document complet en 30 secondes

### `/agent-juridique/cases`
- Liste des dossiers avec Kanban (ouvert → en cours → en attente → résolu)
- Pour chaque dossier :
  - Résumé des faits
  - Timeline des événements
  - Parties impliquées
  - Stratégie IA + probabilité de succès
  - Arguments et risques
  - Jurisprudence pertinente
  - Documents associés
  - Deadlines et prescriptions
- Créer un dossier : décrire la situation → l'IA monte tout le dossier

### `/agent-juridique/impayes`
- Liste des créances impayées
- Pipeline visuel (en retard → relancé → mis en demeure → injonction)
- Ajouter un impayé : facture + infos débiteur → l'agent gère tout
- Historique des relances envoyées
- Montants récupérés

### `/agent-juridique/veille`
- Feed des changements juridiques pertinents
- Filtres par domaine
- Pour chaque : résumé simple + impact + action requise
- Marquer comme lu/traité

### `/agent-juridique/templates`
- 50+ templates pré-construits par Purama :
  - Contrats (travail CDI/CDD, prestation, commercial, NDA, licence)
  - Société (statuts SASU/SAS/SARL/SCI/asso, PV AG, cession parts, pacte)
  - Immobilier (bail habitation/commercial/pro)
  - Recouvrement (mise en demeure, injonction, relance)
  - RGPD (politique confidentialité, registre, PIA, mentions)
  - Vie courante (résiliation, contestation, réclamation)
- Templates custom de l'utilisateur
- Remplissage intelligent (l'IA pré-remplit avec les infos connues)

### `/agent-juridique/settings`
- Profil juridique (type structure, activité, salariés)
- Domaines d'expertise suivis
- Veille ON/OFF + domaines
- Recouvrement auto ON/OFF + délais
- Signature uploadée
- Ton (accessible vs technique)
- AR24 quand disponible

---

## PROMPT SYSTÈME CLAUDE API

```xml
<s>
Tu es le meilleur juriste IA au monde. Tu as l'expertise combinée d'un avocat d'affaires,
d'un fiscaliste, d'un pénaliste, d'un spécialiste du droit du travail, et d'un expert RGPD,
avec 30 ans d'expérience chacun.

<identite>
Tu es l'Agent Juridique de Purama. Tu ne dis JAMAIS "je suis Claude" ou "je suis une IA".
Tu dis "je suis votre assistant juridique Purama". Tu parles avec autorité et expertise.
Tu tutoies l'utilisateur. Tu es empathique mais précis.
</identite>

<expertise>
Tu maîtrises PARFAITEMENT :
- Code civil, Code de commerce, Code du travail, Code pénal, Code de procédure civile
- Droit des sociétés (SASU, SAS, SARL, EURL, SCI, associations)
- Droit fiscal (IS, TVA, IR, plus-values, optimisation légale, ZFRR, CIR, IP Box)
- Droit du travail (CDI, CDD, licenciement, rupture conventionnelle, prud'hommes)
- Droit immobilier (baux, copropriété, construction, urbanisme)
- RGPD et droit du numérique (DPO, PIA, registre, transferts, cookies)
- Propriété intellectuelle (marques, brevets, droits d'auteur, licences)
- Droit de la consommation (CGV, garanties, rétractation)
- Droit de la famille (mariage, divorce, succession, donation)
- Droit pénal (infractions, plaintes, défense)
- Procédures (tribunal, médiation, arbitrage, référé, injonction)
- Jurisprudence récente (Cour de cassation, Conseil d'État, CJUE, CEDH)

Tu connais les TECHNIQUES d'avocats :
- Montages juridiques complexes (holding, démembrement, SCI, pacte Dutreil)
- Stratégies de négociation et transaction
- Argumentation juridique structurée (majeure/mineure/conclusion)
- Gestion des preuves et charge de la preuve
- Calcul d'indemnités (licenciement, préjudice, intérêts)
- Mise en état et procédure contradictoire
- Référé et mesures d'urgence
- Voies de recours (appel, cassation, QPC)
</expertise>

<regles>
1. TOUJOURS citer les textes de loi exacts (articles, numéros)
2. TOUJOURS mentionner la jurisprudence pertinente quand elle existe
3. TOUJOURS donner une réponse concrète et actionnable
4. Si incertitude juridique → présenter les deux interprétations avec probabilités
5. JAMAIS de conseil dangereux ou illégal
6. Pour les documents → complets, conformes, prêts à signer
7. Langage adapté : accessible si l'utilisateur est non-juriste, technique si juriste
8. Disclaimer intégré quand nécessaire : "Cet avis ne remplace pas une consultation avec un avocat inscrit au barreau pour les procédures judiciaires"
</regles>

<profil_utilisateur>
Type : {{user_type}}
Entreprise : {{company_name}} ({{siren}})
Activité : {{activity_description}}
Salariés : {{employee_count}}
Zone : {{city}} {{postal_code}}
Domaines suivis : {{expertise_areas}}
</profil_utilisateur>

<dossiers_en_cours>
{{active_cases_json}}
</dossiers_en_cours>

<documents_recents>
{{recent_documents_json}}
</documents_recents>

<format>
Réponds de manière structurée :
1. Réponse directe et claire
2. Base légale (articles + jurisprudence)
3. Recommandation concrète (quoi faire, étape par étape)
4. Risques à connaître
5. Si document nécessaire → proposer de le générer immédiatement
</format>
</s>
```

---

## 50+ TEMPLATES PRÉ-CONSTRUITS

L'agent inclut ces templates prêts à l'emploi, auto-remplis par l'IA :

### Entreprise
- Statuts SASU / SAS / SARL / EURL / SCI / Association
- PV AG ordinaire / extraordinaire
- PV nomination président / gérant
- PV non-rémunération
- PV approbation comptes
- Pacte d'associés
- Convention de compte courant d'associé (CCA)
- Cession de parts sociales / actions
- NDA (accord de confidentialité)
- Règlement intérieur

### Contrats
- Contrat de travail CDI / CDD
- Contrat de prestation de services
- Contrat commercial (vente B2B)
- Contrat de licence logiciel (MIT, propriétaire)
- Contrat d'apporteur d'affaires
- Contrat de partenariat
- Contrat de sous-traitance
- Contrat freelance
- Avenant au contrat

### Web & RGPD
- CGV (vente en ligne)
- CGU (plateforme/SaaS)
- Mentions légales
- Politique de confidentialité RGPD
- Registre des traitements
- PIA (analyse d'impact)
- Contrat sous-traitant RGPD (DPA)
- Charte informatique

### Immobilier
- Bail d'habitation
- Bail commercial
- Bail professionnel
- État des lieux
- Quittance de loyer
- Congé locataire / bailleur

### Recouvrement
- Relance amiable (email)
- Relance ferme (email)
- Mise en demeure LRAR
- Requête en injonction de payer (CERFA 12946)
- Assignation en paiement

### Vie courante
- Lettre de résiliation (contrat, abonnement, assurance)
- Lettre de contestation (PV, facture, décision)
- Lettre de réclamation
- Lettre de rétractation (14 jours)
- Déclaration de sinistre
- Main courante

### Travail
- Lettre de démission
- Demande de rupture conventionnelle
- Contestation de licenciement
- Mise à pied
- Avertissement salarié

---

## ENV VARS

```
# Déjà dans CLAUDE.md
ANTHROPIC_API_KEY=<from CLAUDE.md>
NEXT_PUBLIC_SUPABASE_URL=https://auth.purama.dev
SUPABASE_SERVICE_ROLE_KEY=<from CLAUDE.md>
RESEND_API_KEY=re_i2Sg1F6F_Kn2NmU3e1MRYMB4e5Evm3FUP
TAVILY_API_KEY=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
DOCUSEAL_API_KEY=pKKLmvPpMi6SmX4FyjuwdFEky4K9tMUEoGP7oZYiGFZ
DOCUSEAL_URL=http://72.62.191.111:3001

# Partagé
VAPID_PUBLIC_KEY=<généré>
VAPID_PRIVATE_KEY=<généré>
```

---

## CRITÈRES DE SUCCÈS

- [ ] Répond à toute question juridique avec citations exactes (articles + jurisprudence)
- [ ] Génère 50+ types de documents conformes et complets
- [ ] Analyse de contrat : détecte clauses abusives + risques en < 30 secondes
- [ ] Montage dossier complexe : stratégie + arguments + jurisprudence + probabilité succès
- [ ] Veille juridique quotidienne pertinente au profil utilisateur
- [ ] Recouvrement impayés automatique (relance → mise en demeure → injonction)
- [ ] Deadlines et prescriptions surveillées 24/7
- [ ] Signature DocuSeal intégrée
- [ ] Audit RGPD automatique trimestriel
- [ ] Templates auto-remplis avec infos utilisateur
- [ ] Chat avec citations sources + mode vocal
- [ ] Disclaimer légal affiché quand nécessaire
- [ ] 0€ pour l'utilisateur au lieu de 300€/h d'avocat
