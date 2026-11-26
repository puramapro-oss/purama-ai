# IAO — interruption effective des lectures publiques

Réception du 26 novembre 2026. Base : `271f40b666c11d90fe4a350a41432513a08fc72f`.
Branche candidate : `fix/iao-tool-cancellation-20261126`.

## Résultat

**PASS local : 5 937 tests réussis dans 238 fichiers, zéro échec, zéro test ignoré. Typage complet, compilation et revue indépendante : PASS.**

La réception finale utilise Node 22.23.5 et un worker, avec les assertions, délais et règles d'isolation existants. Elle termine avec code 0 le 26 novembre 2026 à 05:27:27 UTC (06:27:27 Europe/Paris). Les sources du candidat et l'état Git sont identiques avant et après. Le résultat utilisateur transversal reste PARTIEL : ce lot ne qualifie pas le contrôle universel des applications.

Deux défauts sont corrigés dans les lectures programmatiques existantes : le signal du cycle n'atteignait pas les transports web/connaissances ; une source de connaissances pouvait être réadmise alors que le nettoyage de sa réponse précédente était encore en attente. Les cinq fichiers produit et les cinq fichiers de tests sont identifiés dans `cancellation-final-manifest.json`.

Le champ facultatif `ToolExecutionContext.signal` reprend le contrat compatible de PR 7 (`caeff811a3ba75dd766cc02555ed196e3807663f`) et conserve les champs actuels `trigger` et `operationId`. L'ancien moteur de cette PR n'est pas fusionné. La documentation `karta/WEB_CAPABILITIES.md` distingue désormais la route directe historique du mode opt-in de lectures programmatiques déjà existant.

## Comportements vérifiés

- Un signal déjà annulé ne déclenche aucune requête.
- Le signal reçu et la fin du cycle atteignent les lectures programmatiques encore ouvertes.
- L'interruption se propage au transport et à la lecture du corps ; le journal reste immuable après fermeture.
- Les délais propres aux outils bornent l'attente de l'appelant, même si le transport ignore l'annulation ; les résultats tardifs sont rejetés.
- Les raisons privées d'annulation et les erreurs fournisseur restent hors des erreurs publiques.
- Les écouteurs sont retirés ; un transport réussi n'est pas annulé rétroactivement.
- Une source reste occupée jusqu'au règlement réel du transport et des promesses de nettoyage suivies. La réponse d'annulation reste rapide ; après le nettoyage, le délai entre requêtes s'applique.

Cette réservation est celle d'une instance de worker. Elle ne constitue pas un quota distribué entre workers ni une preuve universelle d'arrêt chez un fournisseur.

## Régression avant/après

Les **mêmes cinq fichiers de tests finaux** ont été exécutés sur le code de base puis sur le candidat, sous Linux, Node 24.22.3 et Vitest 5.0.3.

| Fichier | Base : PASS / FAIL | Candidat : PASS / FAIL |
| --- | ---: | ---: |
| `loopProgrammaticReads.test.ts` | 75 / 4 | 79 / 0 |
| `knowledgeSearch.test.ts` | 53 / 7 | 60 / 0 |
| `webSearchCleanup.test.ts` | 9 / 2 | 11 / 0 |
| `webSearchTransportIntegrity.test.ts` | 6 / 4 | 10 / 0 |
| `readToolCancellationHttp.test.ts` | 2 / 4 | 6 / 0 |
| **Total** | **145 / 21** | **166 / 0** |

Les reçus retenus sont `cancellation-final-before.json` et `cancellation-final-after.json`, accompagnés de leurs journaux. Le premier termine avec code 1, le second avec code 0 ; aucun cas ignoré et aucune erreur de harnais dans ces deux reçus finaux. Les itérations de développement et les 511 tests de l'ancienne réception `40e97b0` ne sont pas additionnés à cette campagne.

Les six essais HTTP utilisent un vrai serveur local `127.0.0.1` : deux témoins de succès et quatre annulations, pendant l'attente des en-têtes et pendant la lecture du corps. Le harnais attend l'acquisition effective du reader dans les cas « corps », puis observe la fermeture côté serveur. Il exerce les vrais outils avec un transport Node HTTP dirigé exclusivement vers ce serveur ; il ne qualifie pas un fournisseur externe.

### Défaut supplémentaire identifié par la revue

La revue indépendante a observé une deuxième requête alors que la première promesse de `reader.cancel()` restait en attente. Les deux variantes du test vérifient son règlement par résolution ou rejet. `cancellation-cleanup-before.json` isole les deux échecs sur le candidat intermédiaire : 2 échecs, 58 cas non sélectionnés, aucune erreur de harnais. Les deux variantes passent dans les 166 tests finaux.

La contre-vérification indépendante reçoit maintenant la séquence : une seule requête et `busy` pendant le nettoyage, `rate_limited` après son règlement, puis deuxième requête après le délai. Les empreintes examinées et les limites de cette preuve figurent dans `independent-review.json`.

## Réception complète du candidat

La suite définie par `npm test` dans KARTA, le typage incluant les tests et la compilation produit sont exécutés dans un clone Mac isolé, avec Node 22.23.5, version également observée dans la CI de la base. L'identité des 455 fichiers KARTA est rapprochée entre environnements ; les fichiers de code et de tests restent inchangés pendant la réception. Les dépendances proviennent d'un cache existant rapproché du lockfile, sans modification de ce cache : 178 paquets applicables concordent, avec 54 exclusions de plateformes non applicables et aucun écart.

| Contrôle final | Résultat |
| --- | --- |
| Suite Vitest entière, un worker | **5 937/5 937 PASS**, 238 fichiers, aucun échec, aucun ignoré, code 0. |
| Typage incluant sources, scripts et tests | **PASS**, code 0. |
| Compilation produit | **PASS**, code 0. |
| Identité des sources et état Git avant/après | **PASS**, inchangés. |

