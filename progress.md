# Progress — Purama AI V3 Update

## Dernier etat : P7 Mobile en cours
## Date : 2026-04-09
## Dernier deploy web : dpl_HZ8zfBFydGv6BLkzRYVSWUQnDZde
## Deploy web : https://purama-ai.purama.dev (200 OK)

## P7 Mobile — Fichiers crees :

### Config (8)
- mobile/app.json (Expo config, bundle dev.purama.purama_ai)
- mobile/eas.json (build profiles: dev, preview, production + submit)
- mobile/tailwind.config.js (NativeWind + Purama colors)
- mobile/babel.config.js (nativewind + reanimated plugins)
- mobile/metro.config.js (NativeWind metro integration)
- mobile/global.css (Tailwind base)
- mobile/tsconfig.json (strict, path aliases)
- mobile/nativewind-env.d.ts

### Lib (3)
- mobile/lib/supabase.ts (SecureStore adapter, purama_ai schema)
- mobile/lib/constants.ts (colors, plans, referral tiers)
- mobile/lib/utils.ts (cn, formatPrice, formatDate, isSuperAdmin)

### Hooks (5)
- mobile/hooks/useAuth.tsx (email+Google OAuth, profile fetch)
- mobile/hooks/useWallet.ts (balance, transactions, withdrawal)
- mobile/hooks/usePoints.ts (balance, lifetime, transactions)
- mobile/hooks/useDailyGift.ts (gift opening, streaks)
- mobile/hooks/useAgents.ts (6 agents, chat via n8n)

### UI Components (6)
- mobile/components/ui/GlassCard.tsx
- mobile/components/ui/Button.tsx (4 variants, loading)
- mobile/components/ui/Input.tsx (label, error)
- mobile/components/ui/Badge.tsx (5 variants)
- mobile/components/ui/EmptyState.tsx
- mobile/components/ui/LoadingScreen.tsx

### App Screens (14)
- mobile/app/_layout.tsx (root layout, fonts, splash)
- mobile/app/index.tsx (auth redirect)
- mobile/app/(auth)/_layout.tsx
- mobile/app/(auth)/login.tsx
- mobile/app/(auth)/signup.tsx
- mobile/app/(auth)/forgot-password.tsx
- mobile/app/(tabs)/_layout.tsx (5 tabs)
- mobile/app/(tabs)/index.tsx (Dashboard)
- mobile/app/(tabs)/agents.tsx (Agent list + search)
- mobile/app/(tabs)/wallet.tsx (Balance + withdrawal + history)
- mobile/app/(tabs)/points.tsx (Points + daily gift + history)
- mobile/app/(tabs)/settings.tsx (Profile + all settings items)
- mobile/app/agent/[slug].tsx (Agent chat with n8n)
- mobile/app/auth/callback.tsx (OAuth callback)

### Assets (6 generated)
- mobile/assets/icon.png (1024x1024)
- mobile/assets/adaptive-icon.png (1024x1024 padded)
- mobile/assets/splash.png (1284x2778)
- mobile/assets/favicon.png (48x48)
- mobile/assets/notification-icon.png (96x96)
- mobile/assets/feature-graphic.png (1024x500)

### Scripts
- mobile/scripts/generate-icons.mjs (sharp SVG→PNG)

## Resultat : tsc 0 erreur, 0 window/localStorage/document direct

## 2026-09-26 — KARTA P0 IAO : bloc exécution centrale (reprise GLM-1 après reboot)

Périmètre IAO/KARTA : orchestration/exécution centrale, concurrence, anti-double-exécution,
validation stricte, permissions, receipts/réconciliation, reprise après erreur.

### Fait (code + tests)
- `engine/tool-result.ts` (nouveau) : contrat formel résultats outils — assertToolResult (faux
  succès interdits : false/{ok:false}/{error}/{status:error} = échec), summarizeToolResult,
  withToolTimeout (30s/outil, timer désarmé au finally), ToolResultError/ToolTimeoutError
- `engine/loop.ts` : bloc central réparé — toolsUsed/sideEffectsCommitted en portée FONCTION
  (fini l état module partagé entre cycles concurrents + toolsUsedRef jamais assigné), timeout
  decide 120s + par outil 30s, assertToolResult, sideEffectsCommitted compté AVANT tentative
  réelle, recordRunOutcome succès non fatal, catch préserve [...toolsUsed]
- `engine/approval.ts` : callErasedTool + withToolTimeout + assertToolResult + summarizeToolResult
  (summarize local supprimé) — un outil approuvé qui retourne {ok:false} = failed, plus executed
- `engine/types.ts` : AnyToolDefinition via never (contravariance), callErasedTool unique point
  de cast, AgentRunResult.sideEffectsCommitted, ToolCallRecord.pendingActionId
