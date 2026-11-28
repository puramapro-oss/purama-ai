# PR 96 — réception de la combinaison avec PR 95

## Pourquoi cette réception supplémentaire

La PR 95 a été fusionnée dans la branche d'audit pendant la CI de la première version de PR 96. Les deux lots partageaient trois fichiers produit identiques et une partie des corrections de la route HTTP. Leurs suites et preuves avaient été créées séparément. La fusion conserve les protections complémentaires et centralise les tests pour éviter une duplication de la même qualification.

- Base commune : `aa3220fca64ba786fb4fcb18daf379ce0d17e7c5`.
- PR 95 : head `a7abb5238c6647b7d59443402acc64bb72e401eb`, fusion `a898622f52891975134ae297f8cd0786a9ab20df`, arbre `c590834e229d96c330053a93fdb927dddb85af80`.
- Première version PR 96 : head `889921991f68d9dcb744ea5af3ca0d40ad82f549`, arbre `8e69b4993305b4fe52823b1bd753c7d830c4bf6b`.
- Les 4 485 tests de PR 95 et les 4 496 tests de la première PR 96 sont des résultats sur deux arbres différents. Ils ne sont pas additionnés et ne qualifient pas à eux seuls la combinaison.
- Les preuves historiques et leurs empreintes restent conservées. Le manifeste du dossier parent décrit la première version de PR 96 ; le présent sous-dossier décrit la réception suivante.

## Protections réunies

La route conserve les gardes de PR 95 contre une admission après déconnexion (`req.aborted`, `res.destroyed`, `res.writableEnded`) et contre une écriture de refus sur une réponse fermée. Elle conserve également l'échéance monotone de quinze secondes par requête, les résultats tardifs ignorés et le contrôle d'arrêt après la métadonnée de budget ajoutés dans PR 96.

`server.ts`, `iaoFacade.ts` et `kartaRuntimePort.ts` sont identiques entre les deux lots ; aucun second chemin d'exécution n'est créé. Le fichier d'intégration de PR 95 est notre version augmentée d'un cas de déconnexion avant admission : ce cas est conservé. Aucun timer concurrent ne borne une tâche déjà admise ni ne raccourcit son drainage.

## Tests sans doublons

- `apiIaoTransportBudget.test.ts` devient l'unique harnais canonique des délais HTTP. Il réunit les preuves de 16 secondes et de connexion persistante de 15 secondes, les gardes d'admission, l'annulation explicite, le timeout fournisseur, le reçu mémoire et la déconnexion après admission.
- `iaoExecutionBudget.test.ts` centralise la matrice des métadonnées, y compris la valeur booléenne et le getter levant une exception. Les mêmes matrices ne sont pas répétées dans le transport.
- `iaoAdmissionDeadline.test.ts` conserve ses neuf scénarios distincts d'échéance, de résultat tardif et de libération des timers.
- `apiIaoResponseBudget.test.ts` est retiré après transfert de sa couverture utile dans le fichier canonique.

## Résultats de la combinaison

- **PASS : 209 tests, six fichiers**, pour les suites existantes d'intégration, identité, façade, rétention, disponibilité et lifecycle. Commande et log dans `regression/`.
- **PASS : preuve native indépendante de pipelining**, une seule exécution de 15,213 s. La seconde réponse est refusée côté serveur après environ 15,021 s, sur le même socket à 241 000 ms ; la première tâche reste active puis termine en 202 `verified`. Aucun accès tardif supplémentaire à la façade. Preuves dans `pipeline/`.
- **PASS : 42 tests, trois fichiers**, comprenant 14 cas de transport, 19 de métadonnées et neuf d'échéance. Le harnais de 16 secondes cumule deux étapes de huit secondes, chacune bornée à douze secondes : il vérifie aussi le budget total des deux étapes. Commande et logs dans `tests/`.
- **PASS : 251 tests uniques dans neuf fichiers**, sans recouvrement entre les deux exécutions ci-dessus. TypeScript et `git diff --check` réussis. Le fichier HTTP redondant est supprimé après transfert de sa couverture.
- La CI complète du nouvel arbre reste exigée avant fusion. Ses identifiants et son arbre seront consignés dans la PR et dans le dossier IAO, sans créer une boucle de nouveaux commits de preuve.

## Audit des dépendances effectivement exécuté

Le workflow ne lance pas `npm audit` pour les événements de pull request. Deux audits complémentaires ont donc été exécutés en lecture seule sur les lockfiles, avec `npm audit --package-lock-only --audit-level=high --omit=dev --json` :

| Périmètre | Code de sortie | Alertes élevées / critiques | Autres alertes |
|---|---:|---:|---|
| KARTA | 0 | 0 / 0 | Aucune signalée. |
| Site | 0 | 0 / 0 | Trois entrées faibles, issues d'une seule advisory propagée dans OpenTimestamps → bitcore-lib → elliptic. |

Résultats bruts et commandes : `security/`. L'advisory [GHSA-848j-6mx2-7j84](https://github.com/advisories/GHSA-848j-6mx2-7j84) concerne la signature ECDSA d'Elliptic ; aucun correctif upstream n'est indiqué dans l'avis consulté le 23 novembre 2026. Le catalogue npm propose une régression majeure vers OpenTimestamps 0.0.0, qui n'est pas traitée comme un correctif compatible.

La limitation d'exposition déjà décrite dans `docs/dependency-reachability-2026-11-12.md` est conservée : un test interdit l'appel de signature lors des parcours de preuve de contrat. Ce test a réussi dans la CI de la première PR 96. L'alerte reste applicable à la dépendance installée et ne vaut pas certification de sécurité de tous ses usages.

## Limites

Les tests utilisent des identités et ports contrôlés. Ils ne qualifient pas un fournisseur API réel, une mémoire SMARANA durable, une autorité de session de production ou une inférence physique. Le délai d'arrêt gracieux existant de trente secondes reste inchangé. La publication vise la branche d'audit ; aucun déploiement de production ni changement du routeur de modèles n'est effectué par ce lot.

## Limites du graphe et réception du delta

L'impact ciblé de `handleIaoRoute` renvoie LOW, avec un appelant direct et un groupe de huit parcours de serveur. Les impacts de fichiers de tests renvoient UNKNOWN : un défaut de résolution de noms de helpers est reproduit et conservé, sans modification de GitNexus. Une lecture des appels et une requête ciblée retrouvent sept relations locales aux tests, sans import externe des helpers non exportés.

L'index final a été recalculé après la déduplication : 29 949 nœuds, 119 234 relations, 558 parcours. `detect_changes(staged)` renvoie CRITICAL (11 symboles, 547 associations de parcours) et la comparaison obligatoire avec `main` renvoie CRITICAL (2 536 symboles, réponse tronquée). Les noms vides et les associations trop larges déjà constatées limitent ces décomptes. La liste des fichiers et le diff Git sont contrôlés séparément ; les protections du produit restent limitées à la route IAO et aux contrats déjà qualifiés. Aucun parcours étranger n'est ajouté par ce rapprochement.

Le graphe ne remplace pas la revue, les preuves natives ou la CI du nouvel arbre. Les sauvegardes intermédiaires de fichiers de tests ne sont pas recopiées dans ce dossier : les deux commits parents conservent leurs contenus complets.
