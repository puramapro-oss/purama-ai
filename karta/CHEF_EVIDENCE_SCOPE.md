# CHEF — preuves ciblées et réussite explicite

Ce correctif empêche un contrôle général (par exemple une compilation) de couvrir
automatiquement toutes les exigences d'une tâche. Il ne constitue pas une
certification de disponibilité 24 h/24 ni une validation de production.

## Contrat

Les profils de `CHEF_VERIFICATION_PROFILES_JSON` peuvent déclarer
`requirementKeys`. Cette configuration appartient à l'opérateur de confiance,
comme la commande de vérification. La sortie du modèle ou de la commande ne peut
pas étendre cette portée.

```json
[
  {"name":"build","kind":"build","command":"npm","args":["run","build"]},
  {"name":"checkout-acceptance","kind":"test","command":"npm","args":["test","--","test/checkoutAcceptance.test.ts"],"requirementKeys":["R-CHECKOUT"]}
]
```

Cet exemple est illustratif : le fichier `checkoutAcceptance.test.ts` n'est pas
fourni. Chaque profil ciblé doit exécuter un contrôle existant dont les assertions
couvrent réellement l'exigence indiquée. Les clés sont propres au brief de la
mission ; une configuration ne doit pas être réutilisée aveuglément entre missions.

| Entrée | Résultat |
|---|---|
| Portée omise ou vide | Preuve de tâche uniquement |
| Clés explicites valides et `ok: true` | Preuve de tâche + une preuve par exigence visée |
| Clé non liée à la tâche | Rejet avant toute insertion |
| Clés répétées | Normalisées et dédoublonnées |
| Échec d'un contrôle | Preuve conservée au niveau tâche, aucune exigence validée |
| Reçu Git émis par le superviseur | Preuve de tâche uniquement |
| Ancienne preuve sans portée versionnée | Historique conservé, aucune couverture d'exigence |

L'adaptateur écrit les champs réservés `payload.scopeVersion: 1` et
`payload.requirementKeys`. La migration 016 exige le booléen JSON `true`, la
version numérique `1` et la présence de la clé d'exigence dans le tableau. Les
valeurs absentes, `null`, `false` et la chaîne `"true"` ne prouvent pas une réussite.
Une exigence critique exige toujours une preuve et une revue réussies provenant
de tâches distinctes.

## Mise en service contrôlée

1. Identifier la version réellement déployée et vérifier l'application préalable
   des migrations 008 à 015. Inventorier les missions ouvertes et leurs profils.
2. Suspendre les nouvelles prises de tâches, laisser terminer ou arrêter proprement
   les travailleurs, et disposer d'une sauvegarde restaurable.
3. Appliquer `016_chef_scoped_evidence.sql`, puis déployer le worker corrigé et sa
   configuration de profils ciblés avant de reprendre les missions.
4. Refaire les contrôles nécessaires dans des tâches de revalidation traçables.
   Ne jamais ajouter artificiellement une portée aux anciennes preuves.
5. Exécuter une mission pilote sur les services réels : un contrôle de R1 doit
   laisser R2 manquante ; une erreur ne doit pas terminer la mission ; une
   exigence critique doit attendre sa revue distincte.

Les profils anciens sans `requirementKeys` restent exécutables mais ne couvrent
plus les exigences. Les missions déjà terminées ne sont pas automatiquement
rouvertes ou recertifiées par cette migration. Les missions bloquées après ce
renforcement nécessitent une vraie revalidation ; ne pas les forcer à réussir.

En cas de problème de déploiement, suspendre les workers et diagnostiquer la
configuration. Revenir à l'ancien gate SQL réintroduirait les défauts corrigés.

## Vérifications et portée des résultats

Les deux nouveaux fichiers de tests couvrent l'adaptateur et les fonctions SQL
avec toute la chaîne des migrations 008 à 016. Ils vérifient aussi la distinction
entre réussite d'une tâche et complétude de la mission, ainsi que le maintien de
la revue indépendante. Les tests historiques des migrations anciennes restent
inchangés : ils ne constituent pas les tests du contrat courant.

Avant le correctif, 25 des 29 nouveaux cas ont échoué sur le comportement ancien.
Validation locale du 8 novembre 2026 sur cette branche :

| Contrôle | Résultat |
|---|---|
| `npm test` dans `karta` | PASS — 441 tests, 43 fichiers, dont 29 nouveaux cas |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm audit --audit-level=high --omit=dev` | PASS au seuil demandé ; 1 vulnérabilité modérée `qs` préexistante reste signalée |
| Services réels et fonctionnement 24 h/24 | NON TESTÉ |

Les tests SQL utilisent PGlite ; l'adaptateur utilise un double
Supabase. Un résultat local vert ne prouve donc pas une exécution de bout en bout
sur Supabase et Hostinger.

## Limites et suites nécessaires au fonctionnement continu

- La portée explicite ne prouve pas que le contrôle choisi est pertinent ; sa
  configuration et ses assertions doivent être revues.
- Les preuves ne sont pas encore liées à une tentative, à un fencing token et
  au SHA effectivement vérifié. La fraîcheur après nouvelle tentative ou
  modification du code nécessite un autre correctif.
- Une revue portée par une tâche distincte ne garantit pas à elle seule un
  réviseur indépendant ni une identité différente.
- Les comptes `service_role` restent une frontière de confiance. Ce changement
  ne protège pas contre un service autorisé compromis qui falsifierait les données.
  La vérification d'appartenance porte sur les liens existants de la tâche ; elle
  ne remplace pas une contrainte SQL interdisant les liens entre missions. Le flux
  normal d'ingestion est distinct des écritures directes privilégiées.
- Les redémarrages du serveur, reprises après panne, restaurations de sauvegarde,
  alertes externes, plafonds financiers atomiques et annulations en cascade doivent
  être qualifiés sur les services réels avant de revendiquer un fonctionnement
  autonome continu. Ils ne sont pas déclarés résolus par ce correctif.

Responsable de l'intégration : mainteneur du dépôt. Responsable du déploiement et
du pilote : opérateur disposant des accès Supabase/Hostinger. Aucun de ces travaux
de production n'est effectué par l'ouverture de la pull request.
