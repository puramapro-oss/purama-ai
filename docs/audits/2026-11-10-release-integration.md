# IAO — intégration vérifiée des correctifs existants

Date : 10 novembre 2026. Base de publication : [PR #27](https://github.com/puramapro-oss/purama-ai/pull/27), commit `5f8d23d46b1aaa103eccb944406eb3e189388c1c`.

## Problème et périmètre

Au début de la qualification, les protections de budgets, d’arrêt des processus et de prospection de #27, au commit `8755a39a3c4a23b64f5b8f0b2909c82d11e732ad`, ne contenaient pas encore les corrections de dépendances de #24 ni la validation de recherche web de #26. Pendant les vérifications, #24 a été intégrée à #27 par le commit `5f8d23d`. Le contrôle avant publication a confirmé l’identité des quatre blobs repris. Notre proposition utilise cette nouvelle base et conserve exactement les mêmes fichiers applicatifs testés, sans réintroduire les trois fichiers de dépendances devenus identiques à la base.

Cette intégration reprend la validation de recherche et les ajustements décrits ci-dessous. Elle ne fusionne pas la branche CHEF #21 : ses migrations et son protocole doivent être rapprochés séparément de ceux déjà présents dans #27.

- #24, `9b066c5b10f6896041aec9359ee21b173c0f5014`, désormais présente dans la base : dépendances OpenTimestamps, test de compatibilité et ajustement du workflow. Les contenus de `package.json`, `package-lock.json` et du test sont identiques aux blobs de cette PR et restent hors du delta publié.
- #26, `a65151540557719ec8adb1bc755f2d05d9e63d3f` : validation des paramètres et réponses de recherche web, identité des résultats, limite de réponse et délai incluant la lecture du corps. Le test de 41 cas est repris intégralement.
- Deux corrections de lint conservent le comportement : détection des caractères ASCII de contrôle sans expression régulière interdite ; déclaration constante du minuteur d’arrêt du processus CHEF.
- Le workflow peut aussi s’exécuter sur `main`, cette branche et manuellement. L’audit npm reste exclu des événements de PR. Les permissions restent `contents: read`.
- Le déploiement automatique de `audit/iao-release-integration-20261110` est désactivé dès le premier commit.

Aucune migration ou modification du schéma SQL n’est ajoutée dans ce delta.

## Vérifications nouvelles sur le contenu intégré

| Contrôle | Résultat |
| --- | --- |
| Recherche web, tests ajoutés exécutés sur le code original #27 | 7 réussis, 34 échoués sur 41 : défauts reproduits |
| Suite KARTA complète après intégration et corrections | **PASS : 971/971**, aucun échec ou cas ignoré |
| TypeScript KARTA et build KARTA | **PASS**, sorties 0 |
| TypeScript de l’application | **PASS**, sortie 0 |
| ESLint global | **PASS : 0 erreur, 30 avertissements existants** |
| Build standard Vite | **PASS**, sortie 0, 20,47 s dans cet environnement |
| Compatibilité des dépendances | **PASS : 5/5** |
| Génération et comparaison des contrats de base | **PASS**, contrôle local PGlite |
| Suite qualité Playwright existante | **PASS : 35/35**, dont 30 scénarios navigateur, 4 validations de contrat et 1 classification de statut |
| Revue indépendante du delta et `git diff --check` | **PASS** |

Exécution sous Node `24.22.1`. Playwright `1.59.1`, Chromium `147.0.7727.0`, un worker et aucune reprise automatique : 84,92 s, aucun test instable ou ignoré. Les empreintes des 314 fichiers source/configuration/tests surveillés sont inchangées pendant cette exécution. Les appels fournisseur et base des tests navigateur sont simulés ; le serveur local est arrêté après la suite.

Les dépendances installées réutilisées ont été comparées aux lockfiles : 575 entrées applicatives et 160 entrées KARTA concordent. Les fichiers de base suivis ont aussi été rapprochés de l’arbre GitHub exact. Les sources et dépendances des autres espaces de travail n’ont pas été modifiées.

Les analyses amont GitNexus avant correction des deux symboles sont classées `LOW`. La détection initiale du delta préparé couvrait 9 fichiers et 38 symboles, avec un risque `LOW`. Après l’adoption du correctif de dépendances en amont, le delta publié porte sur 6 fichiers et est contrôlé de nouveau par comparaison avec l’arbre exact de la nouvelle base. La comparaison complète avec `main` au commit `d116dc8a6429ea76c67167a195eb3f723f2251fb` couvre 403 fichiers, 1 719 symboles et 377 parcours affectés, avec un risque `CRITICAL`. Cette divergence inclut les changements hérités des branches d’intégration et impose une revue séparée avant toute fusion générale.

Le graphe est borné : une absence d’arête ne démontre pas l’absence d’appelant ; la revue directe a complété les résultats. L’objet Git de `main`, absent de la copie initiale, a été obtenu en lecture seule dans les objets d’une copie existante avant cette comparaison.

## Tentatives et limites

Une première vérification TypeScript limitée à 512 Mio a atteint la limite mémoire ; la même commande réussit à 1 024 Mio. Le chargement expérimental Vite `runner` échouait sur `__dirname` dans la configuration existante ; le **build standard**, avec une isolation correcte des fichiers temporaires, réussit sans modification de cette configuration. Le binaire temporaire Chromium initial était vide ; les tests utilisent un binaire existant valide et identifié ci-dessus.

Ces échecs de préparation sont conservés dans les preuves, distinctement des contrôles finaux réussis. Les durées indiquées décrivent cette exécution, pas une garantie de latence utilisateur ou de charge en production.

**NON TESTÉ** : CI sur son runtime Node 22, fournisseur de recherche réel, PostgreSQL natif et migrations de production, concurrence distribuée en service, paiement ou prospection réelle, Safari/iPhone et déploiement. Le dernier run CI de #27 inspecté échouait avant toute étape, avec `runner_id: 0` et `steps: []` ; sa cause n’est pas établie dans cette passe.

**PARTIEL** : les 30 avertissements de lint restent visibles. Les branches concurrentes CHEF et Entraide, les autres PR produit et le raccordement au site public demandent une intégration distincte. Les résultats ci-dessus qualifient cette proposition corrective et ne certifient pas l’ensemble de PURAMA pour une mise en production.
