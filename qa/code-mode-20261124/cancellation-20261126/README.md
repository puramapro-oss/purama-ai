# IAO — interruption effective des lectures publiques

Réception initiale du 26 novembre 2026. Base : `271f40b666c11d90fe4a350a41432513a08fc72f`.
Branche candidate : `fix/iao-tool-cancellation-20261126`.

## Rapprochement avec la consolidation `893fc5c`

**PASS logiciel : 5 968/5 968 tests dans 238 fichiers, zéro échec et zéro ignoré ; typage complet et compilation PASS.** Le correctif déjà qualifié est conservé dans le commit local `9a2e4b59801974b4d61dcd9a6aa5d17512f5de6a`. La consolidation `893fc5cb14e0039e40c060b51532ea0feefd1864` est rapprochée sans conflit : 95 fichiers amont, aucune intersection avec les dix fichiers produit/tests de ce correctif. L’arbre de rapprochement, avant nouveaux reçus documentaires, est `2ba3f2f56240595aee6a0e54a7dd700bd96217d3`, identique dans les deux environnements.

Le delta amont ajoute 31 tests KARTA et modifie trois sources de validation/projection des résultats privés ainsi que la migration 037. Cette chaîne partage la persistance utilisée par le moteur ; l’absence de conflit Git ne suffit donc pas à qualifier la combinaison. Les impacts préalables contiennent des points HIGH et CRITICAL. La revue statique indépendante n’identifie aucun défaut concret de composition ; elle vérifie notamment les six changements SQL de longueur limités à `qualify_resolution`, la conservation des autres branches et des limites d’enveloppe. Le reçu est `verification/reconciliation-893-static-review.json`.

La CI amont reçoit 5 948/5 948 tests dans 237 fichiers ; elle ne constitue pas la preuve du candidat combiné. La réception locale complète est terminée sur les sources combinées, en un passage séquentiel avec un worker et les délais inchangés. Le collecteur s’exécute du 26 novembre 2026 à 05:54:08 UTC jusqu’à 06:05:59 UTC (07:05:59 Europe/Paris). Typage : 22,530 s ; build : 11,418 s ; Vitest : 675,021 s mesurées par le collecteur, 673,95 s rapportées par Vitest. La gate entière dure 710,706 s. Les 1 070 empreintes de sources/tests/configurations/migrations, l’état Git et les neuf anciens reçus suivis sont inchangés. Les fichiers d’environnement, QA et documentation sont exclus dès l’inventaire des sources.

Le nouveau reçu est `verification/reconciliation-893/final-gate.json` ; son SHA-256 est `e3f1e2c3f57c248ec22e94d3eb01742d3beb553073011b664778913ceffc5d42`. Le rapport Vitest complet est conservé en gzip sans altération des octets : SHA-256 après décompression `60d1bb1740864413e43b856e6d727c6f65895a60db83b9f8986cb06ee76a7283`. Les preuves du checkpoint ci-dessous restent intactes. La revue finale du graphe est terminée avant commit de rapprochement ; les commandes, leurs sorties et leurs limites sont conservées dans le même dossier.

Les avertissements de blancs du diff de fusion portent sur des journaux bruts déjà présents dans les commits amont. Ces octets de preuve sont conservés. Le diff propre au correctif, comparé à `893fc5c`, passe le contrôle de blancs ; aucune normalisation silencieuse des traces amont n’est effectuée.

## Résultat du checkpoint initial

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

## Réception complète du checkpoint initial

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

### Analyse du rapprochement final

L’index est ensuite reconstruit sur le dépôt complètement matérialisé, avec les filtres standards inchangés, en mode index seul : **37 842 nœuds, 108 344 relations, 954 groupes et 748 flux**. L’indexation termine avec code 0 et l’état Git reste inchangé. Le contrôle `all` couvre les 95 fichiers amont encore staged : 590 symboles, 16 flux, CRITICAL. Le contrôle comparé à `893fc5c` couvre les 47 fichiers du checkpoint propre au correctif : 63 symboles, 6 flux visibles, HIGH. La comparaison avec `origin/main` reçoit 3 595 fichiers, 27 883 symboles et 731 flux, CRITICAL, pour l’écart historique global. Ces périmètres et ces comptes ne sont pas additionnés.

Les nombres de flux diffèrent de l’index KARTA précédent parce que le périmètre et la sélection des points d’entrée ont changé. Cela ne démontre pas une diminution du risque. L’analyse finale annonce 2 423 candidats d’entrée non sélectionnés, 6 062 appels écartés par sa limite de branchement, 62 parcours arrêtés par budget et quatre anciens reçus QA supérieurs au seuil standard de 512 Ko. Le détail affiché par la CLI est également tronqué. Aucune absence de chemin ou exhaustivité de contrôle n’en est déduite.

La documentation et les reçus ajoutés après la constitution de l’arbre testé sont revus séparément. Les dix fichiers produit/tests du correctif sont inchangés ; les **1 070 empreintes de la copie locale concordent toutes avec la copie Mac reçue**, sans fichier manquant ni écart. Le manifeste de réception est `verification/reconciliation-893/gate-artifacts.json`. La comparaison du diff propre au lot ne contient que les cinq sources, leurs cinq tests, la documentation et les preuves ; aucun autre changement produit n’est introduit par cette finalisation.

