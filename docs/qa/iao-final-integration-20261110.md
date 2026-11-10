# IAO — assemblage final du 10 novembre 2026

## Provenance

Base de publication : e859a4235d6af4d0f07fb52eb9ade3734adfa5b5.
Jalon KARTA/AETHER conservé : 1520e37debd16617de842f5388409efd28fe4699.
UI : 5c790c60d907cb2123c37a8077549d048742166b.
OTS : a3dbad12756387bb7c01606818e6ee42b85b4d5b.
Invitation et PDF : 4db2e8dc5544c26afd1252214338374cdcb3fc57.
CHEF : cinq fichiers exacts de 8063016b84b3513af1e52efea79d58dbbaff5682, parent b040af6dd7abe202a4dd7996f0ffad41c1b742bf ; ascendance et 52 fichiers QA exclus.

## Qualification locale

| Suite | Résultat | Preuve |
|---|---:|---|
| KARTA complet | 769/769 ; PASS | evidence-assembly/assembly-karta-full-final.json |
| Commerce plans / handlers | 17 / 40 PASS conservés | sources et dépendances inchangées |
| Fondateur contrats / navigateur | 47 / 16 PASS conservés | sources et dépendances inchangées |
| Qualité navigateur | 46 PASS | assembly-quality-browser |
| Isolation de comptes | 25 PASS conservés | commit UI exact et dix empreintes identiques |
| OTS handlers / Node / Deno réel | 37 / 24 / 3 PASS | gate 64 puis 8 webhook du dernier delta, sans double comptage |
| Contrats montés sous ProtectedRoute | 7 PASS | sources exactes après les quatre commits OTS |
| Types, builds, lint et workflow | voir reçus individuels | qualification structurée |

Lint global : 0 erreur, 23 avertissements.
Le full KARTA initial a terminé à 762/769 avec sept dépassements de 5 s dans chatHistoryIsolation. Le fichier isolé a ensuite passé 39/39 aux mêmes limites. Le replay inchangé termine à 760/769 avec neuf dépassements de 5 s dans ce même fichier. Ces deux échecs sont conservés. Un correctif distinct déplace ensuite la préparation des neuf bases PGlite dans les hooks de setup existants à 30 s, avec une base neuve par cas et un nettoyage qui attend les résolutions tardives. Les actions, assertions, transactions et leur délai de 5 s restent identiques. Ce passage valide les 39 cas chat mais termine à 768/769 : un dernier cas démarrait une seconde base CHEF et neuf migrations historiques dans le test. L’inventaire des 15 constructions PGlite ne révèle aucun autre site de ce type. Ce dernier bootstrap est lui aussi déplacé dans les hooks ; la migration017 et ses quatre assertions/actions restent identiques dans le test à 5 s. Le résultat du passage complet final après ces deux corrections figure ci-dessus. Aucune causalité générale sur la charge du Mac n’est affirmée et aucun processus tiers n’a été modifié.

Les contrôles négatifs ont échoué comme attendu : ancien AdminContracts : 2 PASS / 5 FAIL ; ancien CHEF : 2 PASS / 6 FAIL. Les mêmes scénarios corrigés passent 7/7 et 8/8. Les 8 CHEF sont un sous-ensemble de KARTA. Les 3 Deno sur cache neuf sont un sous-ensemble des 3 tests Deno, pas trois cas supplémentaires.

## Commandes reproductibles

- npm run test:account-isolation
- npm run test:contracts-ots
- npm run test:contracts-ots:browser
- Depuis karta : npm test -- --maxWorkers=1, npm run typecheck, npm run build
- npm run typecheck, npm run lint, npm run build, npm run test:quality
- deno check --no-config --no-lock sur les trois endpoints contracts-ots-stamp, contracts-ots-verify et contracts-webhook
- actionlint -shellcheck= -pyflakes= .github/workflows/purama-chef-hardening.yml

Node 22.23.4, Deno 2.9.7 et Chrome 157 sont les runtimes locaux. La CI prépare Node/Deno/npm et Chromium avant les suites. Les résultats JSON des navigateurs vont dans runner.temp ; le workflow conserve ses journaux, sans nouvel upload d’artefacts.

## Limites et déploiement

Le garde de publication est conservé : git.deploymentEnabled pour audit/iao-integrated-20261110 vaut false. Le fichier vercel.json reste identique au jalon v2 ; toutes ses règles sont false et aucun vercel.ts concurrent n’est présent. Aucune publication, fusion ou mise en production n’est effectuée par cet assemblage.

- No deployment or main merge performed.
- No production provider, payment, signer or private backend request performed.
- Deployed authentication, RLS, schemas, secrets and infrastructure remain unqualified by these local tests.
- No atomic revocation across the final authorization read and external network effects.
- No reconstruction of a historical signed original; the affiliation download is now explicitly unsigned.
- GitNexus had UNKNOWN/name-resolution limitations; final reindex and change detection are recorded separately.
- The unchanged commerce/founder suites are not a coverage percentage; retained and rerun results are not added twice.
- Public production dependency audits retained from unchanged locks: site: 4 moderate and 2 low, KARTA: 0; no new blanket zero-vulnerability claim.
- GitHub CI execution is distinct from local gate success; remote startup failures are not resolved by this patch.

Les reçus complets, commandes, empreintes, échecs historiques et preuves de continuité sont livrés séparément avec le payload Git exact.
