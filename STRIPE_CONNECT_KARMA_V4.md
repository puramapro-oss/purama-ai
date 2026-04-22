# STRIPE_CONNECT_KARMA_V4.md
Module universel paiement cash + primes + jeux + fiscalité auto + stratégie financement + stack santé & temps d'écran natif pour l'écosystème Purama — Version 4.1 — 21 avril 2026 — SOURCE OF TRUTH FINALE

📌 Claude Code DOIT lire ce fichier + CLAUDE.md + BRIEF de l'app avant toute implémentation. Tout est automatique, zéro intervention manuelle.

🆕 V4.1 (21/04/2026) = V4 + OpenTimestamps confirmé partout + HealthKit/Health Connect natif (remplace Terra API) + Temps d'écran iOS/Android natif + INSEE clé universelle + Stripe Connect Embedded clarifié (pas de `ca_...` nécessaire)

🆕 V4 (19/04/2026) = V3 + Primes Phase 1/2 alignées sur paiements abonnement + CPA par app + Dual circuit SASU/Asso + Bourse d'inclusion Asso + Google Ad Grants + Catégorisation 100 apps

---

## 🎯 OBJECTIF V4.1

**"Tu gagnes, Purama déclare, Purama paie, 0 paperasse, 0 stress fiscal, 100% légal, données santé natives 0€."**