## Android : diagnostic historique et réception amont séparée

Le run historique [45733255220](https://github.com/puramapro-oss/purama-ai/actions/runs/45733255220), sur la tête de consolidation, échoue dans la préparation réseau de l'émulateur : une SIM est chargée, mais `defaultDataSubId` reste `-1`. Les 56 tests de préparation JavaScript passent ; le job Apple réussit ; la qualification Android de l'application est sautée.

L'artefact exact, son empreinte, les 28 observations, les sources Android examinées et l'inventaire local figurent dans `android-diagnostic.json`. La garde est cohérente avec l'état observé. Le parcours Settings susceptible d'initialiser la DATA doit être qualifié sur l'image API 35 exacte du CI ; l'image locale disponible est différente. Aucun résultat natif positif n'est attribué à ce diagnostic.

La nouvelle tête `893fc5c` reçoit ensuite un contrôle réseau Android PASS sur la même image API 35 : DATA devient disponible à la septième observation, après 6,752819 secondes, puis l’observateur reçoit trois observations hors ligne stables. Le parcours Settings n’a pas été exécuté, car la préparation initiale réussit. À la réception du 26 novembre à 05:47:49 UTC, sept workflows amont sont PASS. L’observation complémentaire de 06:05:11 UTC confirme la compilation téléphone/Wear et les tests Kotlin PASS ; l’APK de qualification hors ligne est en préparation et Apple compile encore. L’inférence réelle et la mémoire chiffrée après redémarrage restent en attente de preuve. Les deux exécutions et leurs artefacts restent distincts dans `verification/upstream-893-reception.json`. Ce succès réseau ne qualifie pas à lui seul l’application Android ni une correction permanente de l’initialisation.

## Limites du résultat utilisateur

Le lot corrige l’interruption des deux outils de lecture existants. La revue du candidat combiné distingue les parcours déjà raccordés et les raccordements encore manquants :

| Parcours audité | Constat de code et limite de preuve |
| --- | --- |
| Conversation générale ONE | `ChatbotWidget.sendMessage` appelle la fonction Edge `chatbot`, qui diffuse du texte via `streamAnthropicChat`. Ce chemin ne déclenche pas `runAgentCycle`. |
| Analyse approfondie | `ConsultationPanel` appelle `iao-consultation`, puis la route KARTA `/consultations/{userId}` et l’hôte de consultation. Le raccordement pour consultation/recherche/lecture existe, avec suivi et annulation. |
| Agent créé | `CreatorAgentDetail` → `useTriggerCustomAgent` → `karta-trigger-custom` → `/trigger-custom/{agentId}` → file → worker → `runAgentCycle`. Le reçu 202 confirme l’admission en file ; la réussite de la mission exige son reçu final. |
| Façade générale IAO | Le démarrage `karta/src/index.ts` appelle `startApiServer(readiness, { lifetime })` sans injecter `iaoRuntime`. Dans ce démarrage audité, `/iao/requests` répond `503 IAO runtime unavailable`. La présence d’une clé fournisseur ne complète pas cette composition. |
| Navigateur opérateur et aperçu | `plan_web_access` prépare une route ; aucun pilote navigateur avec captures et événements de pointeur raccordé aux parcours lus n’a été identifié. Le protocole de capacités du worker CHEF reste un point d’intégration ; sa présence ne prouve pas qu’un exécuteur navigateur y soit installé. |

La composition générale requiert un `IaoRouteRuntime` contenant une façade et un authentificateur. `IaoFacade`, `KartaRuntimeIaoPort` et `LocalComputeFabricProvider` existent, mais le démarrage standard ne les assemble pas. Le port mémoire attendu doit porter des permissions, des reçus UUID et une déduplication durable ; l’authentificateur doit établir la relation révocable tenant/acteur ; le port de calcul doit satisfaire le protocole et le rejeu durable. La revue ne remplace pas ces autorités par des valeurs synthétiques. Le raccordement de la conversation textuelle ne livrerait pas à lui seul le pilote navigateur. Les anciens travaux mémoire/calcul ont été retrouvés dans sept lignées canoniques et comparés en lecture seule : les adaptateurs T03, les factories T04 et le gateway Fabric existent, avec des contrats ou une durabilité de reprise différents. Leurs modifications suivies et réservations sont préservées. La continuité détaillée figure dans `scope_audit.continuity_followup` du reçu de revue.

Ces constats sont statiques et circonscrits aux chemins lus. Ils ne prouvent pas l’absence de capacités dans d’autres hôtes ou branches. La configuration déployée, les fournisseurs externes, les appareils physiques et l’aperçu direct réel restent NON TESTÉS. Le détail des points d’entrée figure dans `verification/reconciliation-893-static-review.json`.


Le candidat local est préparé pour revue. La publication distante et le déploiement ont leur propre autorisation et leur propre réception ; aucun succès local n'est assimilé à une mise en production.