Le reçu `verification/final-gate.json` contient les commandes, l'environnement, les durées et les comptes par fichier. Le JSON complet est conservé dans `verification/full-karta.json.gz` ; son SHA-256 après décompression est `fbee5cb25a38fbf0082809e845e7088d8ede577b23b92e21e18ee00c5c44b063`. L'exécution de la suite complète dure 691,467 secondes. Aucun délai individuel ni assertion n'a été modifié pour obtenir ce résultat.

Le premier passage global a utilisé une copie limitée à KARTA. Des tests chargent aussi les migrations et fonctions de `supabase` et d'autres sources du dépôt : ce banc était incomplet. Il a été interrompu avec code 130 ; aucun succès global ne lui est attribué. Ses journaux et son diagnostic restent dans `verification/first-incomplete-checkout/`. Une copie complète du même commit a ensuite été matérialisée, avec 3 880 fichiers suivis, sans changement des sources KARTA du candidat. La réception complète utilise cette copie et les délais de tests existants.

Le typage complet et la compilation ont terminé avec code 0 sur les sources finales sous Node 22.23.5. Leurs preuves sont conservées et réutilisées après vérification que leurs entrées KARTA sont inchangées ; l'ajout des fixtures de la suite d'exécution ne modifie pas ces entrées.

Le passage complet à deux workers a recensé **5 937 cas : 5 860 PASS, 5 FAIL par dépassement de délai, 72 ignorés à la suite de deux hooks en échec**. Cinq fichiers sont concernés : `overageCredit`, `briefSubmission`, `chefEvidenceFreshness`, `chefBudgetMigration` et `partnerChat`. Les cinq tests et les deux hooks en échec signalent tous un délai dépassé ; les fichiers et migrations concernés sont inchangés depuis la base. Les reçus de ce passage restent conservés sous `verification/parallel-2-reception/`.

Une reprise des cinq fichiers avec un worker reçoit **120/120 PASS**, sans modifier leurs assertions, délais ni isolation. Les 47 empreintes de code, tests, configurations et migrations retenues sont identiques avant et après. Le succès de cette cohorte ne démontre pas la cause précise des dépassements précédents ; il ne transforme pas le passage global rouge en succès. La dernière suite complète à un worker reçoit ensuite **5 937/5 937 PASS** et constitue la réception globale retenue. Les passages antérieurs restent conservés avec leurs statuts réels.

Les **166 tests ciblés** et les **120 tests de reprise SQL** recouvrent des cas de la suite complète. Ils ne s'ajoutent ni entre eux ni au total final : la réception compte les cas uniques de la dernière suite globale.

## Analyse d'impact et périmètre

`scope.json` fixe les critères C1–C10 et les responsabilités avant implémentation. Les analyses GitNexus précèdent les éditions : `ToolExecutionContext` est classé **CRITICAL**, avec 52 références directes ; l'ajout reste facultatif et justifie la suite KARTA complète. Les points locaux d'annulation et de nettoyage sont classés LOW. Les dispatchs dynamiques non résolus sont conservés comme limites ; aucune absence d'appelant n'en est déduite.

`gitnexus-before.json` conserve les analyses initiales et le rapprochement des 399 sources indexées avec la base. `gitnexus-before-cleanup.json` conserve l'analyse complémentaire précédant la correction du nettoyage. Une première revue finale reçoit 54 symboles modifiés et 30 flux affectés, risque CRITICAL ; ses chemins correspondent au moteur, aux deux transports, à leurs tests et à la documentation. La comparaison avec `main` (`ae84415be0b9516422805910be999a2c1e6350c0`) inclut l'écart historique de la consolidation : 3 502 fichiers, 11 099 symboles et 675 flux, avec une liste tronquée. Ce grand écart n'est pas attribué au seul correctif. Les sorties sont conservées dans `verification/`.

L'index final a été construit sur KARTA et les fichiers racine visibles avant l'ajout des autres fixtures ; les sources KARTA indexées sont identiques à celles de la réception complète. L'index annonce explicitement des limites d'exploration des flux et des dispatchs non résolus. La lecture des usages et la revue manuelle du diff complètent l'analyse ; aucun résultat d'indexation n'est présenté comme une couverture exhaustive du dépôt.

## Android : diagnostic séparé

Le run [45733255220](https://github.com/puramapro-oss/purama-ai/actions/runs/45733255220), sur la tête de consolidation, échoue dans la préparation réseau de l'émulateur : une SIM est chargée, mais `defaultDataSubId` reste `-1`. Les 56 tests de préparation JavaScript passent ; le job Apple réussit ; la qualification Android de l'application est sautée.

L'artefact exact, son empreinte, les 28 observations, les sources Android examinées et l'inventaire local figurent dans `android-diagnostic.json`. La garde est cohérente avec l'état observé. Le parcours Settings susceptible d'initialiser la DATA doit être qualifié sur l'image API 35 exacte du CI ; l'image locale disponible est différente. Aucun résultat natif positif n'est attribué à ce diagnostic.

## Limites du résultat utilisateur

Le lot corrige l'interruption des deux outils de lecture existants. Le navigateur opérateur, son worker isolé, l'admission depuis la conversation principale ONE, le flux d'écran et les événements de pointeur restent des raccordements distincts. La qualification de tous les appareils, des fournisseurs externes et de la production reste NON TESTÉE dans cette réception.

Le candidat local est préparé pour revue. La publication distante et le déploiement ont leur propre autorisation et leur propre réception ; aucun succès local n'est assimilé à une mise en production.
