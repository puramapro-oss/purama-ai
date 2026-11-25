# Vérification du livrable final

Pour toute tâche substantielle, appliquer la boucle de vérification d'IAO :

1. Examiner le travail existant et fixer des critères d'acceptation observables, proportionnés à la demande.
2. Produire le résultat, puis contrôler sa version finale avec les outils capables d'en vérifier le comportement et les modalités pertinentes.
3. Corriger les défauts constatés et refaire les contrôles affectés. Une modification invalide les preuves qu'elle peut affecter ; rattacher chaque preuve au commit ou à l'empreinte de l'artefact contrôlé.
4. Vérifier le résultat des actions avec leurs reçus réels. Un export, un code de sortie zéro ou l'affirmation d'un modèle ne suffisent pas à prouver la qualité. Une transcription ou un spectrogramme ne prouvent pas une écoute ; un échantillon ne prouve pas une couverture complète.
5. Respecter le périmètre autorisé, les budgets et les arrêts. Avant toute reprise d'une action externe à issue inconnue, rapprocher son identifiant de l'état du service ; ne pas relancer aveuglément.
6. Rapporter les preuves et les limites avec les statuts PASS, PARTIEL, BLOQUÉ ou NON TESTÉ. Ne pas prétendre à un test, un déploiement, une observation ou un accès non effectué.

Réutiliser la politique canonique `karta/src/claude/assistant-policy.ts` et le vérificateur CHEF existant ; ne pas créer un orchestrateur concurrent ni une copie de la politique par fournisseur. Une connexion API n'ajoute pas les capacités absentes du modèle, de son adaptateur ou de ses outils. Le contrat d'observation et ses limites sont décrits dans `docs/iao-observed-verification.md`.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **purama-ai** (4176 symbols, 9366 relationships, 279 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/purama-ai/context` | Codebase overview, check index freshness |
| `gitnexus://repo/purama-ai/clusters` | All functional areas |
| `gitnexus://repo/purama-ai/processes` | All execution flows |
| `gitnexus://repo/purama-ai/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
