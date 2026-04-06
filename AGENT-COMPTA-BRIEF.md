# 🧾 AGENT COMPTABLE IA PURAMA — BRIEF CLAUDE CODE V1.0

## VISION
Agent comptable IA 100% autonome qui tourne 24/7. Il gère TOUTE la comptabilité :
- Catégorise automatiquement chaque transaction bancaire
- Génère factures Factur-X conformes
- Calcule TVA, charges, résultats en temps réel
- Prépare les déclarations fiscales (TVA, IS, liasse, CFE, CVAE)
- ENVOIE les déclarations (après validation utilisateur par notification)
- Gère les CCA, IK, amortissements
- Détecte les optimisations fiscales (ZFRR, CIR, CII, IP Box)
- Produit le bilan + compte de résultat
- Remplace 100% le comptable humain

L'utilisateur reçoit une notification → valide en 1 tap → l'agent envoie.

---

## ARCHITECTURE TECHNIQUE

### Stack
- **Frontend** : Pages dans Purama AI (akasha.purama.dev) — Next.js + Tailwind + shadcn/ui
- **Backend** : Supabase (tables dédiées agent compta)
- **Moteur IA** : Claude API (claude-sonnet-4-20250514) via n8n
- **Orchestrateur** : n8n (VPS 72.62.191.111)
- **Banque** : Bridge API (agrégateur bancaire français, DSP2 compliant)
- **Factures** : Factur-X (norme française obligatoire 2026)
- **Déclarations** : EDI-TDFC (télédéclarations fiscales) + API impots.gouv.fr
- **Notifications** : Push PWA + Email + SMS (optionnel)
- **Stockage docs** : Supabase Storage (factures, justificatifs, déclarations)

---

## NOTIFICATIONS — SYSTÈME COMPLET

### 1. Push Notifications (PWA — fonctionne sur téléphone)
Purama AI est une Progressive Web App (PWA). Les push notifications
fonctionnent sur mobile même si c'est une app web, à condition que
l'utilisateur "installe" l'app (Add to Home Screen).

```javascript
// Service Worker registration (dans le layout principal Akasha)
if ('serviceWorker' in navigator && 'PushManager' in window) {
  const registration = await navigator.serviceWorker.register('/sw.js');
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  });
  // Sauvegarder subscription dans Supabase
  await supabase.from('push_subscriptions').upsert({
    user_id: user.id,
    subscription: JSON.stringify(subscription),
    device_info: navigator.userAgent
  });
}
```

### 2. Email Notifications
Via Resend API (déjà dans le stack Purama).

### 3. Notifications In-App
Badge + feed dans le dashboard Akasha, temps réel via Supabase Realtime.

### 4. Table Supabase notifications (partagée par TOUS les agents)
```sql
CREATE TABLE agent_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_type TEXT NOT NULL, -- 'email', 'compta', 'partenariat', 'sutra'
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  action_type TEXT, -- 'approve_declaration', 'approve_draft', 'review', 'info'
  action_payload JSONB, -- données pour l'action (ex: declaration_id)
  action_url TEXT, -- lien direct vers la page concernée
  priority TEXT DEFAULT 'normal', -- 'low', 'normal', 'high', 'urgent'
  is_read BOOLEAN DEFAULT false,
  is_actioned BOOLEAN DEFAULT false,
  actioned_at TIMESTAMPTZ,
  channels TEXT[] DEFAULT '{push,in_app}', -- 'push', 'email', 'sms', 'in_app'
  sent_push BOOLEAN DEFAULT false,
  sent_email BOOLEAN DEFAULT false,
  sent_sms BOOLEAN DEFAULT false,
  expires_at TIMESTAMPTZ, -- notification expire après X jours
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  subscription JSONB NOT NULL, -- Web Push subscription object
  device_info TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### Workflow n8n notification (partagé par tous les agents)
```
Trigger: Webhook /notify
→ Input: { user_id, agent_type, title, body, action_type, action_payload, priority, channels }
→ Insert dans agent_notifications
→ Si 'push' dans channels :
  → Fetch push_subscriptions du user
  → Web Push API → envoyer à tous les devices
→ Si 'email' dans channels :
  → Resend API → envoyer email formaté
