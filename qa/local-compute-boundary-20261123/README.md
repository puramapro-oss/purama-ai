# IAO — frontière d’acceptation du fournisseur local

Qualification du 23 novembre 2026. Base Git exacte : `6ed27aef751fbe5b8f0d81b05c1b6c17c080c02e`, arbre `1605b25333860acc2974b019cb8ef46845ede5ea`.

## Périmètre et critères

Maintenance correctrice de `LocalComputeFabricProvider`, autorisée dans la reprise de l’audit IAO. Responsable du lot : `/root/iao_review`. Le parent assure l’intégration et toute publication ; ce lot n’effectue aucune action fournisseur, aucun envoi et aucun déploiement.

Les critères sont de refuser les réponses JSON contenant des octets UTF-8 invalides, de ne pas accepter une réponse au-delà de son échéance ou après annulation, et de préserver les réponses Unicode valides, la limite exacte de 2 Mio, le protocole 2 et les identifiants existants.

Un seul fichier produit change : `karta/src/integrations/localComputeFabricProvider.ts`. Le fichier `karta/test/localComputeFabricResponseBoundary.test.ts` ajoute les contre-épreuves natives. Aucun test préexistant, seuil, protocole, dépendance ou verrou de paquet n’est modifié.

## Défauts reproduits et correction

Le décodage `Buffer.toString("utf8")` remplaçait silencieusement les octets incorrects dans une chaîne JSON. Un reçu correctement identifié pouvait alors devenir un succès malgré des données altérées. Le décodage utilise maintenant `TextDecoder` avec `fatal: true`. L’option `ignoreBOM: true` conserve le refus antérieur d’un BOM initial par `JSON.parse`.

La minuterie seule pouvait laisser accepter un résultat après l’expiration de son budget, notamment pendant le décodage, la validation ou le passage d’une promesse à la suivante. `complete` crée maintenant une échéance monotone unique ; la préparation, le transport, les lectures, la validation et le dernier retour vérifient cette même échéance et le signal d’annulation. Les délais natifs du client HTTP utilisent le budget restant.

Les erreurs publiques restent génériques. Le motif privé d’annulation n’est pas exposé. Le protocole 2, les champs de preuve locale, les clés d’idempotence, le digest, les plafonds de 1 024 jetons et d’une seule exécution concurrente restent inchangés. Le contrôle de temps refuse un résultat tardif ; il ne rend pas JavaScript préemptif et ne prouve pas l’arrêt d’un calcul déjà accepté par le démon local.

## Résultats et portée

| Contrôle | Statut | Preuve |
|---|---|---|
| Régression avant correction, transport intercepté | PASS pour la reproduction | 4 cas réussis, 7 échecs d’assertion sur 11 ; `response-intercepted-red.log` et son reçu |
| Même harnais après correction | PASS | 11 cas réussis, aucun échec, aucune exclusion ; `response-intercepted-green.log` et son reçu |
| Typage strict ciblé du fournisseur, du test natif final et des types IAO importés | PASS | `typecheck-post-review-exit.json`, code 0 ; options strictes KARTA conservées |
| Exécution native locale des nouveaux cas | BLOQUÉ | Les 11 cas ont rencontré `listen EPERM` avant d’exercer le produit ; `response-red.log` et `response-red-exit.json` |
| Contre-revue indépendante du code | PASS pour inspection | `/root/inventory_audits`, sans exécution supplémentaire ; `independent-review.json` |
| Impacts GitNexus avant modification | PASS avec limite de révision documentée | `requestFabric` : HIGH, trois symboles amont ; `complete` : LOW, deux symboles amont ; sorties 0 des reprises |
| Analyse finale GitNexus de cette copie isolée | BLOQUÉ | `detect-changes-local-exit.json`, code 1 : absence d’index enregistré pour la copie isolée après les échecs de ressources |
| Suite KARTA complète, compilation globale et fournisseurs réels sur cette modification | NON TESTÉ | Réception CI de la future révision nécessaire ; aucune extrapolation depuis les 4 299 cas historiques |

Les 11 scénarios du harnais intercepté et les 11 scénarios natifs couvrent les mêmes frontières fonctionnelles. Leurs nombres ne s’additionnent pas en 22 preuves indépendantes. Le harnais remplace `http.request` par des flux Node et ne qualifie ni les sockets Unix, ni le nettoyage effectif des connexions, ni le comportement du démon réel. Sa source complète est conservée dans `response-boundary-harness.mjs.txt`.

Après la contre-revue, les témoins d’horloge des seuls tests natifs passent de 99/100 ms à 4 999/5 000 ms, avec une minuterie réelle de cinq secondes. La limite relative reste exacte et cette marge réduit la sensibilité à une CI chargée. Cette version finale est typée ; aucune relance native n’a été effectuée après le refus de socket. Le harnais intercepté conserve ses témoins à 99/100 ms.

## Analyse d’impact et intégration

La chaîne trouvée par le graphe est `requestFabric` → `LocalComputeFabricProvider.complete` → `KartaRuntimeIaoPort.prepare` → `IaoFacade.#prepare`. Le risque HIGH a été signalé avant la modification. Le classement HIGH demeure dans la reprise réussie ; il ne doit pas être attribué seulement à l’erreur de mémoire de la première tentative. L’axe partagé de risque du graphe est LOW ; les deux informations sont conservées sans les confondre.

Le graphe disponible est daté du commit `c4228f5`. La comparaison `git diff c4228f5..6ed27aef -- karta/src` est vide : tous les fichiers source KARTA, dont les cibles et leurs appelants, sont identiques entre ces références. Cette égalité permet une analyse ciblée de l’existant ; elle ne transforme pas le graphe en index frais de la composition finale et ne rend pas ses appels dynamiques exhaustifs.

Le premier index isolé a échoué sur l’espace disque ; sa reprise après déplacement a refusé les métadonnées d’une autre identité de stockage. Aucune métadonnée de protection n’a été réécrite. La copie de travail a été déplacée dans un emplacement temporaire isolé, et le seul index incomplet créé par cet agent a été supprimé après conservation de ses diagnostics. Les autres travaux sont préservés. Les journaux d’échec restent disponibles, ainsi que l’échec final explicite de `detect_changes` sur la vraie copie modifiée.

Le premier typage ciblé a manqué les types ambiants Node, car le fichier de configuration se trouve sous `qa`. La configuration corrigée désigne explicitement les véritables types installés de KARTA ; aucune règle de typage n’a été désactivée. Les diagnostics initiaux et les reçus ultérieurs sont conservés.

## Réception encore nécessaire

Le parent doit intégrer le diff sur la révision canonique courante, vérifier le périmètre composé et recevoir la CI de cette nouvelle révision. Les tests natifs existants de transport, d’annulation et de mémoire, les 11 contre-épreuves nouvelles, le typage et la compilation KARTA doivent passer avant de considérer l’intégration qualifiée. Aucun résultat présent ne constitue une preuve de mise en service sur le Mac ou de déploiement.
