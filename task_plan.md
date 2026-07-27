# PURAMA AI — Task Plan V3

## RÈGLE PERMANENTE (Tissma, 2026-07-26)
**Ne jamais bloquer le développement sur le crédit Anthropic.** Il sera rechargé juste avant le vrai
lancement, pas avant. Tout le code doit être écrit, testé structurellement et déployé avec Claude
mocké (`KARTA_MOCK_CLAUDE=true`, réponses marquées `TODO_LIVE_TEST`). Les tests qui nécessitent un
vrai appel Claude sont listés en fin de fichier sous "PRÊT À TESTER DÈS CRÉDIT DISPONIBLE" — jamais
cochés `[x]` tant qu'ils n'ont pas été validés avec un vrai crédit.

## AGENTS RÉELS — Suite Phase 3, sécurité "non négociable" du brief ✅ (2026-07-27)
- [x] `AGENTS-STATUS.md` produit (livrable explicite du brief) : tableau agent | état | autonomie | dernier test réussi, honnête sur ce qui est réellement testé vs seulement couvert par les tests unitaires
- [x] Rate limit anti-ban Gmail (max 400 envois/jour/compte, brief §Sécurité "non négociable") : jamais implémenté jusqu'ici — `gmailSendTool` pouvait envoyer sans plafond à autonomie niveau 3. Compteur quotidien ajouté (`karta_agent_memory`), partagé entre `email` et `repondeur-intelligent` (même compte Gmail réel). 3 tests unitaires + 41/41 suite complète verte. Déployé, healthy.
- [x] qa-agent + security-agent lancés sur l'ensemble Phase 1-4 (jamais fait malgré plusieurs déploiements prod — cf CLAUDE.md §TEST, obligatoire avant chaque deploy)

## AGENTS RÉELS — Phase 0 Audit ✅ (2026-07-26)
- [x] `AUDIT-AGENTS.md` produit — vérification réelle SSH+SQL+curl, 0 simulation
- [x] Inventaire 130 workflows n8n (78 actifs), 4 agents cœur + 45 agents site + duplicats
- [x] Trouvé 3 pannes bloquantes : crédit Anthropic épuisé + LOVABLE_API_KEY manquante (chat/chatbot) + catalogue `agents` vide
- [x] MIDAS + SUTRA confirmés vivants (200 OK, status green)

## AGENTS RÉELS — Phase 1 KARTA Engine ✅ (2026-07-26)
Décision brief : remplace n8n par un orchestrateur natif. n8n reste en place le temps de la migration
(les 2 tournent en parallèle sans risque — `email_agent_config.is_active=false` sur les 2 seuls users
existants, donc 0 double-traitement actuellement).