→ Si 'sms' dans channels :
  → Twilio API → envoyer SMS (optionnel, premium)
```

---

## APIS FISCALES — COMMENT ÇA MARCHE EN FRANCE

### Ce qui existe pour automatiser les déclarations :

#### 1. EDI-TDFC (Transfert des Données Fiscales et Comptables)
C'est LE canal officiel pour envoyer les déclarations aux impôts automatiquement.
- **Qui peut l'utiliser** : les éditeurs de logiciels comptables agréés par la DGFiP
- **Comment obtenir l'agrément** :
  1. Aller sur https://www.impots.gouv.fr/professionnel → rubrique "Partenaire EDI"
  2. Remplir le formulaire de demande de partenariat EDI
  3. Passer les tests de conformité (la DGFiP fournit un cahier des charges)
  4. Obtenir le numéro de partenaire EDI
  5. Délai : 2-4 mois
- **Ce qu'on peut envoyer** : déclarations de résultats (liasse fiscale), TVA (CA3/CA12), CVAE, CFE, IS

#### 2. API Tierce Déclaration (pour la TVA)
- impots.gouv.fr propose un mode "Tiers déclarant"
- Permet à un logiciel d'envoyer la TVA au nom du client
- Nécessite un mandat signé par le client

#### 3. En attendant l'agrément EDI (solution immédiate)
- L'agent PRÉPARE tout (calculs, documents, PDF conformes)
- Génère le fichier EDI au bon format
- L'utilisateur upload manuellement sur impots.gouv.fr (1 clic)
- OU l'agent utilise une API de partenaire déjà agréé (ex: Cegid, Sage API)

### Ce que Tissma doit faire MAINTENANT :
```
1. BRIDGE API (banque) :
   → https://bridgeapi.io → créer un compte → obtenir client_id + client_secret
   → Gratuit jusqu'à 500 users, puis payant
   → Permet de lire TOUTES les transactions bancaires en temps réel

2. DEMANDE PARTENARIAT EDI-TDFC :
   → https://www.impots.gouv.fr/partenaires-edi
   → Formulaire "Demande d'adhésion au dispositif EDI"
   → Motif : "Éditeur de logiciel comptable IA"
   → Joindre : description de Purama + SASU KBIS
   → Délai : 2-4 mois → en attendant, on prépare tout et l'user upload

3. FACTUR-X (facturation) :
   → Norme PDF/A-3 avec XML intégré
   → Bibliothèque Python : factur-x (pip install factur-x)
   → Obligatoire pour toutes les entreprises en 2026
