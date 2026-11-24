# IAO — cohérence des reçus et annulations

## Correctif et portée

Base `38d888c4fdb229a5438e60faa2ae76c9b8830b67`. Le premier reçu KARTA **complet et valide** d’une requête annulée fixe la preuve de l’effet. Un callback tardif ne peut plus faire passer `executed` à `none`, remplacer la preuve ou rafraîchir artificiellement `updatedAt`. Les preuves normales et annulées possèdent leur propre copie pour résister à la réutilisation de l’objet résultat par le port.

Le type de requête et l’action mémoire attendue sont capturés lors de l’admission. Pour terminer un contrôle mémoire, une preuve doit être accompagnée du reçu durable de l’action demandée. Une preuve seule ou le reçu d’une autre action ne peuvent pas figer une annulation ni vérifier une opération normale.

La progression `uncertain` → `none` → `executed` reste possible jusqu’à la première preuve valide. Les aperçus sans preuve restent provisoires. Le statut `cancelled`, les états terminaux `verified`/`blocked`, la rétention, l’idempotence et la non-redélivrance du contenu exporté sont préservés.

## Qualification finale locale

- **PASS après correction : 21/21 nouveaux cas**, contre 10 réussites et 11 échecs sur la base `38d888c` avec le même fichier de tests.
- **PASS : 301/301 cas liés dans 10 fichiers**, incluant les 21 nouveaux ; zéro échec ou test en attente.
- **PASS : 7/7 contre-tests indépendants**, sur le même SHA de source ; ils recoupent des cas de la suite et ne s’ajoutent pas à une prétendue couverture unique.
- **PASS : typage et compilation KARTA**, via `npm run typecheck` et `npm run build`.
- **PARTIEL pour le graphe statique :** index ciblé frais, impact `LOW` pour `acceptedReceipt` (appelants `#apply`/`#late`) et `UNKNOWN` sur les méthodes. Les appels privés ont été relus directement.
- **Risque statique HIGH sur le delta final :** `detect_changes --scope staged` rapporte 8 symboles et 8 flux. Le risque a été communiqué ; le fichier produit concerné a été revu et les tests liés sont réussis.
- **PARTIEL pour la comparaison avec main :** contrôle exécuté, mais aucune référence main ni objet `ae84415…` disponible localement. La base de consolidation n’a pas été utilisée pour inventer une référence main.

La revue indépendante a bloqué un premier candidat avant publication : reçus mémoire incomplets ou d’une autre action, puis alias de preuve sur une réponse normale. Ces contre-exemples sont corrigés dans le candidat final ; les résultats intermédiaires restent identifiés dans les preuves.

Les dépendances sont réutilisées depuis un donneur local. Manifestes et verrous sont identiques ; les versions chargées sont consignées dans `qualification.json`. Aucune nouvelle installation `npm ci` n’est revendiquée.

Les commandes, résultats et empreintes des journaux bruts figurent dans `qualification.json`. Les journaux sont conservés dans les preuves d’audit, sans les recopier dans le dépôt. Aucun fournisseur réel, déploiement, appareil physique ou parcours de production n’est validé par ce lot. Il ne s’agit pas d’une nouvelle campagne complète de tous les tests KARTA.
