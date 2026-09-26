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

### Sous-lot 5 (2026-09-26, XXL) : timeout notify() — AbortSignal réel 15s
- notify.ts : AbortSignal.timeout(15_000) sur agent-push-send + Resend (annulation socket
  RÉELLE, couvre response.text()) — dernier await réseau non borné du chemin succès
- notify.test.ts (nouveau, 4 tests) : branchement ×2 fetch, borne 15s, chemin email,
  erreur FR 502. Note : getUserById (supabase SDK) reste non borné — à couvrir au
  prochain lot si pertinent
- Gates : 103/103 vitest (16 fichiers), tsc 0, build 0

### Sous-lot 6 (2026-09-26, XXL) : borne globale des requêtes Supabase
- db/supabase.ts : boundedFetch (AbortSignal.timeout 30s) en global.fetch du client
  service_role — borne run.finish/recordRunOutcome/loadAgentState/getUserById/tools
  (même classe de défaut que sous-lot 5, identifiée par sa revue /simplify)
- supabase-client.test.ts (nouveau, 2) : branchement + délégation (init préservé, signal ajouté)
- Gates : 105/105 vitest (17 fichiers), tsc 0, build 0

### Sous-lot 7 (2026-09-26, XXL) : fetchWithTimeout — sockets zombies des tools fermés
- lib/bounded-fetch.ts (nouveau) : fetchWithTimeout, AbortSignal 25s < 30s race (abort natif
  gagne, socket fermé) ; migration des 10 fetch nus des 6 tools (gmail OAuth inclus)
- bounded-fetch.test.ts (nouveau, 3)
- Gates : 108/108 vitest (18 fichiers), tsc 0, build 0

## FORMAL ASSURANCE PRÉ-INTÉGRATION KARTA P0 IAO — 2026-09-26 (GLM-1)
Méthode : revue runtime complète + matrice crash + mutation testing + greps + gates.

### Invariant → code → test (2)
I1 faux succès interdit → executeToolStrict/assertToolResult → tool-result 9, loop, approval 2
I2 au plus UN cycle exécutant par (agent,user) → verrou Redis NX/finally → worker 6 dont
   Promise.all vrai parallélisme
I3 rejeu BullMQ seulement sans side-effect → shouldRetryCycle+sideEffectsCommitted → worker 3
I4 approbation exactement-une-fois → claimPendingAction atomique → approval 5 (double/reject/404)
I5 trace des side-effects survit à l échec du cycle → toolsUsed portée fn au catch → loop 2
I6 toute phase du cycle bornée → 60s/120s/30s/25s/15s/30s → loop fake-timers ×2, notify 2,
   supabase-client 2, bounded-fetch 3
I7 orphelins réconciliés au boot → reconcileStaleRuns/OrphanPendingActions → logger 3+approval 3

### Scénarios crash/concurrence (8-19)
workers 2/5/10 : PASS par construction — verrou Redis GLOBAL (pas in-process), indépendant
  de la concurrency BullMQ ; I2 tient pour N workers/process (SET NX atomique跨process).
ordering : finish(journal) AVANT notify AVANT recordRunOutcome — receipt d abord, non fatals
  ensuite → PASS (revue loop.ts:159-188).
cancellation : shutdown gracieux worker.close() attend les cycles en cours (pas d avortement
  brutal) ; AbortSignals clos les sockets ; timers désarmés au finally → PASS.
retry : L✓ I3 ; timeout : M✓ 6 bornes ; crash avant claim → rien créé, job rejoué (claim
  jamais pris) ; crash après claim avant side-effect → ligne "processing" → réconciliée
  failed au boot + job BullMQ: le claim empêche un 2e traitement concurrent, le rejeu du job
  (si pending) re-claimera après reconcile → au pire 1 exécution (idempotence O✓) ;
crash avant side-effect (cycle) → status error, sideEffectsCommitted=false → rejeu sûr ;
crash APRÈS side-effect → sideEffectsCommitted=true → JAMAIS rejoué (I3) + trace toolsUsed ;
receipt perdu (finish échoue aussi au catch) → run "running" → reconcileStaleRuns au boot →
  "error interrompu" ; LIMITITE: toolsUsed perdus en DB (le returnvalue BullMQ garde 500
  derniers) — best-effort documenté, le rejeu reste interdit (I3) → PASS w/ limite.
replay (stalled job) : re-dispatch ~30s < TTL 600s → tryAcquire échoue → SKIP → PASS testé M2.
compensation : N/A volontaire — pas de saga/compensation dans le moteur (aucun outil
  n expose d annulation transactionnelle) ; la compensation humaine = reject avant exécution.

### État runtime (21-27)
état module-level : 0 variable mutable de module dans le chemin cycle (fix S1, test concurrence
  loop) ; isolation worker : portée fn + verrou par identité (test Promise.all) ; cleanup :
  clearTimeout au finally (tool-result), vi.mocked restores en finally (tests) ; AbortController
  : AbortSignal.timeout natif partout (pas de controller manuel fuyard) ; timers : tous
  désarmés au finally ; listeners : 0 listener longévif ajouté ; promises orphelines :
  withTimeout race en laisse une PAR DESIGN (documentée) MAIS sockets fermés par signal 25s
  (S7) → PASS w/ note.

### Contrat tool-result (28-33) → PASS intégral (9 tests + M3: 6 écrans)
params : non re-validés côté loop (délégué aux tools + APIs tierces qui 400 → throw →
  success:false) ; 0 injection possible (whitelist tables supabaseTool + PostgREST).