```

---

## BASE DE DONNÉES SUPABASE

### Table : `compta_agent_config`
```sql
CREATE TABLE compta_agent_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  is_active BOOLEAN DEFAULT true,
  
  -- Infos entreprise
  company_name TEXT,
  siren TEXT,
  siret TEXT,
  naf_code TEXT,
  legal_form TEXT, -- SASU, SAS, EURL, SARL, EI, auto-entrepreneur
  fiscal_regime TEXT, -- reel_normal, reel_simplifie, micro
  tva_regime TEXT, -- mensuel, trimestriel, annuel, franchise
  tva_number TEXT,
  fiscal_year_start INTEGER DEFAULT 1, -- mois de début exercice
  
  -- Adresse
  address TEXT,
  postal_code TEXT,
  city TEXT,
  country TEXT DEFAULT 'FR',
  
  -- Zone fiscale
  is_zfrr BOOLEAN DEFAULT false,
  zfrr_start_date DATE,
  is_zfu BOOLEAN DEFAULT false,
  is_bassins_emploi BOOLEAN DEFAULT false,
  
  -- Optimisations actives
  cir_eligible BOOLEAN DEFAULT false,
  cii_eligible BOOLEAN DEFAULT false,
  ip_box_eligible BOOLEAN DEFAULT false,
  jei_status BOOLEAN DEFAULT false,
  
  -- Bridge API
  bridge_user_uuid TEXT,
  bridge_accounts JSONB, -- [{id, name, iban, type}]
  
  -- Automatisation
  auto_categorize BOOLEAN DEFAULT true,
  auto_tva BOOLEAN DEFAULT true,
  auto_declarations BOOLEAN DEFAULT true, -- prépare les déclarations
  require_approval_before_send BOOLEAN DEFAULT true, -- TOUJOURS demander avant d'envoyer
  
  -- Notifications
  notify_new_transaction BOOLEAN DEFAULT false,
  notify_declaration_ready BOOLEAN DEFAULT true,
  notify_anomaly BOOLEAN DEFAULT true,
  notify_monthly_report BOOLEAN DEFAULT true,
  
  -- EDI
  edi_partner_id TEXT, -- numéro partenaire EDI (quand obtenu)
  edi_enabled BOOLEAN DEFAULT false,
  
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### Table : `compta_transactions`
```sql
CREATE TABLE compta_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  
  -- Bridge API data
  bridge_transaction_id TEXT UNIQUE,
  bridge_account_id TEXT,
  
  -- Transaction data
  date DATE NOT NULL,
  description TEXT NOT NULL,
  raw_description TEXT, -- description brute de la banque
  amount DECIMAL(12,2) NOT NULL,
  currency TEXT DEFAULT 'EUR',
  type TEXT, -- debit/credit
  
  -- Catégorisation IA
  category TEXT, -- voir plan comptable simplifié
  subcategory TEXT,
  pcg_account TEXT, -- compte PCG (ex: 601000)
  pcg_label TEXT, -- libellé du compte
  ai_confidence FLOAT,
  ai_reasoning TEXT,
  user_validated BOOLEAN DEFAULT false,
  user_category_override TEXT, -- si l'utilisateur corrige
  
  -- TVA
  tva_rate DECIMAL(4,2), -- 20, 10, 5.5, 2.1, 0
  tva_amount DECIMAL(12,2),
  ht_amount DECIMAL(12,2),
  tva_deductible BOOLEAN DEFAULT false,
  
  -- Justificatif
  receipt_url TEXT, -- URL dans Supabase Storage
  receipt_matched BOOLEAN DEFAULT false, -- facture rapprochée
  invoice_id UUID, -- lien vers compta_invoices si applicable
  
  -- CCA / IK / Amortissement
  is_cca BOOLEAN DEFAULT false, -- Compte Courant Associé
  is_ik BOOLEAN DEFAULT false, -- Indemnité Kilométrique
  is_amortizable BOOLEAN DEFAULT false,
  amortization_duration_months INTEGER,
  amortization_start_date DATE,
  
  -- Métadonnées
  is_recurring BOOLEAN DEFAULT false,
  counterpart_name TEXT, -- nom du fournisseur/client
  counterpart_siren TEXT,
  tags TEXT[],
  notes TEXT,
  
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### Table : `compta_invoices`
```sql
CREATE TABLE compta_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  
  invoice_number TEXT NOT NULL, -- auto-incrémenté
  type TEXT NOT NULL, -- 'emise' (vente) ou 'recue' (achat)
  status TEXT DEFAULT 'draft', -- draft, sent, paid, overdue, cancelled
  
  -- Client/Fournisseur
  counterpart_name TEXT NOT NULL,
  counterpart_siren TEXT,
  counterpart_tva_number TEXT,
  counterpart_address TEXT,
  counterpart_email TEXT,
  
  -- Montants
  total_ht DECIMAL(12,2) NOT NULL,
  total_tva DECIMAL(12,2) NOT NULL,
  total_ttc DECIMAL(12,2) NOT NULL,
  
  -- Lignes
  lines JSONB NOT NULL, -- [{description, quantity, unit_price, tva_rate, total_ht}]
  
  -- Dates
  issue_date DATE NOT NULL,
  due_date DATE,
  payment_date DATE,
  
  -- Factur-X
  facturx_pdf_url TEXT, -- PDF/A-3 avec XML intégré
  facturx_xml TEXT, -- XML Factur-X
  facturx_profile TEXT DEFAULT 'EN16931', -- MINIMUM, BASIC, EN16931
  
  -- Paiement
  payment_method TEXT, -- virement, carte, cheque, especes
  matched_transaction_id UUID,
  
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### Table : `compta_declarations`
```sql
CREATE TABLE compta_declarations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  
  type TEXT NOT NULL, -- 'tva_ca3', 'tva_ca12', 'is', 'liasse', 'cfe', 'cvae', 'das2'
  period TEXT NOT NULL, -- '2026-01' (mensuel), '2026-T1' (trimestriel), '2026' (annuel)
  
  status TEXT DEFAULT 'calculating', 
  -- calculating, ready, pending_approval, approved, sending, sent, confirmed, error
  
  -- Montants calculés
  calculated_data JSONB NOT NULL,
  -- Pour TVA CA3 : { tva_collectee, tva_deductible, tva_nette, base_ht_20, base_ht_10, ... }
  -- Pour IS : { resultat_fiscal, is_amount, acomptes, solde }
  -- Pour liasse : { all 2050-2059 fields }
  
  -- Documents générés
  pdf_url TEXT, -- PDF de la déclaration
  edi_file_url TEXT, -- fichier EDI-TDFC prêt à envoyer
  xml_data TEXT, -- données XML pour EDI
  
  -- Approbation utilisateur
  notification_sent_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  approved_by TEXT, -- 'user' ou 'auto' (si l'user a activé l'auto-send)
  rejection_reason TEXT,
  
  -- Envoi
  sent_at TIMESTAMPTZ,
  sent_via TEXT, -- 'edi', 'manual_upload', 'api'
  confirmation_number TEXT, -- accusé de réception DGFiP
  
  -- Deadlines
  deadline DATE NOT NULL, -- date limite de dépôt
  days_before_deadline_notify INTEGER DEFAULT 7,
  
  ai_notes TEXT, -- observations de l'IA
  ai_optimizations TEXT[], -- optimisations détectées
  
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### Table : `compta_cca`
```sql
CREATE TABLE compta_cca (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  
  associate_name TEXT NOT NULL,
  type TEXT NOT NULL, -- 'apport' ou 'remboursement'
  amount DECIMAL(12,2) NOT NULL,
  date DATE NOT NULL,
  description TEXT,
  monthly_cap DECIMAL(12,2) DEFAULT 1500.00,
  
  -- Convention CCA
  convention_url TEXT,
  interest_rate DECIMAL(4,2) DEFAULT 0, -- taux d'intérêt CCA
  
  matched_transaction_id UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### Table : `compta_ik`
```sql
CREATE TABLE compta_ik (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  
  vehicle_type TEXT, -- 'electrique', 'thermique'
  vehicle_power INTEGER, -- CV fiscaux
  date DATE NOT NULL,
  departure TEXT,
  destination TEXT,
  purpose TEXT NOT NULL, -- motif professionnel
  km DECIMAL(8,1) NOT NULL,
  ik_rate DECIMAL(6,4), -- barème en vigueur
  amount DECIMAL(8,2), -- calculé automatiquement
  
  matched_transaction_id UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### Table : `compta_amortizations`
```sql
CREATE TABLE compta_amortizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  
  asset_name TEXT NOT NULL,
  asset_category TEXT, -- materiel_info, mobilier, vehicule, logiciel, brevet
  purchase_date DATE NOT NULL,
  purchase_amount DECIMAL(12,2) NOT NULL,
  duration_months INTEGER NOT NULL,
  method TEXT DEFAULT 'lineaire', -- lineaire, degressif
  
  -- Calculs
  annual_amount DECIMAL(12,2),
  remaining_value DECIMAL(12,2),
  schedule JSONB, -- [{year, amount, cumulated, remaining}]
  
  -- CIR/CII si applicable
  eligible_cir BOOLEAN DEFAULT false,
  eligible_cii BOOLEAN DEFAULT false,
  
  matched_transaction_id UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### RLS (toutes tables)
```sql
-- Pattern identique pour chaque table
ALTER TABLE compta_agent_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own data" ON compta_agent_config FOR ALL USING (auth.uid() = user_id);
-- Répéter pour TOUTES les tables compta_*
```

---

## WORKFLOWS N8N

### Workflow 1 : "Compta Agent - Sync Transactions" (CRON toutes les 4h)
```
[CRON toutes les 4 heures]
→ Fetch users actifs avec Bridge configuré
→ Pour chaque user :
  → Bridge API : GET /accounts/{id}/transactions (since last_sync)
  → Pour chaque transaction :
    → Check si existe déjà (bridge_transaction_id UNIQUE)
    → Claude API analyse :
      System: "Tu es un expert-comptable IA français. Catégorise cette transaction
      selon le PCG. Détermine la TVA applicable. Détecte si c'est un CCA, IK,
      ou amortissable. Contexte entreprise : {{company_info}}"
      → Retourne : { pcg_account, category, tva_rate, is_cca, is_ik, is_amortizable, reasoning }
    → Insert dans compta_transactions
    → Si anomalie détectée → notification
  → Update last_sync_at
```

### Workflow 2 : "Compta Agent - Prepare Declarations" (CRON mensuel)
```
[CRON le 5 de chaque mois à 9h]
→ Fetch users avec auto_declarations=true
→ Pour chaque user :
  → Déterminer quelles déclarations sont dues ce mois :
    - TVA CA3 (si mensuel) : due le 19-24 du mois suivant
    - TVA CA12 (si annuel) : due le 2ème jour ouvré suivant le 1er mai
    - Acompte IS : 15 mars, 15 juin, 15 sept, 15 déc
    - Liasse fiscale : 2ème jour ouvré suivant le 1er mai
    - CFE : 15 décembre
    - DAS2 : 1er mai
  → Pour chaque déclaration due :
    → Fetch toutes transactions de la période
    → Claude API : calculer tous les montants
      System: "Tu es un expert-comptable. Calcule la déclaration {{type}}
      pour la période {{period}}. Transactions : {{transactions_json}}.
      Config fiscale : {{fiscal_config}}. Applique les optimisations :
      ZFRR={{is_zfrr}}, CIR={{cir_eligible}}, IP Box={{ip_box_eligible}}.
      Retourne le JSON exact des champs de la déclaration."
    → Générer PDF + fichier EDI
    → Insert dans compta_declarations (status: ready)
    → NOTIFICATION → "Votre déclaration TVA janvier 2026 est prête. 
      Montant : 1,234.56€. Deadline : 19/02/2026. [Valider] [Voir détails]"
```

### Workflow 3 : "Compta Agent - Send Declaration" (Webhook)
```
[Webhook : user approuve une déclaration]
→ Update declaration status → 'approved'
→ Si EDI activé :
  → Envoyer fichier EDI-TDFC à la DGFiP
  → Récupérer accusé de réception
  → Update status → 'sent' puis 'confirmed'
→ Si EDI pas encore activé :
  → Envoyer email avec :
    - PDF de la déclaration
    - Instructions étape par étape pour upload sur impots.gouv.fr
    - Lien direct vers la page impots.gouv.fr
  → Update status → 'sent'
→ Notification : "Déclaration envoyée ✓" ou "Déclaration prête à uploader"
```

### Workflow 4 : "Compta Agent - Monthly Report" (CRON mensuel)
```
[CRON le 1er de chaque mois à 8h]
→ Pour chaque user avec notify_monthly_report=true :
  → Fetch toutes transactions du mois précédent
  → Claude API : générer rapport mensuel
    - CA du mois / évolution
    - Charges par catégorie
    - TVA collectée vs déductible
    - Trésorerie
    - CCA : solde et remboursements
    - Alertes (charges inhabituelles, deadline proche)
    - Optimisations fiscales détectées
  → Générer PDF rapport
  → Email + notification avec le rapport
```

### Workflow 5 : "Compta Agent - Deadline Watcher" (CRON quotidien)
```
[CRON tous les jours à 9h]
→ Fetch declarations avec deadline dans les 14 prochains jours
→ Si status != 'sent' et status != 'confirmed' :
  → Notification urgence croissante :
    - J-14 : "Rappel : TVA CA3 due dans 14 jours"
    - J-7 : "⚠️ TVA CA3 due dans 7 jours. Voulez-vous que je prépare ?"
    - J-3 : "🚨 URGENT : TVA CA3 due dans 3 jours !"
    - J-1 : "🔴 DERNIER JOUR pour la TVA CA3 !"
```

### Workflow 6 : "Compta Agent - Invoice Generator" (Webhook)
```
[Webhook : user demande une facture]
→ Claude API : générer facture Factur-X
→ Python script : créer PDF/A-3 avec XML intégré
→ Stocker dans Supabase Storage
→ Si email client fourni → envoyer la facture
→ Notification : "Facture #2026-042 créée et envoyée"
```

---

## PAGES FRONTEND

### `/agent-compta` — Dashboard principal
- **Toggle ON/OFF** agent
- **Vue trésorerie** temps réel (graphique)
- **CA du mois** vs mois précédent
- **Prochaines deadlines** fiscales (timeline visuelle)
- **Dernières transactions** catégorisées (avec icônes)
- **Déclarations en attente** de validation (bouton Approuver)
- **Alertes** (anomalies, charges inhabituelles)
- **Score santé fiscale** (gamifié, 0-100)

### `/agent-compta/transactions`
- Liste complète avec filtres (date, catégorie, montant, TVA)
- Pour chaque transaction : catégorie IA + bouton corriger
- Upload justificatif (photo/scan)
- Rapprochement bancaire automatique
- Export CSV/Excel

### `/agent-compta/invoices`
- Créer facture (formulaire simple)
- Liste factures émises/reçues
- Statuts (brouillon, envoyée, payée, en retard)
- Relance automatique des impayés
- Conformité Factur-X

### `/agent-compta/declarations`
- Timeline de toutes les déclarations (passées + à venir)
- Pour chaque : montants, PDF, statut, accusé réception
- Bouton [Approuver et Envoyer]
- Historique complet

### `/agent-compta/settings`
- Infos entreprise (SIREN, régime fiscal, TVA)
- Connexion bancaire (Bridge)
- Optimisations fiscales actives
- Notifications preferences
- CCA : convention + plafond mensuel
- IK : véhicule + barème
- Plan comptable personnalisé

### `/agent-compta/reports`
- Bilan
- Compte de résultat
- Grand livre
- Balance générale
- Rapport mensuel
- Export pour liasse fiscale

---

## PROMPT SYSTÈME CLAUDE API (catégorisation)

```xml
<s>
Tu es un expert-comptable IA français certifié, spécialisé dans les TPE/PME.

<contexte_entreprise>
Forme juridique : {{legal_form}}
Régime fiscal : {{fiscal_regime}}
Régime TVA : {{tva_regime}}
Code NAF : {{naf_code}}
Zone ZFRR : {{is_zfrr}}
CIR éligible : {{cir_eligible}}
</contexte_entreprise>

<plan_comptable_simplifie>
60 - Achats (601 matières, 602 fournitures, 604 sous-traitance, 606 non stockés, 607 marchandises)
61 - Services extérieurs (611 sous-traitance, 613 loyers, 615 entretien, 616 assurances)
62 - Autres services (621 personnel intérim, 622 honoraires, 623 pub, 625 déplacements, 626 telecom, 627 banque)
63 - Impôts et taxes
64 - Charges personnel
65 - Autres charges
66 - Charges financières
67 - Charges exceptionnelles
68 - Dotations amortissements
70 - Ventes (701 produits, 706 services, 707 marchandises)
74 - Subventions
75 - Autres produits
76 - Produits financiers
77 - Produits exceptionnels
455 - Compte courant associé
</plan_comptable_simplifie>

<regles_tva>
20% : taux normal (majorité des biens et services)
10% : restauration, travaux rénovation, transports
5.5% : alimentation, livres, énergie, travaux énergie
2.1% : médicaments remboursés, presse
0% : export, livraisons intracommunautaires, franchise en base
</regles_tva>

<instructions>
Analyse cette transaction bancaire et retourne UNIQUEMENT un JSON valide :
{
  "pcg_account": "606100",
  "pcg_label": "Fournitures non stockables - Eau, énergie",
  "category": "charges_exploitation",
  "subcategory": "fournitures",
  "tva_rate": 20,
  "tva_amount": 16.67,
  "ht_amount": 83.33,
  "tva_deductible": true,
  "is_cca": false,
  "is_ik": false,
  "is_amortizable": false,
  "amortization_category": null,
  "amortization_duration_months": null,
  "counterpart_name": "EDF",
  "tags": ["energie", "recurrent"],
  "confidence": 0.95,
  "reasoning": "Paiement EDF mensuel, charge d'exploitation non stockable, TVA 20% déductible"
}
</instructions>
</s>
```

---

## PWA — SERVICE WORKER POUR NOTIFICATIONS

```javascript
// /public/sw.js — à intégrer dans Akasha
self.addEventListener('push', function(event) {
  const data = event.data ? event.data.json() : {};
  
  const options = {
    body: data.body || 'Notification de votre agent IA',
    icon: '/icons/purama-192.png',
    badge: '/icons/purama-badge-72.png',
    vibrate: [100, 50, 100],
    data: {
      url: data.action_url || '/agent-compta',
      action_type: data.action_type,
      action_payload: data.action_payload
    },
    actions: []
  };

  // Actions contextuelles selon le type
  if (data.action_type === 'approve_declaration') {
    options.actions = [
      { action: 'approve', title: '✅ Approuver' },
      { action: 'review', title: '👁️ Voir détails' }
    ];
  }

  event.waitUntil(
    self.registration.showNotification(data.title || 'Agent Purama', options)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  
  if (event.action === 'approve') {
    // Appel API pour approuver directement
    event.waitUntil(
      fetch('/api/agent/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event.notification.data.action_payload)
      })
    );
  } else {
    // Ouvrir la page
    event.waitUntil(
      clients.openWindow(event.notification.data.url)
    );
  }
});
```

---

## MANIFEST PWA (pour "installer" l'app sur téléphone)

```json
// /public/manifest.json
{
  "name": "Purama AI",
  "short_name": "Purama",
  "description": "Vos agents IA autonomes",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#000000",
  "theme_color": "#8B5CF6",
  "icons": [
    { "src": "/icons/purama-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/purama-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

---

## SÉCURITÉ

- Données bancaires : Bridge API gère la sécurité DSP2 (Purama ne stocke JAMAIS les identifiants bancaires)
- Tokens Bridge chiffrés dans Supabase
- RLS sur toutes les tables
- Déclarations : JAMAIS envoyées sans approbation explicite (sauf si l'user active le mode full-auto)
- Justificatifs : stockés chiffrés dans Supabase Storage
- RGPD : suppression complète possible
- Audit trail : chaque action est loguée

---

## ENV VARS REQUISES

```
# Déjà dans CLAUDE.md
NEXT_PUBLIC_SUPABASE_URL=https://auth.purama.dev
NEXT_PUBLIC_SUPABASE_ANON_KEY=<from CLAUDE.md>
SUPABASE_SERVICE_ROLE_KEY=<from CLAUDE.md>
ANTHROPIC_API_KEY=<from CLAUDE.md>
GOOGLE_CLIENT_ID=<from CLAUDE.md>
GOOGLE_CLIENT_SECRET=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

# Nouvelles
BRIDGE_CLIENT_ID=<à obtenir sur bridgeapi.io>
BRIDGE_CLIENT_SECRET=<à obtenir sur bridgeapi.io>
VAPID_PUBLIC_KEY=<générer avec web-push>
VAPID_PRIVATE_KEY=<générer avec web-push>
RESEND_API_KEY=<à obtenir sur resend.com>
```

---

## CE QUE TISSMA DOIT FAIRE AVANT DE LANCER CLAUDE CODE

1. **Bridge API** : Créer compte sur https://bridgeapi.io → récupérer client_id + client_secret
2. **Resend** : Créer compte sur https://resend.com → récupérer API key (pour les emails de notification)
3. **Demande EDI-TDFC** : Aller sur impots.gouv.fr/partenaires-edi → formulaire d'adhésion (2-4 mois, on code tout en attendant, l'user upload manuellement en attendant l'agrément)
4. **VAPID keys** : Claude Code les génère automatiquement

---

## CRITÈRES DE SUCCÈS

- [ ] Sync bancaire automatique toutes les 4h
- [ ] Catégorisation IA > 92% de précision
- [ ] TVA calculée automatiquement sur chaque transaction
- [ ] Déclarations préparées 7 jours avant deadline
- [ ] Notification push fonctionnelle sur mobile (PWA)
- [ ] Approbation en 1 tap depuis la notification
- [ ] Envoi EDI quand agrément obtenu, upload assisté en attendant
- [ ] Bilan + compte de résultat générés automatiquement
- [ ] Factur-X conforme
- [ ] 0€ de coût comptable pour l'utilisateur