- [x] **Correctifs Phase 0 déployés en prod, vérifiés réels** :
  - [x] `purama_ai.agents` reseedé (45/45, vérifié via requête SQL + API REST publique + agent-proxy end-to-end)
  - [x] `chat` + `chatbot` migrés de LOVABLE_API_KEY (gateway mort) vers Anthropic direct (streaming SSE traduit au format OpenAI pour 0 impact frontend) — vérifié : routage OK, seul bloqueur restant = crédit (log confirmé)
  - [x] `supabase/functions/_shared/` resynchronisé sur le VPS (rate-limit.ts/response.ts/validation.ts manquaient — fixes sécurité 2026-07-25 jamais déployées avant aujourd'hui)
- [x] **KARTA Engine** (`karta/`, Node.js 22 + TypeScript strict, déployé Docker sur le VPS, `network_mode: host`) :
  - [x] Boucle agent (`engine/loop.ts`) : trigger → contexte → décision Claude (réel ou mock) → outils → log immuable → notif
  - [x] Autonomie 3 niveaux + kill switch par agent + kill switch global + mode simulation par défaut (`engine/autonomy.ts`, `engine/killswitch.ts`)
  - [x] Logs immuables `karta_runs` + mémoire `karta_agent_memory` + état `karta_agent_state`/`karta_global_state` (migrations 001/002 appliquées en prod)
  - [x] Queue BullMQ + Redis dédié (port 6380, container `karta-redis`)
  - [x] Scheduler node-cron (cadences alignées sur les workflows n8n qu'il remplace) + rapport quotidien 8h
  - [x] API interne : `/health` (public), `/kill-switch/*`, `/trigger/*` (bearer token)
  - [x] Collaboration inter-agents (`delegate_to_agent`, passe par la queue — même logging/autonomie que tout déclenchement)
  - [x] Claude client réel (`claude/real.ts`, tool-use Anthropic natif) + mock réaliste par agent (`claude/mock.ts`, `TODO_LIVE_TEST`)
  - [x] Tool registry : Supabase (liste blanche de tables), Gmail (OAuth + refresh réel), Calendar, Stripe (factures impayées), DocuSeal, Zernio, Apollo, génération PDF (pdfkit + Storage), recherche web (Tavily), notifications (agent_notifications + email Resend réel)
  - [x] 4 agents cœur : `emailAgent`, `comptaAgent`, `legalAgent`, `partnerAgent` (buildContext = vraies requêtes Supabase, 0 donnée inventée)
  - [x] 22 tests unitaires (vitest) : autonomie, mock Claude par agent, liste blanche Supabase, boucle complète (kill switch, approbation, outil inconnu) — **22/22 verts**
  - [x] `tsc --noEmit` 0 erreur
  - [x] Déployé et vérifié réel : `docker ps` → `karta-engine` + `karta-redis` up, `GET /health` → 200 réel, déclenchement manuel réel via API → job traité par le worker → ligne réelle dans `karta_runs` (agent compta, mode simulation, décision mock `TODO_LIVE_TEST`, 28ms)
- [ ] Reste Phase 1 : bascule progressive des 4 agents n8n → KARTA (activer `karta_agent_state.simulation_mode=false` agent par agent, après validation humaine, PAS avant le crédit réel)

## AGENTS RÉELS — Phase 2 : 12 agents "action" + page "Mes employés IA" ✅ (2026-07-26)
- [x] `AgentType` élargi (`CoreAgentType` + `ActionAgentType`, 16 valeurs) sans casser le schéma (`agent_type` déjà `TEXT`)
- [x] `karta_crm_leads` créée (migration 003, RLS, appliquée en prod) — support CRM Intelligent + Machine de Suivi
- [x] `src/agents/actionAgents.ts` : 12 `AgentDefinition` réels (Répondeur, Campagnes Email, Cold Outreach, Newsletter, Facture Pro, Chasseur de Paiements, Rapports Financiers, CRM Intelligent, Machine de Suivi, Maître des Publicités [mappé sur "Offres"], Planificateur d'Appels, Réservation Intelligente) — chacun avec `buildContext` sur vraies tables (`compta_invoices`, `compta_transactions`, `karta_crm_leads`, Gmail) ou brief-driven (`consumeBrief`)
- [x] Mock Claude généralisé : `genericItemsFallback` (lit `context.items`, choisit un outil via `PREFERRED_TOOL_ORDER`) — évite 12 handlers dupliqués, toujours suffixé `TODO_LIVE_TEST`
- [x] `AGENT_REGISTRY` étendu à 16 entrées, `listActiveUserIds` généralisé (table de config dédiée pour les 4 agents cœur, sinon `karta_agent_state.is_enabled` pour les 12 agents action)
- [x] Scheduler cron étendu (12 cadences, alignées sur la fréquence métier : répondeur 5min, CRM/suivi/RDV 15-30min, factures/paiements quotidien, rapports/newsletter/pubs hebdo)
- [x] Bug régression trouvé+fixé : routes API `/trigger/:agentType/:userId` et `/kill-switch/:agentType/:userId` ne matchaient pas les slugs à tiret (`crm-intelligent`) — regex corrigée, cf ERRORS.md
- [x] Test end-to-end réel : lead `karta_crm_leads` inséré en vrai → déclenchement manuel réel de `crm-intelligent` → décision mock correcte → ligne réelle dans `karta_runs`
- [x] 8 tests unitaires supplémentaires (mock fallback générique, registre 16 agents) — **30/30 verts** (22 Phase 1 + 8 Phase 2)
- [x] Bug trouvé+fixé : `karta/scripts/agents-catalog.ts` (reseed Phase 0) utilisait des noms Lucide comme icônes au lieu d'emoji littéraux (le frontend rend `agent.icon` en texte brut) — 45 icônes corrigées, re-reseedées, vérifiées en SQL prod
- [x] Page **"Mes employés IA"** (`src/pages/MyEmployees.tsx`, route `/dashboard/employees`, nav sidebar 16 langues) :
  - [x] Grille des 12 agents action (métadonnées lues depuis `agents` — 1 source de vérité, pas de duplication)
  - [x] Réglages par agent en écriture directe RLS (`karta_agent_state` upsert) : activation on/off, niveau d'autonomie 1-3, mode simulation, kill switch individuel — 0 API custom nécessaire
  - [x] Stats réelles 30 jours (exécutions, taux de réussite, en attente de validation, dernière activité) depuis `karta_runs` — 0 si aucune donnée, jamais de chiffre inventé
  - [x] Timeline d'activité réelle (`karta_runs`, badges statut/mock/simulation, résumé décision, erreur si échec)
- [x] `tsc --noEmit` (frontend + karta/) : 0 erreur
- [x] `npm run build` (Vite) : 0 erreur — bug environnement trouvé+fixé au passage (binaires natifs `.node` bloqués par Gatekeeper macOS, cf ERRORS.md)
- [ ] **Non fait** (nécessite navigateur/humain, hors capacité de cette session) : test humain réel de la page en navigateur (clics, responsive 375px, dark mode) — cf Loi 2 CLAUDE.md, ne pas déclarer "testé" sans preuve Playwright/humaine
## AGENTS RÉELS — Phase 3 : Agent Créateur d'Agents passe en exécution réelle ✅ (2026-07-26)
Réutilise `creator_agents` (existante, chat-only jusqu'ici — 1 source de vérité, pas de table dupliquée)
au lieu d'un nouveau système parallèle. Réutilise aussi `karta_agent_state`/`karta_runs` tels quels
(`agent_type = 'custom:<creator_agents.id>'`) — 0 nouvelle table pour l'autonomie/kill switch/logs.
- [x] Investigation complète de l'existant AVANT de coder (Loi 5) : `creator_agents`/`creator_agent_runs`/
  `creator_agent_chats` déjà en place mais 100% chat-only (`tools_enabled` déclaré mais jamais lu nulle
  part, aucune exécution d'outil réelle) — confirmé par lecture de tout le code frontend+edge functions
- [x] Migration 004 : `creator_agents.karta_enabled BOOLEAN DEFAULT false` (seule colonne ajoutée)
- [x] `AgentType` restructuré : `StaticAgentType` (16 agents codés en dur, `AGENT_REGISTRY` inchangé) +
  `CustomAgentType` (`` `custom:${string}` ``, résolu dynamiquement depuis `creator_agents`, jamais codé en dur)
- [x] `tools/customRegistry.ts` : liste blanche de 8 outils génériques sûrs (exclut Stripe plateforme,
  Zernio, Apollo, DocuSeal, délégation — spécifiques à Purama ou trop sensibles pour un V1 configurable
  en langage naturel), filtre défensif même si Claude/le mock invente un nom
- [x] `agents/customAgent.ts` : construit un `AgentDefinition` à la volée depuis une ligne `creator_agents`
  (prompt + outils + contexte minimal) — 0 code par agent créé, réutilise `runAgentCycle` intégralement
  (autonomie, kill switch, simulation, logs immuables, notify) sans dupliquer le moteur
- [x] `queue/worker.ts` résout statique OU dynamique selon le préfixe `custom:` du job
- [x] `scheduler/customAgents.ts` : (dés)enregistre les jobs node-cron des agents créés toutes les 5 min
  (contrairement aux 16 agents statiques, planifiés 1 fois au démarrage — ceux-ci changent à la volée)
- [x] Route API `POST /trigger-custom/:agentId` (bearer token) pour le déclenchement manuel
- [x] Edge function `karta-trigger-custom` : vérifie la propriété de l'agent AVANT d'appeler KARTA
  (contrairement aux 12 agents fixes, l'id est arbitraire — pas de whitelist statique possible)
- [x] `creator-agent-generate` : le prompt Claude décrit maintenant les 8 vrais noms d'outils KARTA
  (au lieu de `web_search/send_email/gen_image`, fictifs et jamais exécutables) + filtre whitelist
  défensif sur `suggested_tools` + rate limit 10/h ajouté (manquait)
- [x] **Garde anti-double-traitement** : `creator-agent-run` refuse (409) un déclenchement `trigger=cron`
  si `karta_enabled=true` — empêche n8n (scheduler legacy, toujours actif) et KARTA d'exécuter le même
  agent planifié en parallèle. Vérifié réel : `curl` avec service-role + `trigger:"cron"` → 409 confirmé.
- [x] Frontend : `CreatorAgentNew.tsx` propage les outils/planification suggérés par l'IA dans la création ;
  `CreatorAgentDetail.tsx` → section « Exécution réelle (KARTA) » (toggle, checklist d'outils, niveau
  d'autonomie, kill switch, « Tester maintenant », activité réelle) + planification par presets « zéro
  jargon » (`SCHEDULE_PRESETS`) avec repli cron avancé ; `schedule_input` (legacy n8n) préservé, pas cassé
- [x] 8 tests unitaires supplémentaires (`customRegistry`, `customAgent`) — **38/38 verts** (30 Phase 1-4 + 8 Phase 3)
- [x] `tsc --noEmit` (frontend + karta/) 0 erreur, `deno check` sur les 3 edge functions touchées 0 erreur,
  `npm run build` 0 erreur
- [x] Déployé sur le VPS (edge functions + rebuild `karta-engine`), healthy après redémarrage
- [x] **Test end-to-end réel complet** (user + agent créé de test, JWT réel, nettoyé après coup — 0 trace résiduelle) :
  - [x] `karta-trigger-custom` sans auth → 401, agent inexistant → 404
  - [x] `karta-trigger-custom` avec JWT réel + agent possédé → `{"ok":true,"queued":true}` → vraie ligne
    `karta_runs` (`agent_type='custom:<id>'`, `status:success`, `claude_mock:true`, décision `TODO_LIVE_TEST`)
  - [x] `creator-agent-run` avec `trigger:"cron"` sur un agent `karta_enabled=true` → 409 confirmé (garde anti-doublon)
- [ ] **Non vérifié en direct cette session** : le déclenchement RÉEL d'un job node-cron planifié pour un
  agent créé (le scheduler a été relu/testé unitairement pour la logique de sélection des agents, mais
  observer un vrai déclenchement cron aurait nécessité d'attendre ≥5 min en conditions réelles) — à
  vérifier dès qu'un vrai agent avec planification est activé en usage réel
- [ ] Test humain navigateur du flow complet (génération IA → activation KARTA → tester maintenant → voir
  l'activité réelle) — jamais ouvert dans un vrai navigateur cette session
- [ ] Phase 4 (déjà faite précédemment, cf plus haut) : UX onboarding — reste à décider si le flow
  "Embauche ton 1er employé IA" doit un jour proposer aussi un agent créé sur-mesure, pas seulement les 12 fixes

## AGENTS RÉELS — Phase 4 : UX onboarding "Embauche ton 1er employé IA" ✅ (2026-07-26)
- [x] Proxy sécurisé `karta-trigger` (edge function) : auth JWT + rate limit 10/h + whitelist Zod des 12 slugs, relaie vers l'API interne KARTA (`KARTA_ADMIN_TOKEN` reste 100% serveur, jamais exposé au navigateur)
- [x] Connectivité vérifiée réelle : `karta-engine` (network_mode host) joignable depuis les containers `supabase_default` via la gateway du bridge (`172.19.0.1:4100`, testé par curl réel depuis `supabase-db`)
- [x] `notify()` (KARTA) réécrit pour réutiliser `agent-push-send` (edge function déjà en prod, partagée par tous les agents) au lieu de dupliquer l'insert + gérer le Web Push nous-mêmes — push réel branché (VAPID déjà configuré côté VPS), email réel déjà en place (Resend). Notifie uniquement quand une décision humaine est requise (`awaiting_approval`), jamais sur les cycles autonomes silencieux — conforme au brief §UX/Simplicité
- [x] Échec d'envoi notif rendu non bloquant (try/catch dédié dans `loop.ts`) — un push/email en échec ne doit jamais faire échouer un cycle d'agent déjà réussi
- [x] Composant `HireFirstEmployeeModal` (3 étapes : choix parmi 4 employés sans connexion externe requise → confirmation autonomie niveau 1/simulation → vraie 1ère tâche déclenchée et son résultat réel affiché, avec repli propre si le worker met >20s)
- [x] Bannière d'accroche sur `DashboardOverview` (affichée uniquement si 0 employé actif — signal réel `karta_agent_state`, jamais un flag arbitraire)
- [x] `tsc --noEmit` (frontend + karta/) 0 erreur, `deno check` sur `karta-trigger/index.ts` 0 erreur, `npm run build` 0 erreur, 30/30 tests karta toujours verts
- [x] Déploiement VPS débloqué (lockout SSH résolu côté VPS par Tissma) : `karta-trigger` + `_shared/validation.ts` copiés sur `/opt/supabase/docker/volumes/functions/`, container `functions` recréé (`docker compose up -d functions`, nécessaire pour charger `KARTA_INTERNAL_URL`/`KARTA_ADMIN_TOKEN` — un simple restart n'aurait pas suffi), `notify.ts`+`loop.ts` copiés sur `/opt/karta/src/engine/`, `karta-engine` rebuild+redéployé (`docker compose up -d --build karta-engine`)
- [x] **Test end-to-end réel complet** (user de test créé via GoTrue admin API, JWT obtenu par login réel, nettoyé après coup — 0 trace résiduelle vérifiée) :
  - [x] `POST /functions/v1/karta-trigger` sans auth → 401 (routing + whitelist Zod OK)
  - [x] `POST /functions/v1/karta-trigger` avec JWT réel + `agentType:"crm-intelligent"` → `{"ok":true,"queued":true}`, ligne réelle créée dans `karta_runs` (status `success`, `claude_mock:true`, décision `[MOCK] ... TODO_LIVE_TEST`)
  - [x] `notify()` → `agent-push-send` : appel réel depuis le container `karta-engine`, notification insérée dans `agent_notifications` (id réel vérifié en SQL), `push_sent:0` (cohérent — le user de test n'a aucun abonnement push, comportement attendu)
  - [x] Cascade `ON DELETE CASCADE` vérifiée : suppression du user de test → 0 ligne restante dans `karta_runs`/`agent_notifications`
- [ ] Test humain navigateur du flow onboarding complet (clic bannière → choix employé → 1ère tâche réelle affichée, responsive 375px, dark mode) — jamais ouvert dans un vrai navigateur cette session, cf Loi 2 CLAUDE.md

## P1 - Structure+Auth+DB ✅ (pré-existant)
## P2 - Features core ✅ (6 agents IA, dashboard, pricing)
## P3 - Universels ✅
- [x] Wallet + Transactions + Retrait IBAN
- [x] Points Purama + Boutique + Classement
- [x] Daily Gift (coffre quotidien animé)
- [x] Loterie / Tirage mensuel
- [x] Partage social multi-plateforme
- [x] Cross-promo / Ecosystem
- [x] Streak multiplier
- [x] FAQ / Aide

## P4 - Admin+Guide ✅
- [x] Admin dashboard (pré-existant avec vrais données)
- [x] Page Guide tutoriel (8 étapes interactives)

## P5 - Design+Anim ✅
- [x] Cinématique intro (3.5s, skip, localStorage)
- [x] Aurora BG, noise overlay, glass V3 CSS
- [x] Intégration wallet/points/gift dans dashboard
- [x] Cross-promo bannières dans dashboard
- [x] Sidebar mise à jour (7 nouveaux liens)

## P6 - Audit ✅
- [x] Playwright E2E tests — 52 tests, 3 viewports (1920/768/375), 0 échec
- [x] tsc --noEmit 0 erreur
- [x] npm run build 0 erreur
- [x] grep console.log/TODO = 0
- [x] grep sk_live/password/secret = 0 (que du code auth légitime)
- [x] 8 suites de tests : public-pages, navigation, responsive, console-errors, performance, forms-validation, accessibility, pwa
- [x] Sécurité CRITICAL fixes (2026-07-25):
  - [x] Zod validation 10 edge functions AI (agent-chat, creator-agent-chat, legal-chat, creator-agent-run, legal-build-case, chat, chatbot)
  - [x] Rate limiting AI endpoints (20 req/h chat, 10 req/h agent-run, 30 req/h chatbot)
  - [x] A11y fixes (aria-label Login/Signup Google button, aria-expanded pricing toggle)
  - [x] ErrorBoundary React app (react-error-boundary)
- [ ] Lighthouse (audit live après deploy)
- [ ] i18n 16 langues (hors scope P6 — feature future)

## P7 - Mobile Expo (iOS + Android) 🔄
- [x] Expo 54 project init (mobile/)
- [x] expo-router file-based routing (app/, (tabs), (auth))
- [x] NativeWind + Tailwind config
- [x] Supabase client with SecureStore adapter (0 window/localStorage direct)
- [x] Auth context (email + Google OAuth via WebBrowser)
- [x] 5 tab screens: Dashboard, Agents, Wallet, Points, Settings
- [x] Agent chat screen with n8n integration
- [x] Auth screens: Login, Signup, Forgot Password, OAuth Callback
- [x] UI components: GlassCard, Button, Input, Badge, EmptyState, LoadingScreen
- [x] Hooks: useAuth, useWallet, usePoints, useDailyGift, useAgents
- [x] app.json + eas.json (bundle dev.purama.purama_ai)
- [x] App icons generated (icon, adaptive, splash, favicon, notification, feature-graphic)
- [x] TypeScript strict — 0 erreur
- [x] 0 window/localStorage/document sans Platform.OS guard
- [x] 10 Maestro test flows (auth, signup, navigation, agents, agent-chat, wallet, settings, onboarding, daily-gift, error-handling)
- [x] store.config.json 16 langues (fr, en, es, de, it, pt, ar, zh, ja, ko, hi, ru, tr, nl, pl, sv)
- [x] GOOGLE_PLAY_SETUP.md (guide 3 minutes)
- [x] EAS Workflows (.eas/workflows/full-deploy.yaml)
- [x] GitHub Actions (build-submit.yml + ota-update.yml)
- [ ] EAS build iOS + Android (necessite Apple Team ID + Google Service Account)
- [ ] EAS submit to stores (necessite premier build)

## PRÊT À TESTER DÈS CRÉDIT ANTHROPIC DISPONIBLE (2026-07-26)
> Rien ci-dessous n'est coché `[x]` — c'est écrit, mocké/routé correctement, et vérifié structurellement,
> mais AUCUNE réponse Claude réelle n'a été générée ni jugée. Ne pas cocher avant validation humaine
> avec un vrai crédit. Cf règle permanente en tête de fichier.

- [ ] `karta/.env` : passer `KARTA_MOCK_CLAUDE=false`, redéployer (`docker compose up -d --build`)
- [ ] `createRealClaudeClient()` (`karta/src/claude/real.ts`) : jamais exécuté — valider le parsing des blocs `tool_use` avec un vrai appel Anthropic (tool-use natif), pour chacun des 4 agents cœur
- [ ] Agent Email KARTA : déclencher un cycle réel sur un compte avec OAuth Gmail complété, valider que le brouillon généré est pertinent et bien formé (vs le canevas mock)
- [ ] Agent Comptable KARTA : remplir un `compta_agent_config` réel + quelques `compta_transactions`, valider la catégorisation proposée
- [ ] Agent Juridique KARTA : configurer un `legal_agent_config` réel, valider une génération de document (mise en demeure) + résultat `web_search` (Tavily)
- [ ] Agent Partenariat KARTA : nécessite aussi `APOLLO_API_KEY` (vide actuellement, à obtenir séparément du crédit Anthropic) — valider un email de prospection réel généré
- [ ] Edge function `chat` (assistant site) : valider en navigateur que le streaming affiche une vraie réponse cohérente (routage déjà vérifié OK, cf AUDIT-AGENTS.md Panne #2)
- [ ] Edge function `chatbot` (widget public) : idem + vérifier l'utilisation de la base de connaissances (`chatbot_knowledge`, 47 lignes)
- [ ] `agent-chat`, `legal-chat`, `legal-build-case`, `legal-generate-document`, `creator-agent-chat/generate/run`, `partner-generate-contract/send-outreach/find-prospects`, `social-publish` : déjà routées correctement vers Anthropic direct — jamais testées avec un vrai crédit (11 fonctions)
- [ ] Les 45 agents "chat" du site (`agent-proxy` → n8n → Claude) : au moins 1 test par catégorie (10 catégories) pour valider la qualité de chaque prompt système n8n
- [ ] Coût réel par agent/cycle (tokens consommés) vs les rate limits déjà en place (20-30 req/h) — ajuster si besoin
- [ ] Une fois chaque agent cœur validé en conditions réelles : `karta_agent_state.simulation_mode=false` pour cet agent, PUIS désactiver le workflow n8n équivalent (bascule agent par agent, jamais en bloc)
- [ ] Les 12 agents "action" KARTA (Phase 2) : jamais exécutés avec un vrai appel Claude — valider chacun avec de vraies données (ex: vraies factures `compta_invoices` pour Facture Pro/Chasseur de Paiements, vrais leads `karta_crm_leads` pour CRM/Suivi, vraie boîte Gmail pour Répondeur) avant de désactiver le workflow n8n équivalent
- [ ] `creator-agent-generate` (Phase 3) : valider qu'une vraie génération produit un `system_prompt` de qualité + des `suggested_tools`/`suggested_schedule` pertinents pour plusieurs descriptions réelles variées
- [ ] Un agent créé par un vrai utilisateur, activé en `karta_enabled=true` avec de vrais outils (ex: Gmail connecté) : jamais exécuté avec un vrai appel Claude — le mock a seulement prouvé que le pipeline (déclenchement → décision → outils → log) fonctionne structurellement
- [ ] Scheduler des agents créés (`refreshCustomAgentSchedules`) : jamais observé en conditions réelles déclenchant un job cron planifié (testé unitairement pour la sélection des agents, pas pour le déclenchement cron lui-même en direct)
- [ ] Page "Mes employés IA" (`/dashboard/employees`) : test humain en navigateur (clics activation/kill-switch/autonomie, responsive 375px, dark mode) — jamais ouvert dans un vrai navigateur cette session