### Permissions/VAJRA/révocation (34-36) → PASS (ce qui est réellement câblé)
auth bearer KARTA_ADMIN_TOKEN (routes internes) + JWT+RLS+rate-limit (edge fns vérifiés)
  + whitelist agents Object.keys(AGENT_REGISTRY) (1 source) + whitelist 8 tools custom
  + kill switch global/agent (révocation runtime immédiate, cache 5s).
VAJRA fail-closed : N/A — VAJRA n est PAS câblé dans karta (spec _ULTIMATE_PRODUCT_PASS
  statut PROPOSÉE) ; le fail-closed RÉEL = erreurs outils → échec (jamais succès par défaut).

### SATYA/PRAMANA/SMARANA (39-40) → N/A factuel
grep karta/src : 0 occurrence — jamais câblés dans ce moteur. Les receipts RÉELS = karta_runs
  immuable + toolsUsed + reconciliations (I5/I7). Aucune interaction SMARANA réelle.
tenant/actor/purpose (41) : isolation par userId dans chaque clé (verrou, claim, runs, RLS)
  → PASS ; purpose-spacing non applicable (mono-tenant par user).

### Mutation testing (42-44) — 4 mutations, 4 détectées, 10 assertions-écrans
M1 shouldRetryCycle sans garde → 2 échecs ; M2 verrou neutralisé → 1 échec ;
M3 assertToolResult no-op → 6 échecs ; M4 awaitingApproval figé → 1 échec.
Faux verts : aucun sur les mécanismes critiques. Suite 109/109 après ajout du test
vrai-parallélisme Promise.all (gap T comblé).
Analyse 108→109 : 18 fichiers, répartition saine (contrat 23, loop 10, worker 9, approval 12,
  bornes 13, mocks registre 19, crypto 3) ; mocks jamais au-delà de la frontière testée.

### Cross-module/API (48) → PASS
API server routes inchangées ({ok,queued} 202) ; ResolveResult shape identique (distinction
  404/409 préservée via repli) ; edge fn karta-resolve-pending-action (JWT+rate 30/h+regex
  36hex+RLS+pré-check 409) consomme l API telle quelle ; PendingActionsList.tsx → toast
  générique indépendant du resultSummary. Pré-check 409 edge + claim karta = double
  couche cohérente.

### Architecture/second passes (49-51)
49 : /simplify ×7 (12 agents) — altitude validée sur chaque mécanisme (verrou au processing,
  claim au niveau update, bornes à la couche qui possède le transport).
50 : adversarial = mutations 4/4 + detect_changes par sous-lot (LOW/MEDIUM analysé).
51 : 0 TODO/FIXME/debugger dans karta/src ; TODO_LIVE_TEST = balise volontaire (règle
  crédit permanente) ; console.log = 4 logs lifecycle légitimes (boot/shutdown/reconcile).

### Intégration (52-55)
52 map : loop→{autonomy,killswitch,logger,notify,approval,tool-result,claude} ;
  worker→{queues(verrou),loop,resolveDefinition,logger,approval} ; queues→redis ;
  tools→lib/bounded-fetch ; db/supabase→boundedFetch ; AUCUN cycle d import nouveau.
53 ordre : 913d6f2→a7e02a0→322ed09→d673914→ee8cbb6→84d8644→26aad47 linéaire, chaque
  commit vert indépendamment (deps aval avant amont respectées) → PASS.
54 gates post-intégration : 109/109 vitest, tsc --noEmit 0, tsconfig.build 0 — PASS.
55 rollback : git revert des 7 commits (ordre inverse) ; migrations 006/007 idempotentes
  (IF NOT EXISTS) et additives (index seulement — drop sûr si rollback) ; verrou/claim
  rétrocompatibles avec l existant (pas de schéma breaking ; "processing" sans contrainte).

### Checklist VPS FUTURE (56 — SANS exécution)
1. df -h VPS + docker ps baseline ; 2. scp src/ modifiés vers /opt/karta/src/ ;
  3. psql migrations 006+007 (IF NOT EXISTS, ~instantané) ; 4. docker compose up -d --build
  karta-engine ; 5. GET /health 200 ; 6. logs : absence d erreurs reconcile au boot ;
  7. trigger manuel 1 agent simulation → karta_runs success ; 8. 2e trigger immédiat même
  agent → log "SKIPPÉ — verrou" (preuve I2 en prod) ; 9. approbation double-clic UI →
  1 seule exécution (preuve I4) ; 10. verrou libéré après cycle (redis-cli GET clé = nil).

### VERDICT (57) : READY POUR INTÉGRATION — 0 bug prouvé restant
Limites documentées (non bloquantes) : patchParentRun JSONB display race ; owner-token CAD
  verrou (>600s théorique) ; toolsUsed best-effort si double crash finish+catch ; MOCK=false
  live tests bloqués crédit (règle permanente) ; params tools non re-validés côté loop
  (délégué, fail-safe).

### Sous-lot 8 (2026-09-27) : withRunSerialization — lost-update tools_used fermé (best-effort)
- engine/run-lock.ts (nouveau) : verrou Redis court par run_id, budget 2s, dégradé sûr (Redis down
  = avant le fix), TTL 10s, release au finally
- approval.ts patchParentRun : read-modify-write JSONB sérialisé (limite sous-lot 3 fermée)
- Tests : run-lock.test.ts (5) + garde approval — 17/17 ciblés, tsc 0