- `queue/worker.ts` : shouldRetryCycle() — rejeu BullMQ UNIQUEMENT si error && !sideEffectsCommitted
- `engine/logger.ts` : reconcileStaleRuns() — runs "running" orphelins >1h → error au boot
- `index.ts` : appel reconcileStaleRuns au démarrage (fire-and-forget, non fatal)
- `vitest.config.ts` : postcss inline vide (vite ne remonte plus au postcss.config.js du parent)

### Gates
- vitest karta : 86/86 (15 fichiers ; +tool-result, +worker, +logger ; loop/approval étendus)
- tsc --noEmit : 0 erreur · build karta (tsconfig.build.json) : 0 erreur
- root tsc/build NON relancés : node_modules racine absent (nettoyage anti-saturation post-
  certification, policy §6 pas de réinstall auto) — diff 100%% karta/**, frontend non touché

### Reste (prochains sous-lots)
- Deploy VPS karta-engine (rebuild docker) + vérif /health + 1 cycle réel de smoke
- Bascule simulation_mode agent par agent (bloqué crédit Anthropic, règle permanente task_plan)

### /simplify (règle #17) — 4 agents convergents
Appliqué : executeToolStrict (unique point exécution outils, fusionne timeout+cast+assert+résumé
  pour loop.ts ET approval.ts) ; withTimeout générique + TimeoutError (decide() n est plus un
  ToolResultError) ; worker restructuré (prédicat unique shouldRetryCycle) ; reconcileStaleRuns
  déplacée dans startAgentCycleWorker (le composant qui possède les cycles) ; awaitingApproval
  dérivable (toolsUsed.some(pendingActionId)) ; .catch() one-liners (fini 4 try/catch) ; copie
  [...toolsUsed] et 3e résultat summary supprimés ; migration 006 (index partiel karta_runs
  status=running).
Skippé (documenté) : ToolTimeoutError garde ToolResultError comme base (contrat intentionnel,
  test le épingle) ; parallelisation finish/notify/record (le throw de finish DOIT basculer le
  cycle en erreur — test dédié) ; patchParentRun/stringify pré-existants hors diff ; helpers de
  test (aucun existant à réutiliser). Re-gates : 88/88, tsc 0, build 0.

### Sous-lot 2 (2026-09-26, XXL) : verrou anti-double-exécution à la source
- karta/src/queue/queues.ts : tryAcquireCycleLock/releaseCycleLock (SET NX EX 600 par
  (agentType,userId), clé privée karta:cycle-lock:*)
- karta/src/queue/worker.ts : processAgentCycleJob exporté — acquire au PROCESSING (pas à
  l enqueue, backlog-safe), skip silencieux loggué si verrou tenu, release au finally
  (couvre crash runtime ET stalled jobs BullMQ : re-dispatch 30s < TTL 600s)
- Ferme : overlap cron, cron+manual simultanés, délégation pendant cycle planifié
- Gates : 93/93 vitest karta (worker.test.ts 8 tests : skip/finally/throw/side-effects),
  tsc 0, build 0 · detect_changes LOW/0 processus
- /simplify 4 agents : efficiency CLEAN, altitude validée (jobId dedup = mauvaise couche),
  6 fixes appliqués, skips documentés (owner-token CAD, builder littéral skip)

### Sous-lot 3 (2026-09-26, XXL) : approbation exactement-une-fois (claim atomique)
- approval.ts : claimPendingAction (UPDATE WHERE status=pending RETURNING — 1 gagnant), lecture
  de repli pour distinction déjà-traitée/introuvable, reconcileOrphanPendingActions au boot
  (processing >10min → failed), migration 007 index partiel processing
- Ferme : double-approve / approve+reject simultanés (outil exécuté 2× avant)
- worker.ts : 2e réconciliation fire-and-forget au boot (à côté de reconcileStaleRuns)
- Gates : 98/98 vitest (approval.test : claim gagnant/perdant, simultané, introuvable, orphelins),
  tsc 0, build 0 · detect_changes LOW/0 processus
- /simplify 2 agents : altitude validée, mock allégé 1-source-de-vérité, skips documentés

### Sous-lot 4 (2026-09-26, XXL post-quota) : timeout buildContext (dernière phase non bornée)
- loop.ts : withTimeout + BUILD_CONTEXT_TIMEOUT_MS=60s autour de definition.buildContext()
  (figeait slot BullMQ + tenait verrou anti-double jusqu au TTL 600s sur fetch DB pendant)
- index.ts : commentaire résiduel sous-lot 1 commité (cosmétique)
- Gates : 99/99 vitest (test fake-timers 60s + invariant rejeu-sûr), tsc 0, build 0 ·
  detect_changes LOW/0 processus · /simplify 1 agent 4 angles : CLEAN
