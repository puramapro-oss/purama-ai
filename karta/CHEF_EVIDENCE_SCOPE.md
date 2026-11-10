# CHEF — preuves ciblées, réussite explicite et reprise sûre

Ce correctif empêche un contrôle général (par exemple une compilation) de couvrir
automatiquement toutes les exigences d'une tâche. Il ne constitue pas une
certification de disponibilité 24 h/24 ni une validation de production.
Les preuves sont aussi liées à la tentative et au jeton de possession de la tâche
qui les a produites ; elles ne sont jamais réattribuées automatiquement à une reprise.

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
| Preuve d'une autre tentative ou d'un ancien jeton | Historique conservé, exclu de la validation actuelle |
| Écriture par un agent dont le droit a expiré | Refus atomique, arrêt du cycle avec `lost_lease` |

L'adaptateur écrit les champs réservés `payload.scopeVersion: 1` et
`payload.requirementKeys`. La migration 016 exige le booléen JSON `true`, la
version numérique `1` et la présence de la clé d'exigence dans le tableau. Les
valeurs absentes, `null`, `false` et la chaîne `"true"` ne prouvent pas une réussite.
Une exigence critique exige toujours une preuve et une revue réussies provenant
de tâches distinctes.

La migration 017 ajoute `attempt`, `fencing_token` et `worker_id`. Ces champs
proviennent du claim capturé au début du cycle, jamais du payload du modèle ou
d'une nouvelle lecture destinée à réestampiller une vieille preuve. Le trigger
verrouille la tâche avant de contrôler propriétaire, tentative, jeton, état et
expiration. Un refus renvoie `PCE01` ; l'adaptateur retourne alors `false` et le
superviseur arrête les écritures suivantes sans déclarer la tâche terminée.

Le jeton est indispensable : le compteur de tentatives peut être réutilisé après
déblocage d'une tâche. Les gates comparent donc les deux valeurs. L'insertion,
le renouvellement et la transition vérifient l'heure réelle après le verrouillage,
et refusent les identifiants manquants. Une transaction commencée plus tôt ne doit
pas permettre de prolonger un bail déjà expiré.

Pour les tâches `write`, Git est contrôlé avant et après les profils. Le reçu Git
et les preuves ne sont persistés qu'après le contrôle final. Si HEAD ou l'état du
worktree ne correspondent plus aux conditions attendues, le cycle passe en
`retryable` avec l'erreur, sans enregistrer ces preuves comme résultats utilisables.
Cela inclut les résultats de profils échoués : ils ne sont pas conservés si le
contrôle Git final échoue. Une panne d'insertion distincte de `PCE01` remonte à la
boucle du worker, qui applique son traitement des incidents ; elle n'est pas
transformée en réussite ni masquée comme une simple perte de bail.

## Mise en service contrôlée

1. Identifier la version réellement déployée et vérifier l'application préalable
   des migrations 008 à 015. Inventorier les missions ouvertes et leurs profils.
   Vérifier aussi les autres branches CHEF avant toute fusion : l'inspection T1
   du 8 novembre a trouvé des migrations différentes portant déjà les numéros
   016/017. La présente séquence ne doit pas être appliquée telle quelle sur cette
   autre lignée. Voir les incompatibilités dans `../DEPENDENCY_QUALITY.md`.
2. Suspendre les nouvelles prises de tâches, laisser terminer ou arrêter proprement
   les travailleurs, et disposer d'une sauvegarde restaurable.
3. Appliquer dans l'ordre `016_chef_scoped_evidence.sql` puis
   `017_chef_evidence_generation.sql`, puis déployer le worker corrigé et sa
   configuration de profils ciblés avant de reprendre les missions. Un ancien
   worker sans métadonnées de claim est volontairement refusé après la migration.
4. Refaire les contrôles nécessaires dans des tâches de revalidation traçables.
   Ne jamais ajouter artificiellement une portée aux anciennes preuves.