Activer **dès aujourd'hui** pour toutes les apps Purama :
1. Paiement cash légal (Stripe Connect Express + Embedded Components)
2. Primes Phase 1 (puis Phase 2 quand CPA signés)
3. Jeux KARMA hors champ ANJ
4. Fiscalité 100% automatisée (4 profils auto-détectés)
5. Dual circuit SASU (primes) + Asso (bourses d'inclusion + missions)
6. Google Ad Grants + Meta Nonprofits (150k€/an pub gratuite)
7. **Stack santé native iOS/Android** (HealthKit + Health Connect) — 0€, 0 API externe
8. **Temps d'écran natif iOS/Android** (FamilyControls + UsageStatsManager) — 0€

---

## ⚖️ CADRE LÉGAL CONSOLIDÉ

### Stripe Connect = légal sans agrément Purama
- Stripe Technology Europe Limited (STEL) = licence EMI passportée FR via PSD2
- ACPR a validé Connect
- Purama ne possède JAMAIS les fonds

### Fiscalité
- Purama = **tiers déclarant URSSAF** (mandat user, pas d'agrément)
- Purama peut pré-remplir formulaires + API URSSAF Tierce Déclaration + Factur-X
- Purama NE PEUT PAS être expert-comptable titulaire

### Framing Connect
- Users = "contributeurs/prestataires" (pas "users touchent cash")
- CGU claires obligatoires

### ANJ (jeux) — KARMA casse les 3 critères

### Huissier — PAS obligatoire, horodatage blockchain 0€ (OpenTimestamps)

### Données santé — 100% RGPD par design
- HealthKit / Health Connect = données **sur device**, jamais stockées Purama
- Purama lit uniquement les métriques agrégées (pas/sommeil/sport) avec permission user explicite
- Opt-in obligatoire à l'onboarding
- User peut révoquer l'accès à tout moment (Settings iOS/Android)

---

## ⚠️ DUAL CIRCUIT SASU ↔ ASSO (CRITIQUE)

**Règle d'or anti-abus de droit :**
- **SASU finance :** primes de bienvenue (incitation commerciale → couverte par CPA)
- **Asso finance :** bourses d'inclusion (intérêt général → couvertes par subventions)
- **JAMAIS l'Asso ne finance la prime SASU** = abus de droit = redressement

---

## 💳 STRIPE CONNECT — Express + Embedded Components (configuré 19/04/2026)

### ⚠️ CLARIFICATION V4.1 — Pas de STRIPE_CONNECT_CLIENT_ID nécessaire

L'ancien paramètre `STRIPE_CONNECT_CLIENT_ID=ca_...` est **uniquement pour OAuth/Standard accounts**. Les Embedded Components utilisent `AccountSession` créée côté serveur avec la `STRIPE_SECRET_KEY` existante.

```javascript
// Création du compte Connect Express
const account = await stripe.accounts.create({
  type: 'express',
  country: 'FR',
  email: user.email,
  capabilities: { transfers: { requested: true } },
  controller: {
    fees: { payer: 'account' },
    losses: { payments: 'application' },
    stripe_dashboard: { type: 'none' },
  },
});

// Création de l'AccountSession pour Embedded Components
const session = await stripe.accountSessions.create({
  account: account.id,
  components: {
    account_onboarding: { enabled: true },
    account_management: { enabled: true },
    notification_banner: { enabled: true },
    payouts: { enabled: true },
    payments: { enabled: true },
    balances: { enabled: true },
    documents: { enabled: true },
  },
});
// → client_secret envoyé au frontend, user reste sur purama.dev
```

### Configuration Stripe Dashboard (effectuée 19/04/2026)
- **Funds flow** : "Buyers will purchase from you" + "Payouts can be split between sellers"
- **Industry** : Other
- **Account creation** : Embedded onboarding components
- **Account management** : Embedded account components
- **Liability** : acknowledgé
- **Identité** : Matiss DORNIER soumise et vérifiée
- **Site links** (dashboard.stripe.com/settings/connect/emails) — 7 URLs Purama toutes activées :
  - Bannière notification → https://purama.dev/compte/notifications
  - Gestion comptes → https://purama.dev/compte/gestion
  - Virements → https://purama.dev/compte/virements
  - Paiements → https://purama.dev/compte/paiements
  - Soldes → https://purama.dev/compte/soldes
  - Documents → https://purama.dev/compte/documents
  - Configuration → https://purama.dev/compte/configuration
- Universal links (iOS `.well-known/apple-app-site-association` + Android `assetlinks.json`) pour que ces URLs fonctionnent aussi en natif mobile

### Grille frais user

| Retrait | Frais | % |
|---------|-------|---|
| 20€ | 2,30€ | 11,5% 🔴 |
| 30€ | 2,33€ | 7,8% 🟠 |
| **50€** | **2,38€** | **4,8% 🟢** |
| 100€ | 2,50€ | 2,5% 🟢 |

**Seuil min : 20€ | Recommandé : 50€**

### Message obligatoire retrait
> 💡 Astuce retrait
>
> Retire à partir de 50€ pour payer moins de frais.
>
> Frais prélevés par Stripe (notre partenaire bancaire), pas par Purama.
> Purama ne prend aucune commission sur tes gains.

---

## 🎁 PRIMES — 2 PHASES

### Règle d'alignement prime ↔ abonnement (CRITIQUE)
**Le user touche sa prime SEULEMENT APRÈS que l'abonnement du mois correspondant est payé.**
Si prélèvement échoue → palier suspendu ce mois-là → réactivé au prochain succès.

### Phase 1 (MAINTENANT, sans CPA) — `PRIME_MODE=phase1`
| Palier | Jour | Montant | Condition abonnement |
|--------|------|---------|----------------------|
| 1 | J1 | 25€ | 1er paiement validé (inscription) |
| 2 | J30 | 25€ | 2ème prélèvement validé |
| 3 | J60 | 50€ | 3ème prélèvement validé |

**Total : 100€ versés sur 2 mois après 3 abonnements payés (30€ cumulés).**

### Phase 2 (quand CPA encaissés) — `PRIME_MODE=phase2`
| Palier | Jour | Montant | Condition |
|--------|------|---------|-----------|
| 1 | J7 | 25€ | 1er paiement + 7j KYC + 1ers CPA tombés |
| 2 | J30 | 25€ | 2ème prélèvement validé |
| 3 | J60 | 50€ | 3ème prélèvement validé |

**Différence avec Phase 1 : J1 → J7 pour le premier palier** (le temps que les premiers CPA arrivent : Oura, Whoop, Noom…).

### Bascule
```
PRIME_MODE=phase1  # maintenant
PRIME_MODE=phase2  # quand CPA Treezor + Binance + TR + Cashbee + partenaires app signés
```

### Anti-fraude
- KYC Stripe Connect obligatoire
- 1 prime max par user par app (UNIQUE constraint sur `primes(user_id, app_id)`)
- Résiliation avant J60 = prime versée **récupérée au prorata automatique**
- Guardian IA : même device/IP/email pattern = blocage immédiat
- Prélèvement échoué = palier suspendu, pas de versement

### Cas spécial Purama Card
**+100€ supplémentaires** (1 seule fois par user, pas par app)
- Couvert par CPA Treezor 215€
- Phase 1 : J1=25€ / J30=25€ / J60=50€
- Phase 2 : J7=25€ / J30=25€ / J60=50€

---

## 🏦 CPA PARTENAIRES PAR CATÉGORIE D'APP

### CPA universels (1× par user, toutes apps confondues)
| Partenaire | CPA |
|-----------|-----|
| Treezor (IBAN + Carte + Dépôt + Domiciliation + 1ère tx) | 215€ |
| Binance (code CPA_00BM2GEU29) | 75€ |
| Trade Republic | 40€ |
| Cashbee | 35€ |
| **TOTAL universel** | **365€** |

### CPA spécifiques par app

#### Finance / Pro (CPA FORT 150-365€)
- **MIDAS** : Binance 75€ + Coinbase 75€ + Bitpanda 50€ = **200€**
- **MOKSHA** : Qonto 115€ + Pennylane 60€ + Blank 40€ = **215€**
- **KASH** : Pennylane 60€ + Yomoni 50€ + Goodvest 50€ = **160€**
- **PURAMA COMPTA** : Pennylane 60€ + Bridge API 15€ = **75€**

#### Créa / Edu (CPA MOYEN 50-120€)
- **SUTRA** : ElevenLabs 30€ + Riverside 25€ + Canva Pro 20€ + Runway 30€ = **105€**
- **LUMIOS** : Udemy 40€ + Coursera 30€ + MasterClass 50€ = **120€**
- **LINGORA / VEDA** : Busuu 25€ + Babbel 30€ + Mondly 20€ = **75€**
- **AKASHA** : Notion 25€ + ChatGPT Plus aff + Obsidian = **50€**
- **MANA** : Malt 50€ + Fiverr 100€ + Upwork 40€ + Contra 30€ = **220€**

#### Santé / Bien-être (CPA 65-225€)
- **VIDA** : Withings 20€ + Oura Ring 50€ + Whoop 40€ + Apple Fitness+ 15€ + Noom 100€ = **225€**
- **KAÏA** : Headspace 30€ + Calm 25€ + Petit Bambou 20€ + Muse EEG 40€ = **115€**
- **PRANA** : Breathwrk 15€ + Wim Hof 30€ + Insight Timer 20€ = **65€**
- **EXODUS** : Strava 20€ + AllTrails Pro 15€ + Garmin 50€ + Komoot 15€ = **100€**
- **AETHER** : CBD éthique + produits bio partenaires = **70-120€**

#### Écologie / Social (CPA 30-80€)
- **TERRA NOVA** : Too Good To Go + Vinted + Yuka Premium = **30-50€**
- **DONA** : HelloAsso + Leetchi + Ulule commissions = **30€**
- **JURISPURAMA** : LegalPlace + Captain Contrat + Qiiro = **80€**

### Formule gain Purama par user "complet"
```
CPA encaissés = 365€ (universel) + 200€ (app1) + 225€ (app2) + 215€ (app3)
              = ~1000€
Primes versées = 100€ (app1) + 100€ (app2) + 100€ (app3) + 100€ (carte)
               = 400€
Marge SASU par user complet = 1000€ - 400€ = +600€ ✅
```

---

## 📂 CATÉGORISATION DES 100 APPS (prime SASU applicable à toutes)

Chaque app a ses CPA propres → **prime 100€ activable partout.**

### Règle simple
| Type d'app | CPA | Prime SASU |
|-----------|-----|-----------|
| Toutes les 100 apps | Partenaires trouvés (65-365€) | **✅ 100€ par app** |

**Confirmation : oui la prime de 100€ s'applique aux 100 apps, financée par les CPA spécifiques de chaque app.**

### Stratégie d'activation CPA par app
- Semaine 1-2 après lancement app → démarcher 3-5 partenaires principaux
- Volume minimum pour signer CPA : 100 users actifs/mois
- Partenariats "auto-signables" (programmes d'affiliation publics) : Binance, Amazon, Apple, Google… → activables immédiatement
- Partenariats négociés (Treezor, Qonto, Pennylane) : 2-4 semaines + KBIS SASU

---

## 🎓 BOURSE D'INCLUSION ASSOCIATION PURAMA

### Programme parallèle 100% légal

**Pour qui :** publics ciblés à démontrer inclusion numérique
- Bénéficiaires CAF / RSA
- Jeunes 16-25 ans
- Seniors 65+
- Demandeurs d'emploi
- Ruraux (ZFRR, ZRR, communes <10 000 hab)
- Étudiants
- Personnes en situation de handicap

**Montant :** 50€ à 200€ par bénéficiaire, versé en 1 fois après validation

**Condition pour toucher :** compléter **5 missions citoyennes vérifiables** (santé, écologie, éducation, inclusion)

**Cumulable avec prime SASU :** oui, un même user peut toucher les 2 s'il est éligible bourse inclusion.

### Exemple user étudiant rural (19 ans, Frasne)

| Source | Montant |
|--------|---------|
| Prime SASU MIDAS | 100€ (via CPA Binance + Coinbase) |
| Prime SASU VIDA | 100€ (via CPA Oura + Whoop + Noom) |
| Prime SASU MOKSHA | 100€ (via CPA Qonto + Pennylane) |
| Prime Carte Purama | 100€ (via CPA Treezor) |
| Bourse Asso Inclusion | 100€ (1× car profil rural + étudiant, via Afnic/FDJ/FDF) |
| Missions 1er mois | 50€ à 150€ |
| **Total mois 1 possible** | **550 à 650€** 🚀 |

### Financement Bourse Asso = subventions
- Afnic : 15 000€
- FDJ : 15 000€
- Fondation de France : 15 000€
- FDVA 2 : 8 000€
- Orange : 15 000€
- Cetelem : 10 000€
- ANCT France Numérique Ensemble : variable
- FSE+ : massif si projet cadré
- Bpifrance Inclusion : selon AAP
- Régions / Communes / Départements : local

---

## 💰 FINANCEMENT — QUI FINANCE QUOI

### Circuit SASU Purama
| Dépense | Source |
|---------|--------|
| Primes de bienvenue (par app) | **CPA partenaires** |
| Primes Carte | CPA Treezor |
| Infrastructure tech | CA abonnements + CIR/CII (30% des dépenses R&D) |
| Dev / prestataires | CA + CIR/CII + Bpifrance Innovation |
| Marge commerciale | 30% CA abonnements |

### Circuit Association Purama
| Dépense | Source |
|---------|--------|
| Missions citoyennes rémunérées users | Subventions fondations (Afnic, FDJ, FDF, Orange, Cetelem…) |
| Bourses d'inclusion (publics ciblés) | Subventions inclusion numérique |
| Infrastructure tech (quote-part) | Subventions (ligne "infrastructure") |
| Communication institutionnelle | Subventions (ligne "communication") |
| **Publicité digitale** | **Google Ad Grants 10 000$/mois GRATUIT + Meta Nonprofits + Microsoft Ads + LinkedIn Nonprofits** |

### Total potentiel pub gratuite via Asso
| Programme | Montant gratuit/an |
|-----------|-------------------|
| Google Ad Grants | ~8 200€/mois × 12 = **98 400€/an** |
| Meta for Nonprofits (Facebook + Insta) | crédits variables |
| Microsoft Ads for Nonprofits | ~3 000€/an |
| LinkedIn Nonprofits | réductions massives |
| X Ads for Good | programme spécial |
| **TOTAL potentiel** | **~150 000€/an de pub gratuite** |

**Conditions :** Asso loi 1901 + RNA + enregistrement Solidatech + site web conforme.

---

## 🔄 RENOUVELLEMENT DES AIDES

| Type | Fréquence |
|------|-----------|
| Fondations (Afnic, FDJ, Orange, Cetelem, FDF) | ✅ **Chaque année** (nouveau dossier) |
| FDVA | ✅ Chaque année |
| CIR / CII | ✅ **Automatique chaque année** (crédit d'impôt) |
| Google Ad Grants | ✅ **Tous les mois à vie** (maintien critères) |
| Bpifrance Innovation | ⚠️ 1× par projet |
| FSE+ / Erasmus+ / INTERREG | ⚠️ Multi-annuels |

**Stratégie :** redemander chaque année avec **un nouveau volet** (2026 lancement 10 apps, 2027 extension 40 apps, 2028 scale Europe, 2029 1000 apps IA…).

---

## 🧾 MODULE PURAMA TAX ASSISTANT — 4 PROFILS AUTO

### Détection au onboarding Connect
```
Tu es...
○ Particulier (je gagne occasionnellement)
○ Autoentrepreneur (j'ai mon SIRET)
○ Entreprise (SASU, SARL, asso, etc.)
○ Je ne sais pas → Purama te guide
```

### Escalade auto selon cumul annuel
```
0 → 305€       : Particulier occasionnel (pas de déclaration)
305 → 3 000€   : Particulier BNC (2042-C-PRO pré-rempli)
3 000 → 77 700€ : Autoentrepreneur recommandé → 1-click MOKSHA
77 700€+       : SASU/SARL obligatoire → 1-click MOKSHA
```

### 4 Flows fiscaux

#### Flow 1 — Particulier occasionnel (<305€/an)
- Aucune déclaration
- Compteur live + alerte à 250€
- Message retrait : "Revenus occasionnels — aucune déclaration"

#### Flow 2 — Particulier BNC (305€ à 77 700€)
- Purama pré-remplit 2042-C-PRO (case 5KU)
- Lien 1-click vers impots.gouv.fr pré-rempli
- Abattement 34% auto
- Total effort user : **10 secondes en mars**

#### Flow 3 — Autoentrepreneur
- Mandat URSSAF signé 1× via DocuSeal (2 minutes)
- API URSSAF Tierce Déclaration activée
- **100% auto pour toujours** : déclarations trimestrielles + cotisations prélevées
- User ne fait plus JAMAIS rien

#### Flow 4 — Entreprise
- Connexion Pennylane OAuth (1 clic)
- Factur-X auto sur chaque payout
- EDI-TDFC si pas d'expert-comptable
- TVA calculée auto

### APIs à connecter
| API | Usage | Coût | Priorité | Statut V4.1 |
|-----|-------|------|----------|-------------|
| URSSAF Tierce Déclaration | Flow 3 | Gratuit | 🔴 | ⏳ Attend agrément |
| **INSEE Sirene** | **Vérif SIRET** | **Gratuit** | 🟢 | ✅ **Active** (`023ed173-7904-4893-bed1-7379043893fc`) |
| Pennylane OAuth | Flow 4 | 14,90€/mois/client | 🟠 | ⏳ Attend SIREN SASU |
| DocuSeal | Mandats | Déjà actif | 🟢 | ✅ Active (VPS 72.62.191.111:3001) |
| Bridge API / Tink | Open banking | Sandbox gratuit | 🟢 | ✅ Active (sandbox) |
| Impôts.gouv EDI-TDFC | Flow 4 | Gratuit agréé | 🟠 | ⏳ Attend SIREN |
| **OpenTimestamps** | **Horodatage règlements** | **Gratuit open source** | 🟢 | ✅ **Active** (lib `javascript-opentimestamps`) |

### Messages retrait par profil
- **Occasionnel :** "✅ Revenus occasionnels <305€/an — aucune déclaration."
- **BNC :** "💡 Déclaration prête en mars 2027 — 10 sec pour valider."
- **Autoentrepreneur :** "✅ Purama a déclaré à l'URSSAF — cotisations prélevées."
- **Entreprise :** "✅ Factur-X envoyée à Pennylane — TVA calculée."

---

## 🏥 STACK SANTÉ NATIVE — HealthKit + Health Connect (V4.1, 21/04/2026)

### ⚠️ Décision : Terra API ABANDONNÉE

**Raison :**
- Terra API 2026 = **$399/mois minimum** (plus de free tier)
- Coût annuel : **4 788 à 5 988$ / an** selon plan
- Inutilisable avant 100+ users payants

**Solution native :**
- **iOS** : Apple HealthKit (framework Apple natif)
- **Android** : Google Health Connect (nouveau standard obligatoire Android 14+)
- **Coût : 0€**
- **Latence : 0ms** (données sur device)
- **RGPD : parfait** (données jamais chez Purama)
- **Agrégation : 100+ apps connectées** déjà (Whoop, Oura, Garmin, Fitbit, Polar, Withings, Eight Sleep, Strava, Samsung Health, MyFitnessPal, Apple Watch…)

### Apps concernées
**VIDA, KAÏA, EXODUS, PRANA, AETHER** — toutes les apps wellness/santé Nature Rewards

### iOS — Apple HealthKit

**Installation :**
```bash
npx expo install react-native-health
```

**Permissions Info.plist (iOS) :**
```xml
<key>NSHealthShareUsageDescription</key>
<string>Purama utilise tes données de santé pour te récompenser pour tes activités positives (pas, sommeil, méditation, sport).</string>
<key>NSHealthUpdateUsageDescription</key>
<string>Purama peut enregistrer tes sessions de méditation et de respiration.</string>
```

**Types de données Nature Rewards activées :**
- `StepCount` → 5K pas = 0,25€ / 10K pas = 0,75€
- `DistanceWalkingRunning` → bonus marche
- `ActiveEnergyBurned` → bonus sport
- `SleepAnalysis` → 7-8h = 0,20€
- `MindfulSession` → méditation = 0,30€
- `Workout` → sport 30min = 0,50€ / 1h = 1,50€

### Android — Health Connect

**Installation :**
```bash
npx expo install react-native-health-connect
```

**Permissions AndroidManifest.xml :**
```xml
<uses-permission android:name="android.permission.health.READ_STEPS"/>
<uses-permission android:name="android.permission.health.READ_SLEEP"/>
<uses-permission android:name="android.permission.health.READ_EXERCISE"/>
<uses-permission android:name="android.permission.health.READ_HEART_RATE"/>
<uses-permission android:name="android.permission.health.READ_MINDFULNESS"/>
```

**⚠️ Remplace Google Fit deprecated** (Google Fit API fin 2024, Health Connect obligatoire Android 14+).

### Abstraction unifiée Purama

**Fichier `src/lib/health.ts` (à créer dans chaque app wellness) :**

```typescript
import { Platform } from 'react-native';

export type DailyHealthMetrics = {
  steps: number;
  sleepHours: number;
  activeMinutes: number;
  mindfulMinutes: number;
  workoutMinutes: number;
  distanceKm: number;
};

export async function requestHealthPermissions(): Promise<boolean> {
  if (Platform.OS === 'ios') {
    const AppleHealthKit = require('react-native-health').default;
    return new Promise((resolve) => {
      AppleHealthKit.initHealthKit(
        {
          permissions: {
            read: [
              'Steps', 'DistanceWalking', 'ActiveEnergyBurned',
              'SleepAnalysis', 'MindfulSession', 'Workout',
            ],
          },
        },
        (err: string) => resolve(!err)
      );
    });
  } else if (Platform.OS === 'android') {
    const { initialize, requestPermission } = require('react-native-health-connect');
    await initialize();
    const granted = await requestPermission([
      { accessType: 'read', recordType: 'Steps' },
      { accessType: 'read', recordType: 'SleepSession' },
      { accessType: 'read', recordType: 'ExerciseSession' },
      { accessType: 'read', recordType: 'Distance' },
    ]);
    return granted.length > 0;
  }
  return false;
}

export async function getDailyHealthMetrics(): Promise<DailyHealthMetrics> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Implémentation iOS + Android (voir docs react-native-health et react-native-health-connect)
  return {
    steps: 0, sleepHours: 0, activeMinutes: 0,
    mindfulMinutes: 0, workoutMinutes: 0, distanceKm: 0,
  };
}

export function calculateNatureReward(metrics: DailyHealthMetrics): number {
  let reward = 0;
  if (metrics.steps >= 10000) reward += 0.75;
  else if (metrics.steps >= 5000) reward += 0.25;
  if (metrics.workoutMinutes >= 60) reward += 1.50;
  else if (metrics.workoutMinutes >= 30) reward += 0.50;
  if (metrics.mindfulMinutes >= 10) reward += 0.30;
  if (metrics.sleepHours >= 7 && metrics.sleepHours <= 8) reward += 0.20;
  return Math.min(reward, 10); // plafond 10€/jour
}
```

### Intégration Nature Rewards (CRON)

**CRON quotidien minuit** (`/api/cron/nature-rewards`) :
1. Pour chaque user avec `health_connected=true` →
2. Appelle `getDailyHealthMetrics()` côté client via push silencieux ou au prochain foreground
3. Calcule reward via `calculateNatureReward()`
4. Crédit wallet via `wallet_transactions` (source: `nature_reward`)
5. Envoi notification "Tu as gagné X€ aujourd'hui 🌱"

### Règles Claude Code
- `grep -r "terra.api\|tryterra\|rookmotion\|terra-api" src/` = **0**
- Si trouvé → remplacer par stack native HealthKit/Health Connect
- Si BRIEF mentionne "wellness" ou "Nature Rewards" → créer `src/lib/health.ts` + onboarding permissions

---

## 📱 TEMPS D'ÉCRAN NATIF — iOS + Android (V4.1, 21/04/2026)

### Usage Purama
Missions anti-écran dans **EXODUS, VIDA, KAÏA, PRANA** :
- "Moins de 2h d'écran aujourd'hui = +0,50€"
- "Streak 7 jours <3h écran = badge Or + 5€"
- Challenge collectif "Digital Detox Weekend"

### iOS — FamilyControls + DeviceActivity

**Framework Apple natif** (iOS 15+).

**Entitlement à demander à Apple** (gratuit) :
- `com.apple.developer.family-controls`
- Via Apple Developer Portal → App ID → Capabilities → Family Controls

**Lib React Native :**
```bash
npx expo install react-native-screen-time-api
# OU implémentation custom via Expo Modules + Swift
```

**Permission utilisateur** à l'onboarding (modal natif iOS).

### Android — UsageStatsManager

**API Android native** (niveau API 22+).

**Permission manifest :**
```xml
<uses-permission android:name="android.permission.PACKAGE_USAGE_STATS"
    tools:ignore="ProtectedPermissions"/>
```

**⚠️ Permission spéciale :** l'utilisateur doit l'autoriser manuellement dans Settings Android :
`Settings → Apps → Special access → Usage access → Purama → Allow`

**Lib :**
```bash
npx expo install react-native-usage-stats-manager
```

### Abstraction (`src/lib/screen-time.ts`)

```typescript
import { Platform, Linking } from 'react-native';

export type ScreenTimeData = {
  totalMinutes: number;
  topApps: Array<{ packageName: string; name: string; minutes: number }>;
};

export async function requestScreenTimePermission(): Promise<boolean> {
  if (Platform.OS === 'ios') {
    // FamilyControls native (nécessite entitlement Apple)
    const { requestAuthorization } = require('react-native-screen-time-api');
    return await requestAuthorization();
  } else if (Platform.OS === 'android') {
    const UsageStats = require('react-native-usage-stats-manager');
    const hasPermission = await UsageStats.checkForPermission();
    if (!hasPermission) {
      Linking.sendIntent('android.settings.USAGE_ACCESS_SETTINGS');
      return false;
    }
    return true;
  }
  return false;
}

export async function getTodayScreenTime(): Promise<ScreenTimeData> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const now = new Date();
  if (Platform.OS === 'ios') {
    const { getDailyReport } = require('react-native-screen-time-api');
    return await getDailyReport(today, now);
  } else if (Platform.OS === 'android') {
    const UsageStats = require('react-native-usage-stats-manager');
    const stats = await UsageStats.queryUsageStats(
      UsageStats.INTERVAL_DAILY,
      today.getTime(),
      now.getTime()
    );
    const totalMinutes = stats.reduce((sum: number, s: any) =>
      sum + s.totalTimeInForeground / 60000, 0);
    return {
      totalMinutes,
      topApps: stats
        .sort((a: any, b: any) => b.totalTimeInForeground - a.totalTimeInForeground)
        .slice(0, 5)
        .map((s: any) => ({
          packageName: s.packageName,
          name: s.packageName,
          minutes: s.totalTimeInForeground / 60000,
        })),
    };
  }
  return { totalMinutes: 0, topApps: [] };
}

export function calculateAntiScreenReward(data: ScreenTimeData): number {
  const hours = data.totalMinutes / 60;
  if (hours < 2) return 0.50;
  if (hours < 3) return 0.20;
  return 0;
}
```

### Intégration missions EXODUS / VIDA / KAÏA / PRANA
- Onboarding : modal "Autoriser Purama à lire ton temps d'écran ?"
- CRON quotidien 22h : calcule temps d'écran → crédit si <seuil
- Dashboard "Mon Digital Detox" : graphe 7 jours + streak

### Règles Claude Code
- **UNIQUEMENT dans projets mobile Expo/React Native** (pas web)
- Si BRIEF mentionne "anti-écran", "digital detox", "temps d'écran" → créer `src/lib/screen-time.ts`
- iOS nécessite entitlement Apple (à demander une fois, gratuit)
- Android nécessite permission spéciale user (redirection Settings)

---

## 🎰 SYSTÈME KARMA — JEUX LÉGAUX

### 6 jeux
**4 skill pur :** Leaderboard Impact | Défis collectifs | Classement Karma | Quêtes épiques
**2 hasard gratuit :** Roue du Dharma | Jackpot Terre (20% ONG)

### 18 façons gratuites de gagner des places
| Action | Places |
|--------|--------|
| Inscription | +1 semaine + 1 mois |
| Parrainage (parrain + filleul) | +2 chacun |
| Mission complétée | +1 |
| Avis App Store / Play Store | +3 chacun |
| Follow Insta / TikTok / YouTube | +1 chacun |
| Story Insta / TikTok | +1 chacun |
| Vidéo TikTok / Reels | +2 |
| Partage évolution / parrainage | +1 (max 3/j) |
| Challenge gagné | +2 |
| Streak 7j / 30j | +1 / +5 |
| Feedback in-app | +1 |
| **Abonné payant** | **×5 multiplicateur** |

**Règle ANJ :** abonnement jamais obligatoire, ×5 = bonus.

### Cagnotte
- **Semaine :** 2% CA → 1 gagnant (min 10€)
- **Mois :** 3% CA → 3 gagnants 60/25/15% (min 50€)
- **Jackpot Terre :** 20% → ONG via Asso

### Flux économique global
```
Stripe 9.99€/mois abonnement user
   ↓ Split CRON n8n automatique
   ├─ 50% → pool gains users (missions + tirages + primes)
   ├─ 10% → Association Purama (convention prestation OBLIGATOIRE)
   ├─ 10% → ADYA marketing
   └─ 30% → SASU Purama (marge, 0% IS ZFRR)
```

---

## 📜 RÈGLEMENT JEUX-CONCOURS — OpenTimestamps (V4.1 CONFIRMÉ)

### ⚠️ OriginStamp = RETIRED (31 mai 2025)
L'ancien service OriginStamp Timestamp Dashboard a **fermé le 31 mai 2025** (recentrage B2B OriginVault payant). Signup impossible.

### Solution V4.1 = OpenTimestamps

**Avantages :**
- Open source, maintenu depuis 2016
- **0€** à vie
- **0 API key** (pas de signup, pas de compte, pas de dépendance cloud)
- Ancrage **Bitcoin** natif (blockchain la plus sécurisée au monde)
- Preuves vérifiables offline par n'importe qui

### Installation

```bash
npm install javascript-opentimestamps
```

### Implémentation (`src/lib/opentimestamps.ts`)

```typescript
import OpenTimestamps from 'javascript-opentimestamps';
import crypto from 'crypto';

/**
 * Horodate un contenu (règlement, preuve, audit) sur la blockchain Bitcoin.
 * Retourne une preuve base64 à stocker en DB.
 */
export async function stampHash(data: string): Promise<string> {
  const hash = crypto.createHash('sha256').update(data).digest();
  const detachedFile = OpenTimestamps.DetachedTimestampFile.fromHash(
    new OpenTimestamps.Ops.OpSHA256(),
    hash
  );
  await OpenTimestamps.stamp(detachedFile);
  return Buffer.from(detachedFile.serializeToBytes()).toString('base64');
}

/**
 * Vérifie qu'un contenu a bien été horodaté sur Bitcoin.
 */
export async function verifyProof(
  data: string,
  proofBase64: string
): Promise<{ verified: boolean; blockHeight?: number; timestamp?: Date }> {
  const hash = crypto.createHash('sha256').update(data).digest();
  const detachedOriginal = OpenTimestamps.DetachedTimestampFile.fromHash(
    new OpenTimestamps.Ops.OpSHA256(),
    hash
  );
  const detachedProof = OpenTimestamps.DetachedTimestampFile.deserialize(
    Buffer.from(proofBase64, 'base64')
  );
  const result = await OpenTimestamps.verify(detachedProof, detachedOriginal);
  return result.bitcoin
    ? {
        verified: true,
        blockHeight: result.bitcoin.height,
        timestamp: new Date(result.bitcoin.timestamp * 1000),
      }
    : { verified: false };
}
```

### Contenu obligatoire du règlement
1. Organisateur (SASU PURAMA, SIREN, 8 Rue de la Chapelle 25560 Frasne)
2. Durée / Conditions / Modalités
3. Dotations par jeu
4. **Remboursement des frais sur demande**
5. Désignation gagnants (random.org + skill)
6. RGPD
7. Tribunal Besançon
8. **Horodatage blockchain OpenTimestamps** (hash SHA-256 ancré Bitcoin, zéro API key)

### Mention footer obligatoire
```
🌱 Participation gratuite et sans obligation d'achat.
Règlement horodaté le [date] — preuve blockchain Purama : [hash]
Remboursement des frais sur demande : /remboursement
```

**Publication :** `karma.purama.dev/reglement` + duplication par app.

### Règles Claude Code OpenTimestamps
- `grep -r "originstamp" src/` = **0** (si trouvé → remplacer par `opentimestamps`)
- `package.json` doit contenir `"javascript-opentimestamps"`
- Terme UI : **"Preuve blockchain Purama"** (jamais "OpenTimestamps" ni "Bitcoin")
- Vérification preuve possible pour tout user via endpoint public `/api/reglement/verify`

---

## 🔧 IMPLÉMENTATION TECHNIQUE

### Variables d'environnement
```bash
# Stripe Connect
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
# ⚠️ V4.1 : PAS besoin de STRIPE_CONNECT_CLIENT_ID (ca_...)
# Embedded Components utilise AccountSession créée serveur avec STRIPE_SECRET_KEY

# Seuils retrait
KARMA_MIN_WITHDRAWAL_EUR=20
KARMA_RECOMMENDED_WITHDRAWAL_EUR=50

# Phase primes
PRIME_MODE=phase1  # phase1 (J1/J30/J60) | phase2 (J7/J30/J60)

# Anti-fraude
KARMA_MAX_TICKETS_PER_DAY=10
KARMA_DUPLICATE_DEVICE_BLOCK=true

# Blockchain (V4.1)
# OpenTimestamps = ZÉRO credentials, lib npm javascript-opentimestamps
# Rien à ajouter dans .env

# Fiscalité
URSSAF_TIERCE_API_KEY=...
URSSAF_TIERCE_MANDATE_TEMPLATE_ID=...
INSEE_API_KEY=023ed173-7904-4893-bed1-7379043893fc  # V4.1 : clé universelle active (portail-api.insee.fr)
PENNYLANE_OAUTH_CLIENT_ID=...
PENNYLANE_OAUTH_SECRET=...
EDI_TDFC_CERTIFICATE_PATH=/secrets/edi.p12
DOCUSEAL_API_KEY=...
BRIDGE_API_KEY=...

# Seuils fiscaux constants
TAX_THRESHOLD_OCCASIONAL_EUR=305
TAX_THRESHOLD_BNC_MICRO_EUR=77700
TAX_THRESHOLD_BIC_MICRO_EUR=188700
TAX_THRESHOLD_TVA_FRANCHISE_EUR=36800

# Dual circuit SASU/Asso
ASSO_RNA=W[à compléter]
ASSO_SIREN=[à compléter quand reçu]
SOLIDATECH_TOKEN=...
GOOGLE_AD_GRANTS_CUSTOMER_ID=...

# V4.1 — Stack santé native (UNIQUEMENT dans projets mobile Expo)
# Aucune clé API externe — tout natif iOS/Android
HEALTH_SYNC_ENABLED=true
SCREEN_TIME_ENABLED=true  # apps EXODUS, VIDA, KAÏA, PRANA uniquement
```

### Tables Supabase (V4.1 finale)
```sql
-- 1. Comptes Stripe Connect
CREATE TABLE connect_accounts (
    user_id uuid REFERENCES auth.users PRIMARY KEY,
    stripe_account_id text UNIQUE NOT NULL,
    onboarding_completed boolean DEFAULT false,
    payouts_enabled boolean DEFAULT false,
    kyc_verified_at timestamptz,
    created_at timestamptz DEFAULT now()
);
-- 2. Wallet Purama
CREATE TABLE user_wallets (
    user_id uuid REFERENCES auth.users PRIMARY KEY,
    balance_eur numeric(10,2) DEFAULT 0,
    lifetime_earned_eur numeric(10,2) DEFAULT 0,
    yearly_earned_eur numeric(10,2) DEFAULT 0,
    yearly_reset_date date DEFAULT date_trunc('year', now()),
    updated_at timestamptz DEFAULT now()
);
-- 3. Transactions wallet
CREATE TABLE wallet_transactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES auth.users,
    amount_eur numeric(10,2),
    direction text CHECK (direction IN ('credit', 'debit')),
    source text,
    source_id uuid,
    stripe_transfer_id text,
    created_at timestamptz DEFAULT now()
);
-- 4. Primes SASU (par app)
CREATE TABLE primes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES auth.users,
    app_id text NOT NULL,
    palier_actuel integer DEFAULT 0,
    montant_verse_eur numeric(10,2) DEFAULT 0,
    montant_total_eur numeric(10,2) DEFAULT 100,
    prime_mode text DEFAULT 'phase1',
    subscription_payment_check_1 boolean DEFAULT false,
    subscription_payment_check_2 boolean DEFAULT false,
    subscription_payment_check_3 boolean DEFAULT false,
    palier_1_date timestamptz,
    palier_2_date timestamptz,
    palier_3_date timestamptz,
    recuperee boolean DEFAULT false,
    created_at timestamptz DEFAULT now(),
    UNIQUE(user_id, app_id)
);
-- 5. Bourses Asso (1× par user global)
CREATE TABLE bourses_inclusion (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES auth.users UNIQUE,
    profil_social text[], -- CAF, rural, jeune, senior, demandeur_emploi, etudiant, handicap
    montant_eur numeric(10,2),
    missions_completees integer DEFAULT 0,
    missions_requises integer DEFAULT 5,
    versee boolean DEFAULT false,
    versee_at timestamptz,
    financement_source text, -- subvention_afnic, subvention_fdj, etc.
    created_at timestamptz DEFAULT now()
);
-- 6. Profil fiscal user
CREATE TABLE user_tax_profiles (
    user_id uuid REFERENCES auth.users PRIMARY KEY,
    profile_type text CHECK (profile_type IN ('particulier_occasionnel', 'particulier_bnc', 'autoentrepreneur', 'entreprise')),
    siret text,
    siren text,
    company_name text,
    legal_form text,
    activity_type text,
    tva_franchise boolean DEFAULT true,
    urssaf_mandate_signed_at timestamptz,
    urssaf_mandate_doc_id text,
    pennylane_oauth_token_encrypted text,
    pennylane_company_id text,
    edi_tdfc_enabled boolean DEFAULT false,
    threshold_305_alerted boolean DEFAULT false,
    threshold_bnc_alerted boolean DEFAULT false,
    threshold_tva_alerted boolean DEFAULT false,
    onboarded_at timestamptz,
    updated_at timestamptz DEFAULT now()
);
-- 7. Déclarations fiscales
CREATE TABLE tax_declarations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES auth.users,
    year integer NOT NULL,
    period text,
    declaration_type text,
    amount_declared_eur numeric(10,2),
    cotisations_eur numeric(10,2),
    filed_at timestamptz,
    status text,
    provider_response jsonb,
    created_at timestamptz DEFAULT now()
);
-- 8. Factures Factur-X
CREATE TABLE facturx_invoices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES auth.users,
    invoice_number text UNIQUE NOT NULL,
    amount_ht_eur numeric(10,2),
    tva_rate numeric(4,2) DEFAULT 0,
    amount_ttc_eur numeric(10,2),
    source_transaction_id uuid REFERENCES wallet_transactions,
    facturx_xml_url text,
    pdf_url text,
    sent_to_pennylane boolean DEFAULT false,
    created_at timestamptz DEFAULT now()
);
-- 9. CPA encaissés (tracking financement primes)
CREATE TABLE cpa_earnings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES auth.users,
    app_id text,
    partner text, -- binance, treezor, oura, noom, etc.
    amount_eur numeric(10,2),
    received_at timestamptz,
    covers_prime_palier integer, -- 1, 2, 3
    created_at timestamptz DEFAULT now()
);
-- 10. Tickets KARMA
CREATE TABLE karma_tickets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES auth.users,
    source text,
    draw_period text,
    used boolean DEFAULT false,
    created_at timestamptz DEFAULT now()
);
-- 11. Tirages + gagnants
CREATE TABLE karma_draws (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    type text CHECK (type IN ('week', 'month', 'jackpot_terre')),
    period text,
    pool_eur numeric(10,2),
    draw_date timestamptz,
    random_seed text,
    status text DEFAULT 'upcoming'
);
CREATE TABLE karma_winners (
    draw_id uuid REFERENCES karma_draws,
    user_id uuid REFERENCES auth.users,
    rank integer,
    amount_eur numeric(10,2),
    PRIMARY KEY (draw_id, user_id)
);
-- 12. Règlements horodatés (V4.1 : OpenTimestamps Bitcoin)
CREATE TABLE reglements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    version text NOT NULL,
    content_hash text NOT NULL,
    opentimestamps_proof text, -- preuve base64 OpenTimestamps
    blockchain text DEFAULT 'bitcoin', -- V4.1 : Bitcoin (OpenTimestamps natif)
    published_at timestamptz DEFAULT now(),
    content_url text
);
-- 13. Données santé (V4.1, apps wellness uniquement)
CREATE TABLE health_sync (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES auth.users,
    date date NOT NULL,
    steps integer DEFAULT 0,
    sleep_hours numeric(4,2) DEFAULT 0,
    active_minutes integer DEFAULT 0,
    mindful_minutes integer DEFAULT 0,
    workout_minutes integer DEFAULT 0,
    distance_km numeric(6,2) DEFAULT 0,
    nature_reward_eur numeric(6,2) DEFAULT 0,
    source text, -- healthkit_ios, health_connect_android
    synced_at timestamptz DEFAULT now(),
    UNIQUE(user_id, date)
);
-- 14. Temps d'écran (V4.1, apps anti-écran uniquement)
CREATE TABLE screen_time_sync (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES auth.users,
    date date NOT NULL,
    total_minutes integer DEFAULT 0,
    top_apps jsonb, -- [{packageName, name, minutes}]
    anti_screen_reward_eur numeric(6,2) DEFAULT 0,
    source text, -- ios_familycontrols, android_usagestats
    synced_at timestamptz DEFAULT now(),
    UNIQUE(user_id, date)
);
```

### Endpoints API
```
# Connect
POST /api/connect/onboard
POST /api/connect/account-session      # V4.1 : AccountSession pour Embedded Components
GET  /api/connect/status
POST /api/wallet/withdraw
# Primes SASU
POST /api/primes/trigger-palier       → CRON quotidien
POST /api/primes/check-subscription   → webhook Stripe invoice.paid
# Bourse Asso
POST /api/bourses/check-eligibility   → vérif profil social
POST /api/bourses/verify-mission      → comptage missions
POST /api/bourses/disburse            → versement 1× via Connect
# KARMA
POST /api/karma/draw                  → CRON hebdo/mensuel
POST /api/karma/ticket                → attribution auto
# Règlement (V4.1 : OpenTimestamps)
POST /api/reglement/publish           → horodatage OpenTimestamps (Bitcoin)
GET  /api/reglement/verify/:id        → vérification preuve blockchain
# Tax Assistant
GET  /api/tax/profile
POST /api/tax/profile/setup
POST /api/tax/mandate/urssaf
POST /api/tax/connect/pennylane
POST /api/tax/declare/urssaf          → CRON trimestriel
GET  /api/tax/recap/yearly
GET  /api/tax/prefill/2042
POST /api/tax/facturx/generate
POST /api/tax/threshold/check         → CRON quotidien
POST /api/tax/verify-siret            → INSEE Sirene (V4.1)
# Health Sync (V4.1, apps wellness)
POST /api/health/request-permissions  → déclenche prompt natif
POST /api/health/sync-daily           → pousse métriques device → DB
GET  /api/health/today                → récap journalier + reward
# Screen Time (V4.1, apps anti-écran)
POST /api/screen-time/request-permission
POST /api/screen-time/sync-daily
GET  /api/screen-time/today
# Webhooks Stripe
POST /api/webhooks/stripe
  - account.updated
  - transfer.created
  - payout.paid
  - invoice.paid               → déclenche check palier prime
  - invoice.payment_failed     → suspend palier en cours
```

### Flux utilisateur complet V4.1

1. **Inscription** → compte Connect créé + 1 ticket semaine + 1 ticket mois + question profil fiscal + prime initiée
2. **KYC Stripe Connect** via Embedded Components (reste dans purama.dev, AccountSession côté serveur)
3. **1er paiement abonnement 9.99€ validé** → déclenche palier 1 prime (J1 phase1 / J7 phase2)
4. **[Apps wellness]** onboarding HealthKit/Health Connect → permissions natives
5. **[Apps anti-écran]** onboarding FamilyControls/UsageStatsManager → permissions natives
6. **Missions complétées** → tickets + crédits EUR + avance vers Bourse Asso si profil éligible
7. **[Apps wellness]** CRON quotidien minuit : lit HealthKit/Health Connect → Nature Rewards auto
8. **[Apps anti-écran]** CRON quotidien 22h : lit screen time → Anti-Screen Reward
9. **J30** → CRON check si 2ème paiement validé → versement palier 2
10. **J60** → CRON check si 3ème paiement validé → versement palier 3 = 100€ total
11. **Bourse Asso** → déclenchée après 5 missions validées (1× par user)
12. **Seuil 20€** → bouton retrait + message incitatif 50€
13. **Retrait Stripe** → transfer SEPA instant (frais ~2,30€)
14. **Fiscalité auto** selon profil (URSSAF, 2042, Factur-X)

---

## 🚀 PLAN DE DÉPLOIEMENT

### Sprint 1 (semaine 1) — Fondations + Fiscal MVP + Primes Phase 1
- Stripe Connect activé + 14 tables Supabase migrées (V4.1)
- **Embedded Components** dans template Purama (AccountSession serveur)
- Question profil fiscal au onboarding
- Flow 1 (occasionnel) + Flow 2 (BNC) live
- Endpoints `/api/primes/trigger-palier` avec check abonnement
- CRON quotidien primes J1/J30/J60
- CGU/CGV + Politique RGPD mis à jour
- INSEE Sirene API connectée (clé déjà active)

### Sprint 2 (semaine 2) — KARMA + Bourses Asso + URSSAF + OpenTimestamps
- **OpenTimestamps** + page `/reglement` + horodatage Bitcoin
- CRONs tirages (n8n)
- Mandat URSSAF DocuSeal + API Tierce Déclaration sandbox
- Flow 3 (autoentrepreneur) live
- Programme Bourse Asso (CRUD admin + API vérif missions)
- Page `/karma` complète (tickets + classement + cagnotte live)

### Sprint 3 (semaine 3) — Pennylane + Google Ad Grants + Migration apps + Stack santé native
- Pennylane OAuth + Factur-X generator
- Flow 4 (entreprise) live
- Activation Google Ad Grants + Meta Nonprofits (Asso)
- Migration MIDAS, SUTRA, MOKSHA → Connect + Primes Phase 1
- **[VIDA, KAÏA, PRANA, EXODUS, AETHER]** Intégration HealthKit + Health Connect natif
- **[EXODUS, VIDA, KAÏA, PRANA]** Intégration Screen Time natif iOS + Android
- Dashboard admin (tirages, primes, bourses, CPA, health sync, screen time)

### Sprint 4 (semaine 4) — Scale + Démarche CPA
- Déploiement 10 apps live
- Tests E2E 4 profils fiscaux
- Contact Treezor + signatures premiers CPA (Binance, Oura, etc.)
- Communication launch
- Demande Solidatech → Google Ad Grants activé

### Sprint 5+ — Bascule Phase 2
- **Quand :** 1000+ users payants + CPA encaissés + trésorerie OK
- **Action :** `PRIME_MODE=phase2` (1 var env)

---

## ⚠️ POINTS D'ATTENTION CRITIQUES V4.1

1. **JAMAIS Asso finance prime SASU** = abus de droit = redressement
2. **Bourse Asso = publics ciblés + 5 missions** (pas automatique comme prime SASU)
3. **Prime alignée sur abonnement payé** : palier suspendu si échec prélèvement
4. **Question profil fiscal OBLIGATOIRE** au onboarding Connect
5. **Convention SASU ↔ Asso OBLIGATOIRE** pour les 10% Asso
6. **Jeux : abonnement JAMAIS obligatoire** (ANJ)
7. **Seuil 20€ min retrait**
8. **Phase 1 par défaut** tant que CPA non signés
9. **Google Ad Grants** = 2-14 jours validation après Solidatech
10. **RNA Association** = débloque TOUT (Solidatech, fondations, subventions)
11. **Redemander chaque année** les subventions renouvelables
12. **V4.1 — OpenTimestamps OBLIGATOIRE** (OriginStamp retired mai 2025, 0 exception)
13. **V4.1 — HealthKit + Health Connect NATIFS** (Terra API abandonnée, 0€)
14. **V4.1 — Temps d'écran natif iOS/Android** (pas d'API REST externe)
15. **V4.1 — Stripe Connect : Embedded Components** uniquement (PAS de `ca_...` OAuth)
16. **V4.1 — INSEE Sirene : clé universelle active** `023ed173-7904-4893-bed1-7379043893fc`

---

## 📞 ROADMAP CPA + TREEZOR

### Timeline
- **Semaine 1 :** contact Treezor + signature Binance (code déjà actif) + inscription Solidatech
- **Semaine 2-4 :** onboarding Treezor + signatures Oura, Noom, Whoop (programmes d'affiliation publics)
- **Mois 2-3 :** sandbox Treezor + signatures TR, Cashbee, Pennylane, Qonto
- **Mois 3-4 :** prod Treezor → bascule `PRIME_MODE=phase2`

### CPA stack cible
- **Universels :** 365€ (Treezor 215 + Binance 75 + TR 40 + Cashbee 35)
- **Par app :** 65€ à 365€ selon catégorie
- **Total user complet :** ~1000€
- **Primes versées :** 400€ (3 apps + carte)
- **Marge SASU/user :** **+600€** ✅

---

## 💎 LA PROMESSE PURAMA FINALE

> **"Tu t'inscris. Purama te verse 100€ par app. Tu gagnes en faisant le bien et en prenant soin de toi. Purama déclare tout. 0 paperasse. Tes données santé restent sur ton téléphone."**

| Profil user | Gains possibles mois 1 | Action requise |
|-------------|------------------------|----------------|
| Abonné 1 app standard | 100€ prime + missions | 0 sec |
| Abonné 3 apps + carte | 400€ primes + missions | 0 sec |
| Étudiant rural (3 apps + carte + bourse) | **550€+** | 5 missions |
| Autoentrepreneur 3 apps | 400€ + URSSAF auto | 0 sec |
| Wellness user (VIDA + KAÏA + HealthKit) | 400€ + Nature Rewards jusqu'à 10€/j | Autoriser HealthKit |

**Aucun concurrent n'offre ça. Purama est la première économie citoyenne IA au monde.**

---

## ✅ CHECKLIST DÉPLOIEMENT PAR APP (V4.1)

### Universel (toutes apps)
- [ ] Variables env complètes (dont INSEE_API_KEY)
- [ ] 14 tables Supabase migrées (12 de V4 + 2 nouvelles V4.1 : health_sync, screen_time_sync)
- [ ] **Embedded Components intégré** (AccountSession serveur, PAS de `ca_...`)
- [ ] Question profil fiscal onboarding
- [ ] Page `/karma` (tickets + classement + cagnotte live)
- [ ] Page `/reglement` + **hash blockchain OpenTimestamps**
- [ ] Page `/fiscalite` (dashboard adapté profil)
- [ ] Page `/bourse` (si éligible inclusion)
- [ ] Bouton "Retirer" seuil 20€ + message contextuel selon profil
- [ ] CGU + RGPD mis à jour
- [ ] CRONs n8n (tirages + primes alignées abo + splits + URSSAF + seuils)
- [ ] Webhook Stripe complet (dont invoice.paid pour primes)
- [ ] Guardian IA anti-fraude
- [ ] APIs connectées : **INSEE (clé active)**, URSSAF, Pennylane, DocuSeal, Bridge, Tink, **OpenTimestamps (lib npm)**
- [ ] Tests E2E : 4 profils fiscaux + prime phase 1 + bourse asso + retrait réel
- [ ] CPA partenaires identifiés pour cette app + contact lancé
- [ ] `grep -r "originstamp" src/` = 0
- [ ] `grep -r "terra.api\|tryterra" src/` = 0
- [ ] Pas de référence à `STRIPE_CONNECT_CLIENT_ID` (sauf commentaire explicatif)

### Apps wellness/santé (VIDA, KAÏA, EXODUS, PRANA, AETHER)
- [ ] `react-native-health` dans package.json mobile
- [ ] `react-native-health-connect` dans package.json mobile
- [ ] Permissions Info.plist iOS (NSHealthShareUsageDescription + NSHealthUpdateUsageDescription)
- [ ] Permissions AndroidManifest.xml (READ_STEPS, READ_SLEEP, READ_EXERCISE, etc.)
- [ ] `src/lib/health.ts` créé avec `requestHealthPermissions`, `getDailyHealthMetrics`, `calculateNatureReward`
- [ ] Onboarding avec modal "Autoriser l'accès aux données santé"
- [ ] CRON quotidien minuit : sync health → Nature Rewards auto
- [ ] Dashboard "Mon Nature Score" affichant steps/sleep/workout/reward

### Apps anti-écran (EXODUS, VIDA, KAÏA, PRANA)
- [ ] Entitlement Apple `com.apple.developer.family-controls` demandé
- [ ] `react-native-screen-time-api` (iOS) dans package.json mobile
- [ ] `react-native-usage-stats-manager` (Android) dans package.json mobile
- [ ] Permission `PACKAGE_USAGE_STATS` dans AndroidManifest.xml
- [ ] `src/lib/screen-time.ts` créé
- [ ] Onboarding avec redirect Settings Android pour autorisation
- [ ] CRON quotidien 22h : sync screen time → Anti-Screen Reward
- [ ] Dashboard "Digital Detox" affichant temps d'écran + streak

---

## 🔀 RÉCAPITULATIF DES CHANGEMENTS V4 → V4.1

| Zone | V4 | V4.1 (21/04/2026) |
|------|-----|------------------|
| Stripe Connect | `STRIPE_CONNECT_CLIENT_ID=ca_...` | **Embedded Components + AccountSession serveur** (pas de `ca_...`) |
| Horodatage blockchain | Mentionné vaguement | **OpenTimestamps natif Bitcoin** (code complet + lib npm) |
| Données santé | Terra API mentionnée | **HealthKit + Health Connect natif** (Terra abandonnée) |
| Temps d'écran | Non traité | **FamilyControls iOS + UsageStatsManager Android** |
| INSEE Sirene | À activer | **Clé active** `023ed173-7904-4893-bed1-7379043893fc` |
| Tables Supabase | 12 tables | **14 tables** (+ health_sync + screen_time_sync) |
| Endpoints API | Sans health/screen | **+ 6 endpoints** (health + screen-time + reglement/verify + connect/account-session + tax/verify-siret) |
| Apps concernées | 10 apps | 10 apps + stack santé native sur 5 apps wellness + screen time sur 4 apps anti-écran |

---

**FIN DU BRIEF V4.1.**

Pour chaque app :
```bash
cp ~/purama/CLAUDE.md ~/purama/[APP]/
cp ~/purama/STRIPE_CONNECT_KARMA_V4.md ~/purama/[APP]/
cd ~/purama/[APP]
claude --dangerously-skip-permissions
```

Premier message à Claude Code :
> "Lis le BRIEF, le CLAUDE.md V7.1 et le STRIPE_CONNECT_KARMA_V4 (V4.1). Montre-moi ton plan d'abord. NE CODE PAS ENCORE."
