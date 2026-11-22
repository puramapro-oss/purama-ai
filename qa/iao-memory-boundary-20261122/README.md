# IAO — validation de la frontière de contexte local

Date : 22 novembre 2026. Base exacte : `d356eb3224f266fb9006dd7ad4ca45e2cdd9ffa0`.

## Problème et correction

Le fournisseur local filtrait les sources avec la vérité JavaScript de `authorized`. Une valeur malformée telle que la chaîne `"false"` pouvait donc faire entrer un texte dans le contexte transmis. Le typage TypeScript du port SMARANA n'effectuait aucune validation à l'exécution. Les accès directs aux propriétés et l'itérateur du tableau pouvaient également exécuter des accesseurs ou comportements personnalisés.

Le correctif normalise le paquet complet avant sélection et transport : objets de données avec propriétés propres, autorisation booléenne, sensibilité de l'énumération existante, texte chaîne et pertinence numérique finie. Les proxies sont refusés avant introspection ; les champs requis sont lus par leurs descripteurs, sans invoquer d'accesseur ; les tableaux personnalisés, trous et itérateurs propres sont refusés. Le fournisseur trie ensuite des copies de données et conserve la sélection `authorized === true` et `sensitivity === "normal"`.

Les valeurs de pertinence 1, 10 et 100 restent valides. Les objets gelés et les enregistrements passifs à prototype nul restent acceptés. Les métadonnées supplémentaires inutilisées ne sont pas copiées dans le prompt. Le message d'erreur reste générique et ne reprend aucun contenu fourni par les objets malformés.

Cette correction renforce une frontière existante. SMARANA reste responsable de l'autorisation authentique, du consentement et de la persistance. Elle ne transforme pas le booléen en preuve cryptographique d'autorisation et ne constitue pas une isolation contre du code arbitraire déjà exécuté dans le même processus. Elle ne prouve ni une résistance générale aux injections de prompt, ni le blocage réseau du démon local, ni la sécurité des rôles SQL déployés.

## Vérification locale

| Contrôle | Résultat observé |
|---|---|
| Régression avant correction | 38 échecs et 2 succès sur 40 cas ; voir `regression-before.log` |
| Régression après correction | 40 succès sur 40 cas ; voir `regression-after.log` |
| Parcours voisins avec le correctif | 90 succès et 24 échecs `listen EPERM`, sur 114 cas ; voir `neighbor-tests.log` |
| Même parcours sur la base exacte, sans le nouveau fichier de tests | 50 succès et les mêmes 24 échecs `listen EPERM`, sur 74 cas ; voir `baseline-neighbor-tests.log` |
| TypeScript | PASS, commande terminée avec code 0 ; voir `typecheck.log` |
| Construction KARTA | PASS, commande terminée avec code 0 ; voir `build.log` |

Les 24 échecs portent sur l'ouverture de sockets Unix interdite dans cet environnement. La liste et l'ordre des tests en échec sont identiques sur la base et sur le correctif. Ce constat explique la limite locale, sans transformer ces essais en succès. Leur validation reste à obtenir dans la CI de la branche du correctif.

Les tests de frontière utilisent uniquement des données synthétiques. Ils contrôlent notamment l'absence d'appel de transport pour un paquet contenant une source malformée après une première source qui remplit déjà le budget de contexte. Les compteurs d'accesseurs, de pièges de proxy et d'itérateurs restent à zéro dans les cas correspondants après correction.

## Commandes reproductibles

Depuis `karta` :

```sh
npm test -- --reporter=dot test/localComputeFabricMemoryBoundary.test.ts
npm test -- --reporter=dot test/localComputeFabricMemoryBoundary.test.ts test/localComputeFabricCancellation.test.ts test/localComputeFabricProvider.test.ts test/iao-facade.test.ts
npm run typecheck
npm run build
```

Pour comparer les parcours voisins, utiliser un checkout séparé de la base indiquée, les mêmes dépendances et omettre le nouveau fichier de tests. Aucun fournisseur externe ni aucune donnée de production ne sont nécessaires.

## Analyse des dépendances et revue

GitNexus a été réindexé sur la base exacte avant édition. L'analyse `impact(buildMemoryPrompt, upstream)` donne un risque calculé LOW, six éléments atteints sur trois profondeurs : le fournisseur, les appels de préparation KARTA/IAO et leurs tests. La lecture ciblée du code complète le graphe. La recherche FTS est indisponible dans cet index ; les flux recensés par l'analyse ne sont pas exhaustifs.

Le contrôle précommit des changements indexés classe le lot MEDIUM (10 fichiers, 22 symboles, tests compris). Quatre flux calculés rejoignent le nom générique du helper de test `trap` : ce graphe ne démontre pas leur exécution en production. La comparaison obligatoire avec `main` est CRITICAL et comprend tout l'historique de consolidation (1 921 fichiers), largement extérieur à ce correctif. Le lot est donc proposé séparément depuis la base exacte, sans promotion vers `main`.

L'audit initial indépendant a reproduit les défauts avant correction. La contre-revue indépendante du correctif a été interrompue par le contrôle automatique du sous-agent, avec le motif « possible cybersecurity risk » ; elle n'est donc pas comptée comme obtenue. La revue du diff par l'agent principal et les vérifications exécutées ci-dessus restent les preuves disponibles.

## Statut de livraison

- PASS : défaut reproduit, correction limitée, régression ciblée, typecheck et build.
- PARTIEL : validation locale des parcours voisins, limitée par les sockets Unix.
- NON TESTÉ ici : état réel de la mémoire déployée, hôte Mac, isolement réseau du démon, rôles SQL et connecteurs actifs.
- Aucun déploiement de production ni migration de base n'est inclus dans ce lot.

Les éventuels résultats CI et le statut de publication doivent être lus sur la pull request correspondant au commit du correctif ; ce document décrit les vérifications locales conservées dans ce dossier.
