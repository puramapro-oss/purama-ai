# PURAMA AI — Task Plan V3

## RÈGLE PERMANENTE (Tissma, 2026-07-26)
**Ne jamais bloquer le développement sur le crédit Anthropic.** Il sera rechargé juste avant le vrai
lancement, pas avant. Tout le code doit être écrit, testé structurellement et déployé avec Claude
mocké (`KARTA_MOCK_CLAUDE=true`, réponses marquées `TODO_LIVE_TEST`). Les tests qui nécessitent un
vrai appel Claude sont listés en fin de fichier sous "PRÊT À TESTER DÈS CRÉDIT DISPONIBLE" — jamais
cochés `[x]` tant qu'ils n'ont pas été validés avec un vrai crédit.

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
- [ ] Phase 2 (non commencée) : transformer les 12 agents "action" du site en agents KARTA complets + page "Mes employés IA"
- [ ] Phase 3 (non commencée) : Agent Créateur d'Agents
- [ ] Phase 4 (non commencée) : UX onboarding "Embauche ton 1er employé IA"

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
