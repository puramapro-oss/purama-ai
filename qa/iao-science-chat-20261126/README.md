# Qualification du scénario scientifique dans le chat — 26 novembre 2026

## Périmètre et correction

Base exacte : `9f1248116459f797588c19b5220017f673d3556f` (PR 125).
Le changement comporte deux lignes dans `tests/chat/science.spec.ts` : le scénario
en ligne déclare explicitement `navigator.onLine = true` avant l'ouverture de la
page. Le scénario hors connexion conserve sa valeur `false`. Aucun code produit,
aucune assertion, aucune règle de réseau ou de validation de reçu n'est modifié.

Le job GitHub `site` 140146914041 du run 45889058072 (fusion de contrôle
`b22549eb4572b2bf88ab5eb4ad531b1153b2b665`) échouait à la première
assertion sur l'iframe, après 63 tests réussis sur 64. Le lanceur CI utilise
Docker `--network=none`; le composant attend volontairement une connectivité
annoncée avant de créer l'iframe. Le test en ligne dépendait donc de l'état réseau
du poste exécutant les tests, au lieu de préciser son propre scénario.

## Vérifications exécutées

Répertoire : `/workspace/scratch/62aaafe90a01/iao-fix`.
Node `v24.22.3`, Playwright `1.65.1`, Chromium `158.0.8127.0` (`/tmp/chromium`).
Les dépendances ont été installées depuis le lock existant avec
`npm ci --no-audit --ignore-scripts`; les manifestes et lockfiles sont inchangés.

| Contrôle | Résultat observé | Code |
| --- | --- | --- |
| `node --test tests/chat/science-entry.test.mjs` sur la base | 6 tests réussis | 0 |
| Scénarios science initiaux sur le vrai harnais Vite et Chromium local | 2 tests réussis | 0 |
| Même scénario avec état hôte simulé hors ligne avant correction | Échec exact à `science.spec.ts:35`, iframe absent ; test hors connexion réussi | 1 |
| Même état hôte hors ligne après correction | 2 tests réussis | 0 |
| `node node_modules/eslint/bin/eslint.js tests/chat/science.spec.ts` | Aucune erreur | 0 |
| `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.app.json` | Aucune erreur | 0 |
| Typage des fichiers science, fixtures et transport avec TypeScript, DOM/ES2023, résolution bundler | Aucune erreur | 0 |
| `PLAYWRIGHT_EXECUTABLE_PATH=/tmp/chromium npm run test:chat` | 64 tests réussis, 0 ignoré, 0 échec (1,4 min) | 0 |
| `git diff --check` | Aucun défaut d'espacement | 0 |

Le diagnostic temporaire importe les deux tests science existants et ajoute
avant chaque scénario un `page.addInitScript` qui retourne `false` pour
`navigator.onLine`. La correction précise ensuite l'état requis par le premier
scénario. Ce diagnostic reproduit la condition pertinente du conteneur CI ;
le conteneur Docker officiel lui-même n'a pas été exécuté localement.

Les journaux voisins conservent la reproduction initiale, la réussite du
diagnostic corrigé et la suite chat complète. Les tests existants vérifient
notamment les reçus de l'atelier, leur provenance, les changements de simulation,
les historiques, l'isolation des comptes, les annulations et les reprises.

## Impact et limites

GitNexus `1.6.12`, index de la base : 37 473 nœuds, 106 791 relations.
Analyse préalable de `IaoScienceTrial` : risque `LOW`, 2 appelants directs
(`ChatbotWidget`, `IaoTrialPanel`), 2 processus affectés. Le composant reste intact.
Analyse du fichier de test : aucun appelant résolu, risque `UNKNOWN`, sans en
déduire une absence de dépendance. `detect-changes --scope unstaged` confirme
un fichier touché sans symbole indexé chevauchant les deux lignes ajoutées.
La revue de diff confirme manuellement la portée limitée au scénario de test.

La comparaison de l'ensemble de la branche avec `origin/main` à
`ae84415be0b9516422805910be999a2c1e6350c0` indique un risque **CRITICAL** :
3 504 fichiers, 27 602 symboles et 730 processus affectés. Elle comprend les
travaux préexistants accumulés dans cette branche et ne qualifie aucune fusion
vers `main`. La présente correction se limite au delta décrit ci-dessus sur
la tête existante de la PR 125.

La recherche FTS de GitNexus est indisponible dans cet environnement. L'index
signale également des limites de résolution de certains appels et processus ;
son résultat ne constitue pas une preuve d'exhaustivité du graphe.

**PASS** : correction locale vérifiée du scénario qui bloquait la suite chat.
**NON TESTÉ** : relance CI distante après publication, déploiement, domaine ONE
réel, solveur distant, XR et appareils physiques. Les documents de ONE sont
simulés dans les tests navigateur ; aucune requête fournisseur ni action
financière réelle n'a été exécutée. Les autres jobs déjà verts de la CI initiale
restent des preuves de cette version initiale, pas d'une nouvelle exécution.
