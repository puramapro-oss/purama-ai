# AGENTS-STATUS.md — Purama AI / KARTA Engine

> État réel au 2026-07-27, vérifié (pas déclaré) — cf `task_plan.md` pour le détail phase par phase et
> la règle permanente sur le crédit Anthropic (mock actif tant qu'il n'est pas rechargé, jamais bloquant).
> "Dernier test réussi" = déclenchement manuel réel effectué CETTE session (curl/API réels, vraie ligne
> `karta_runs` vérifiée en SQL), pas une supposition. Là où seuls les tests unitaires couvrent l'agent,
> c'est écrit explicitement — aucune ligne ne prétend un test qui n'a pas eu lieu.

## Légende

- **État** : `déployé` = code en prod sur le VPS et healthy ; `mock` = toutes les décisions viennent du
  mock Claude (`KARTA_MOCK_CLAUDE=true`, réponses `[MOCK] ... TODO_LIVE_TEST`) tant que le crédit
  Anthropic n'est pas rechargé — **jamais** encore de vraie décision Claude, sur aucun agent.
- **Autonomie par défaut** : niveau 1 (propose, validation humaine systématique) + `simulation_mode=true`
  — appliqué automatiquement à la 1ère ligne `karta_agent_state` créée pour cet agent/utilisateur.
- **Validation humaine réelle** (fix QA 2026-07-27) : une action en attente (niveau 1, ou outil sensible
  niveau 2) est journalisée dans `karta_pending_actions` — approuver depuis l'UI (Mes employés IA /
  Créateur d'Agents) EXÉCUTE réellement l'outil, rejeter ne l'exécute jamais. Vérifié réel sur le VPS.
- **Kill switch** : individuel par agent (`karta_agent_state.kill_switch`) + global
  (`karta_global_state.kill_switch`) — les deux à `false` (aucun agent arrêté) au 2026-07-27.

## 4 agents cœur (compte admin Tissma uniquement, remplace n8n)

| Agent | État | Autonomie par défaut | Dernier test réussi |
|---|---|---|---|
| `email` | déployé, mock | 1 / simulation | Couvert par les tests unitaires du moteur (mock, autonomie, boucle) — pas de déclenchement manuel individuel cette session |
| `compta` | déployé, mock | 1 / simulation | **Phase 1** : déclenchement manuel réel via API → job traité par le worker → ligne réelle `karta_runs` (mode simulation, décision mock, 28ms) |
| `legal` | déployé, mock | 1 / simulation | Couvert par les tests unitaires du moteur — pas de déclenchement manuel individuel cette session |
| `partner` | déployé, mock | 1 / simulation | Couvert par les tests unitaires du moteur — pas de déclenchement manuel individuel cette session |

Cadences : email */2min, compta 6h/j, legal 5h/j, partner */30min. Config métier propre
(`email_agent_config`/`compta_agent_config`/`legal_agent_config`/`partner_agent_config`) — `is_active`
sur ces tables fait foi pour savoir si l'agent a du travail, pas `karta_agent_state`.

## 12 agents "action" (multi-tenant, marketplace `purama_ai.agents`)

| Agent | État | Autonomie par défaut | Dernier test réussi |
|---|---|---|---|
| `repondeur-intelligent` | déployé, mock | 1 / simulation | Tests unitaires (mock partagé avec `email`) |
| `campagnes-par-courriel` | déployé, mock | 1 / simulation | Tests unitaires (fallback générique) |
| `pro-de-la-sensibilisation-au-froid` | déployé, mock | 1 / simulation | Tests unitaires (fallback générique) |
| `newsletter-genie` | déployé, mock | 1 / simulation | Tests unitaires (fallback générique) |
| `facture-pro` | déployé, mock | 1 / simulation | Tests unitaires (fallback générique) |
| `chasseur-de-paiements` | déployé, mock | 1 / simulation | Tests unitaires (fallback générique) |
| `rapports-financiers` | déployé, mock | 1 / simulation | Tests unitaires (fallback générique) |
| `crm-intelligent` | déployé, mock | 1 / simulation | **Phase 2** : lead réel inséré → déclenchement manuel réel → décision mock correcte → ligne réelle `karta_runs`. **Phase 4** : re-testé end-to-end via `karta-trigger` (proxy edge function), 401 sans auth confirmé, `{"ok":true,"queued":true}` avec JWT réel confirmé |
| `machine-de-suivi` | déployé, mock | 1 / simulation | Tests unitaires (fallback générique) |
| `maitre-des-publicites` | déployé, mock | 1 / simulation | Tests unitaires (fallback générique) — mappé sur "Offres" du brief (interprétation, pas un nom exact du catalogue) |
| `planificateur-d-appels` | déployé, mock | 1 / simulation | Tests unitaires (fallback générique) |
| `reservation-intelligente` | déployé, mock | 1 / simulation | Tests unitaires (fallback générique) |

Cadences : répondeur */5min, CRM/suivi */30min, RDV/planificateur */15min, factures/paiements quotidien,
rapports/newsletter/pubs hebdomadaire (lundi). Activation par utilisateur via page **Mes employés IA**
(`/dashboard/employees`) — écriture directe RLS sur `karta_agent_state`, 0 API custom.

## Agent Créateur d'Agents (agents dynamiques créés par les utilisateurs)

| Composant | État | Dernier test réussi |
|---|---|---|
| Génération NL → config (`creator-agent-generate`) | déployé, **jamais appelé avec un vrai crédit** (bloqué par le crédit Anthropic, comme tout le reste) | Non testé en direct — routage + whitelist d'outils vérifiés par lecture de code + `deno check`, pas d'appel réel |
| Exécution réelle KARTA (`karta_enabled=true`) | déployé, mock | **Phase 3** : agent de test créé en SQL → déclenché via `karta-trigger-custom` avec JWT réel → `{"ok":true,"queued":true}` → vraie ligne `karta_runs` (`agent_type='custom:<id>'`, décision mock `TODO_LIVE_TEST`). Garde anti-double-traitement (409) vérifiée réelle |
| Scheduler cron dynamique | déployé | Sélection des agents testée unitairement — déclenchement RÉEL d'un job cron planifié jamais observé en direct (nécessite ≥5 min d'attente en conditions réelles) |
| Chat historique (`creator-agent-chat`) | déployé, pré-existant, inchangé | Fonctionnalité antérieure à KARTA, hors périmètre de cet audit |

Autonomie par défaut identique aux agents statiques (niveau 1, simulation, via `karta_agent_state`
`agent_type='custom:<id>'` — même mécanisme, aucune duplication).

## 45 agents "chat" du site (marketplace, `agent-proxy` → n8n)

Hors périmètre KARTA (système séparé, cf `AUDIT-AGENTS.md`) — chat uniquement, pas d'exécution d'outils.
Bloqués par le même manque de crédit Anthropic. `purama_ai.agents` reseedée (45/45, icônes emoji
corrigées) — marketplace fonctionnel pour la découverte/navigation, mais aucune réponse réelle possible
tant que le crédit n'est pas rechargé.

## Ce qui reste avant un vrai lancement (cf détail complet dans `task_plan.md`)

1. Recharger le crédit Anthropic (règle permanente : pas avant le lancement réel)
2. Valider chaque agent (16 statiques + Créateur d'Agents) avec au moins 1 vrai appel Claude
3. Bascule progressive `simulation_mode=false` agent par agent, jamais en bloc
4. Test humain navigateur des 3 pages construites cette session (Mes employés IA, onboarding, Créateur d'Agents/Exécution réelle) — jamais ouvertes dans un vrai navigateur