5. Exécuter une mission pilote sur les services réels : un contrôle de R1 doit
   laisser R2 manquante ; une erreur ne doit pas terminer la mission ; une
   exigence critique doit attendre sa revue distincte. Faire expirer un bail,
   reprendre la tâche, puis confirmer que l'ancien agent et ses preuves sont refusés.

Les profils anciens sans `requirementKeys` restent exécutables mais ne couvrent
plus les exigences. Les missions déjà terminées ne sont pas automatiquement
rouvertes ou recertifiées par cette migration. Les missions bloquées après ce
renforcement nécessitent une vraie revalidation ; ne pas les forcer à réussir.
Les anciennes lignes de preuve gardent des champs de génération NULL. Ne pas les
remplir avec les compteurs courants : cela certifierait artificiellement l'historique.

En cas de problème de déploiement, suspendre les workers et diagnostiquer la
configuration. Revenir à l'ancien gate SQL réintroduirait les défauts corrigés.

## Vérifications et portée des résultats

Les tests couvrent l'adaptateur, le superviseur et les fonctions SQL avec toute
la chaîne des migrations 008 à 017. Ils vérifient la distinction entre réussite
d'une tâche et complétude de la mission, le maintien de la revue indépendante,
les reprises, les preuves anciennes, l'expiration réelle, les valeurs NULL et le
rollback d'un lot dont une ligne porte un claim périmé. Un scénario applique 017
sur une base 016 contenant de vraies preuves historiques. Des dépôts Git temporaires
réels exercent aussi les modifications de fichiers et de HEAD pendant les profils.
Les tests des migrations antérieures restent versionnés et ne constituent pas à
eux seuls les tests du contrat courant.

Avant le correctif, 25 des 29 nouveaux cas ont échoué sur le comportement ancien.
Le complément sur les reprises a reproduit huit autres cas avant leur correction,
dont le renouvellement tardif et la transition avec un jeton NULL.
Validation locale réexécutée le 10 novembre 2026 sous Node 22.23.4 :

| Contrôle | Résultat |
|---|---|
| `npm test` dans `karta` | PASS — 488 tests, 45 fichiers ; 47 cas supplémentaires pour ce complément, 76 ajoutés au total dans la PR |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm audit --audit-level=low --omit=dev` dans `karta` | PASS — 0 vulnérabilité connue signalée après mise à jour de `qs` 6.16.0 vers 6.17.1 |
| Services réels et fonctionnement 24 h/24 | NON TESTÉ |

Ce résultat d'audit concerne uniquement les dépendances de production de KARTA.
L'application racine conserve des alertes et des erreurs TypeScript préexistantes ;
le bilan distinct figure dans `../DEPENDENCY_QUALITY.md`.

Les tests SQL utilisent PGlite ; l'adaptateur utilise un double
Supabase. Un résultat local vert ne prouve donc pas une exécution de bout en bout
sur Supabase et Hostinger.

## Limites et suites nécessaires au fonctionnement continu

- La portée explicite ne prouve pas que le contrôle choisi est pertinent ; sa
  configuration et ses assertions doivent être revues.
- Les preuves sont désormais liées à la tentative et au fencing token. Le contrôle
  Git avant/après constate deux états ; il ne prouve pas l'exécution d'un arbre
  immuable. Une mutation transitoire restaurée, les fichiers ignorés et les entrées
  externes ne sont pas couverts. Les tâches `read` n'ont pas ce contrôle Git. Le
  rattachement intégral d'un résultat à un environnement de vérification isolé
  reste à réaliser ; aucun champ `verifiedSha` trompeur n'est ajouté.
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
- PGlite exécute réellement les fonctions et les triggers, mais ne valide pas les
  contentions entre plusieurs connexions sur PostgreSQL de production. Le pilote
  Supabase doit inclure l'expiration pendant l'attente d'un verrou et une reprise
  par un autre worker.

Responsable de l'intégration : mainteneur du dépôt. Responsable du déploiement et
du pilote : opérateur disposant des accès Supabase/Hostinger. Aucun de ces travaux
de production n'est effectué par l'ouverture de la pull request.
