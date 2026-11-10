# Revue indépendante — frontières asynchrones CHEF

Date : 10 novembre 2026. Réviseur : agent `chef_boundary_audit`.

## Conclusion

**PASS — aucun défaut bloquant identifié dans le correctif local des cinq gardes.** Le diff traite précisément les cinq reprises asynchrones après perte de bail reproduites sur la base `1a49ad646b529c6fb95335105c8a4e5f28468d76`. Les preuves fournies montrent cinq échecs avant correction et cinq réussites après correction, sans test ignoré, interruption ni expiration du lanceur.

**PARTIEL — cette conclusion porte sur le diff, les cinq cas et la préservation statique des protections voisines.** Le réviseur n'a exécuté aucun test et n'a modifié aucun fichier de production. Les suites élargies de comptabilité, d'arrêt, de quarantaine, de processus et d'intégration restent à qualifier séparément par l'agent principal. Cette revue ne vaut pas certification de tous les chemins CHEF ni validation d'un déploiement.

## Périmètre et identité des sources

Le seul fichier de production modifié par rapport à la base, au moment de la revue, est `karta/src/chef/supervisor.ts` : six lignes ajoutées et une supprimée. Le changement comporte cinq gardes sur `lostLease`, sans nouvelle dépendance, signature, durée ou migration.

Le nouveau `karta/test/chefGitCancellation.test.ts` est identique octet pour octet à celui du commit historique `7cef7e57268ba2326d256d10277434a751ae1275` : blob Git `b7597af775f9eb56c0e3fe9a54ed6b94848cb5f9`, SHA-256 `902d04feca4356084a3b87952ae871f3ab80ae15ddd226329ed0865e512bbe28`. Aucune assertion de ce test n'a été assouplie.

État revu du superviseur : blob Git `b9c9060426b5c2c2eef7343bfe7e5f3479044177`, SHA-256 `a3e66a1909f10fbefdf6cf6cbb8716e388a5f46874cdf925e46cd2697acdc1bd`.

Les fichiers suivants sont strictement identiques à la base : `driver.ts`, `verifier.ts`, `process.ts`, `control-plane.ts`, `worker-main.ts` et `git-state.ts`, tous sous `karta/src/chef/`. Les fichiers récents n'ont donc pas été remplacés par leurs anciennes versions PR18.

## Examen du correctif

Le scénario commun est un renouvellement de bail accepté, suivi d'un échec du heartbeat de renouvellement pendant qu'une opération du superviseur attend sa réponse. La perte de bail locale annule le cycle ; le serveur peut néanmoins encore accepter l'ancienne génération. Une réponse tardive ne doit pas autoriser la poursuite du superviseur.

| Frontière | Défaut observé dans la preuve rouge | Effet du correctif |
| --- | --- | --- |
| Premier contrôle Git rejeté après annulation | Retour `retryable` et nouvelle transition `retryable` | Retour immédiat `lost_lease` au début du `catch` |
| Premier contrôle Git réussi après annulation | Transition et heartbeat `verifying`, puis appel du verifier | Garde avant la transition `verifying` |
| Contrôle Git final rejeté après annulation | Retour et transition `retryable` | Retour immédiat `lost_lease` au début du `catch` final |
| Transition `verifying` acquittée après annulation | Heartbeat `verifying` et appel du verifier | Contrôle de `lostLease` en plus de l'acquittement distant |
| Heartbeat `verifying` acquitté après annulation | Appel du verifier | Garde après le heartbeat |

Toutes les nouvelles sorties restent dans le `try` extérieur : son `finally` arrête le renouvellement et retire le listener d'arrêt du worker. Aucun nettoyage n'est contourné.

Les tests suspendent explicitement la frontière concernée, constatent un renouvellement et l'annulation du signal avant de libérer la réponse. Le verifier simulé ignore volontairement le signal : il permet de vérifier l'interdiction d'engager l'appel dans le superviseur, indépendamment de la protection interne du verifier concret. Les assertions contrôlent également une seule comptabilisation, l'absence de preuve ajoutée et l'absence de finalisation.

## Comptabilité, arrêt et quarantaine

**PASS par inspection et comparaison exacte des sources :**

- Le préfixe du superviseur, jusqu'au premier contrôle Git, est inchangé. Il comprend l'identification de tentative, `recordUsage`, les règles de règlement avant exécution, l'arrêt du worker et `blockUnconfirmedStop`.
- La comptabilisation de la réponse du driver reste antérieure à l'examen de `lostLease`. Les nouvelles gardes, placées plus loin, ne suppriment donc pas la prise en compte d'un reçu tardif pour sa tentative d'origine.
- Aucun zéro n'est introduit pour une consommation inconnue. Le maintien des réservations et le blocage sur usage incomplet restent inchangés.
- La persistance de la quarantaine avant libération des verrous d'une tâche et le traitement de `ChefProcessStopUnconfirmedError` restent inchangés. Le diff ne transforme aucun arrêt non confirmé en reprise ordinaire.
- Un arrêt demandé par le worker conserve son chemin distinct via `options.signal` et `releaseForShutdown`. Les nouvelles gardes examinent uniquement une perte de bail déjà connue et n'altèrent pas les branches d'arrêt existantes.
- Le suffixe du superviseur, de la boucle `addEvidence` jusqu'à la finalisation et au `finally`, est inchangé. La protection existante contre l'acquittement tardif de la dernière preuve est conservée.

Le test existant de reçu tardif dans `chefBudgetAccounting.test.ts` et les cas d'arrêt/quarantaine ont été lus comme repères de non-régression ; ils n'ont pas été exécutés par ce réviseur. Aucune nouvelle garantie de processus ou de base de données n'est déduite des seuls cinq tests simulés.

## Preuves d'exécution examinées

Les deux reçus décrivent le même test et la même commande Vitest, avec un worker, dans le dossier `karta`. Seul le nom du fichier JSON de sortie diffère. La limite du lanceur est de 60 secondes pour les deux exécutions ; aucune augmentation de délai de test n'a été introduite.

| Preuve | Début UTC | Résultat lu | Code de sortie | Interruption ou expiration |
| --- | --- | --- | --- | --- |
| `baseline-five.json` et `baseline-five.receipt.json` | 21:30:23 | 0 réussite, 5 échecs, 0 ignoré | 1 | Non |
| `fixed-five.json` et `fixed-five.receipt.json` | 21:30:43 | 5 réussites, 0 échec, 0 ignoré | 0 | Non |

Les erreurs rouges sont des violations des assertions attendues — états, transitions, heartbeats et nombre d'appels du verifier — et non des erreurs de chargement ou de préparation. `reproduction-input.json` consigne l'identité de la base, du test historique importé et l'absence de modification de production lors de la reproduction initiale. Le réviseur a confirmé indépendamment l'identité actuelle du test et le diff de production ; il n'a pas réexécuté la séquence historique.

Empreintes SHA-256 des rapports lus :

- `baseline-five.json` : `89059168e94c9ea04186e404920b89f707d62f5632ce92b10e29ae456eb733e4`.
- `fixed-five.json` : `7f54c412d0f44ff0ceff2f6b94ced0d8cca762f924ab078ca02d2546ca3a2899`.

## Analyse du flux et limites restantes

Les lectures GitNexus `query` et `context` ont utilisé l'index existant `iao-resume-cb46`, daté de 21:22:52 UTC et attaché au commit `90d8f30322e864ccfd186e97cbfe7edf3afec9a9`. Avant le correctif, les cinq sources superviseur, driver, verifier, control-plane et worker-main ont été comparées à `1a49ad6` et confirmées identiques. La nouvelle indexation a échoué ; cette revue ne prétend pas disposer d'un index reconstruit sur le patch.

Le graphe identifie `main` dans `worker-main.ts` comme appelant de production, ainsi que les tests du superviseur et de comptabilité. La lecture directe confirme que `lost_lease` déclenche une attente bornée avant le cycle suivant. Les dépendances par interfaces ne sont pas toutes représentées dans GitNexus ; l'inspection des sources a complété ce point.

**Aucun autre défaut bloquant confirmé dans les cinq frontières corrigées.** Les réponses rejetées des RPC, les combinaisons d'arrêt explicite avec perte de bail, les processus réels, les bases réelles et la CI ne sont pas couverts par ces cinq preuves. Aucun résultat global n'est affirmé pour ces domaines.

Le seul fichier écrit par ce réviseur est le présent rapport. Aucune édition de production, aucun nouveau test exécuté, aucune mutation distante ni relance de CI.

## Complément — règle Vercel de la branche de qualification

**PASS — delta de configuration limité et conforme à l'effet recherché.** Le complément examiné ajoute uniquement `git.deploymentEnabled["codex/chef-cancellation-20261110"] = false` dans `vercel.json`. Cette branche n'avait pas de règle dans la base `1a49ad6`.

La lecture du JSON confirme une syntaxe valide, aucune clé dupliquée et la valeur booléenne `false`. Après retrait en mémoire de la seule nouvelle propriété, l'objet est strictement égal à celui de la base : réécritures, schéma et autres règles sont inchangés. Toutes les règles de déploiement présentes ont la valeur `false` ; aucune règle positive concurrente n'apparaît dans ce fichier. SHA-256 du fichier revu : `89fd16607e5080d8f65a56595a02cf18b361d73e2024aaf6a1a1f331029d465c`.

La [documentation officielle Vercel, section `git.deploymentEnabled`](https://vercel.com/docs/project-configuration/git-configuration), consultée pour ce complément, indique qu'une branche non précisée est activée par défaut et qu'une entrée `false` empêche ses commits de déclencher un déploiement automatique. Le delta protège donc précisément la branche de publication du correctif. Le diff de `.github/workflows` par rapport à la base est vide ; aucun workflow CI n'est modifié.

La qualification initiale du correctif runtime demeure inchangée : l'empreinte du superviseur correspond toujours à celle revue plus haut. **NON TESTÉ dans ce complément :** application effective de cette règle côté Vercel après publication et résultats d'un futur workflow CI. Une configuration examinée ne constitue pas une preuve d'exécution distante. Aucun test ni déploiement n'a été lancé par le réviseur ; seule cette section a été ajoutée au rapport autorisé.
