# CHEF — intégration des annulations, budgets et vérification complète

Contrôle du 10 novembre 2026. Ce dossier décrit une proposition de code ; il ne certifie pas une mise en production de PURAMA.

## Résultat

**PASS local — 801/801 tests, 63/63 fichiers, 17 lots successifs, sans échec, omission ni doublon.** Les 44 tests ciblés, le typage et les compilations KARTA/site, les cinq tests de dépendances et le contrôle des contrats générés passent. Les résultats intermédiaires et les échecs sont conservés ci-dessous. La CI distante et les services réels restent des validations distinctes.

## Composition et absence d'écrasement

| Apport réutilisé | Référence figée |
| --- | --- |
| Annulations déjà livrées, PR18 | `8063016b84b3513af1e52efea79d58dbbaff5682` |
| Budgets, contexte et délégation, PR21 | `b826af125ce296d3808d3b71b93fd084e63dbdb7` |
| Compatibilité des dépendances et workflow, PR24 | `9b066c5b10f6896041aec9359ee21b173c0f5014` |

Le travail part de PR21 et réconcilie les apports de PR18, y compris les documents et preuves hérités de `b040af6`. Les quatre fichiers de PR24 sont repris exactement : `package.json`, `package-lock.json`, `.github/workflows/purama-chef-hardening.yml` et `tests/dependency-compat.cjs`. Les sources frontend, migrations, contrats de contrôle et tests de budgets de PR21 sont préservés.

Le superviseur conserve notamment le règlement d'un reçu tardif pour sa tentative d'origine, les métriques absentes à `null`, le retour booléen de `recordUsage` et les réservations qui doivent rester ouvertes. Une consommation inconnue ne devient pas un zéro. Le mock du test d'écriture tardive retourne désormais `true`, conformément au contrat courant.

La proposition conserve l'historique précédent et réutilise la PR18. Elle ne fusionne pas automatiquement les branches partagées, ne déploie aucun service et n'applique aucune migration distante.

## Défauts reproduits et corrections

Sur les sources intactes de PR21, les treize scénarios d'annulation donnent **10 échecs et 3 réussites de contrôle**. Cinq protections de PR18 sont absentes de cette branche ; cinq autres courses sont nouvellement reproduites. Le reçu détaillé est [baseline-cancellation.vitest.json](baseline-cancellation.vitest.json).

- Le driver refuse un lancement déjà annulé et ne retourne pas une réussite arrivée après l'annulation, y compris à la reprise de son attente asynchrone.
- Le vérificateur contrôle l'annulation avant chaque profil et après son résultat, y compris le dernier ; les listeners disposent de leur nettoyage avant leur installation.
- Le superviseur vérifie la perte du bail après le premier contrôle Git, dans les deux chemins d'erreur Git, après la transition vers `verifying` et après son heartbeat. Une réponse tardive ne lance plus l'étape suivante.
- Le contrôle après la dernière écriture de preuve interdit qu'un accusé tardif permette la validation finale.

Les cinq nouveaux tests Git synchronisent précisément les réponses avec des promesses différées et un vrai signal d'annulation du superviseur. Le renouvellement distant peut avoir réussi avant l'erreur locale de heartbeat : les tests ne comptent donc pas sur un rejet distant pour cacher le défaut. Les tests de processus utilisent de véritables processus Node locaux ; les appels du contrôle, les fournisseurs et les scénarios de course Git sont simulés. Les autres tests Git ciblés manipulent aussi de vrais dépôts locaux.

## Préparation des bases de test

La première campagne complète a reproduit deux délais dépassés dans `chatHistoryIsolation` : **7 526 ms et 5 927 ms** pour un budget de test de 5 s. Le même fichier isolé avait réussi ses 39 cas en 28,14 s au total. Le coût du démarrage PostgreSQL/WASM dépend donc du contexte de la campagne ; une réussite isolée ne suffisait pas.

Les neuf préparations/fermetures concernées sont déplacées dans des hooks de 30 s. Les **39 cas, 12 instances, requêtes SQL, comparaisons de droits et rollback sont conservés**, ainsi que les 22 sites d'assertion. Un autre test de `chefEvidenceFreshness` reproduit le même problème à 6 840 ms : son instance historique et les migrations de référence 008–016 passent dans des hooks. Les insertions historiques, la vérification préalable, la migration 017 et les assertions restent dans le test. Ses 36 sites d'assertion et ses deux bases distinctes sont conservés.

Les assertions gardent le délai normal de **5 s**. `vitest.config.ts` reste identique. Aucun `skip`, retry ou rattrapage silencieux n'est ajouté. Les deux tests de migration des budgets avaient déjà un délai propre de 30 s et restent inchangés.

Ce choix suit la séparation documentée entre [testTimeout](https://vitest.dev/config/testtimeout) et [hookTimeout](https://vitest.dev/config/hooktimeout). La [fermeture PGlite](https://pglite.dev/docs/api#close) reste attendue et ses erreurs demeurent visibles.

## Tableau des vérifications

Environnement de cette campagne : Linux x64, **Node 22.23.4**, Vitest **5.0.3**, dépendances installées depuis les lockfiles avec `--offline --ignore-scripts --no-audit --no-fund`.

| Contrôle | Résultat et reçu |
| --- | --- |
| Reproduction sur PR21 intacte | 10 échecs / 13 ; [journal](baseline-cancellation.log) |
| Annulations, superviseur, Git et accounting après correction | **PASS 44/44**, huit fichiers ; [reçu](targeted-cancellation.vitest.json) |
| Historique isolé avant modification de ses hooks | **PASS 39/39** ; [reçu](baseline-history.vitest.json) |
| Première suite complète intégrée | **799/801**, deux timeouts, 62/63 fichiers réussis ; [reçu](full-suite-default.vitest.json) |
| Deuxième suite complète | **INTERROMPUE**, aucun total complet attribué ; [motif](final-suite-interrupted.json), [journal](final-suite-default.log) |
| Suite complète par processus successifs | **PASS 801/801, 63/63 fichiers, 17/17 lots**, 272,98 s au total ; [résumé et couverture](bounded/summary.json) |
| Typage KARTA après les deux changements de hooks | **PASS** ; [reçu](final-typecheck.result.json) |
| Compilation KARTA | **PASS** ; [reçu](karta-build.result.json) |
| Typage du site | **PASS** ; [reçu](site-typecheck.result.json) |
| Compilation du site | **PASS** ; [reçu](site-build.result.json) |
| Compatibilité des dépendances du site | **PASS 5/5** ; [journal](site-dependencies.log) |
| Contrats Supabase générés | **PASS** ; [journal](generated-contracts.log) |
| CI distante exécutée sur runner | **BLOQUÉ** au relevé de référence ; voir la revue indépendante |
| Fournisseurs, Redis, Supabase/PostgREST, paiements et production réels | **NON TESTÉ** dans ce lot |

Ces campagnes se recouvrent : leurs décomptes ne doivent pas être additionnés.

## Ressources et couverture exhaustive des fichiers

Pendant la deuxième campagne, le cgroup partagé atteint **8 589 877 248 octets sur 8 589 934 592** ; son compteur cumulatif `oom_kill` passe de 41 à 44. Des échéances de 30 s sont traitées après plus de 72 s. Le [relevé](final-suite-pressure.json) concerne l'ensemble du cgroup : il n'identifie pas les processus tués et n'attribue pas tous ces événements à ce test. La session de cette campagne est interrompue, sortie 130, sans arrêt d'une autre tâche. Son processus principal n'est plus présent après l'interruption.

La validation suivante utilise [run-bounded-validation.py](run-bounded-validation.py) : les **47 fichiers sans import direct PGlite** passent dans un lot, puis les **16 fichiers PGlite** dans seize processus successifs. Chaque processus est attendu jusqu'à sa sortie. Les délais de test et de hook restent ceux du dépôt, avec un worker et sans parallélisme des fichiers. Un délai maximal externe borne chaque lot ; son dépassement est un échec.

Le programme vérifie la partition des **63 fichiers**, l'égalité entre fichiers attendus et réellement rapportés par Vitest, l'absence de doublon, d'échec, de test en attente et de changement des fichiers pendant la campagne. Le nombre attendu est **801 tests**. Aucun PASS global ne peut être produit avec une couverture incomplète. Les journaux, commandes, résultats JSON et relevés de ressources de chaque lot restent dans `bounded/`. Les 17 lots passent : **592 cas dans les 47 fichiers sans PGlite et 209 cas dans les 16 fichiers SQL**. Le compteur partagé `oom_kill` reste à **44 avant et après** cette campagne. Une seconde lecture indépendante des 17 JSON confirme la couverture et les 801 assertions réussies. Une campagne déjà enregistrée n'est pas écrasée silencieusement.

L'échec initial de lancement de l'outil optionnel `/usr/bin/time` a eu lieu avant tout test ; il est distingué dans [full-suite-launch-error.json](full-suite-launch-error.json). Il n'entre dans aucun décompte.

## Analyse d'impact et revue

L'index GitNexus a été reconstruit sur PR21 : **667 fichiers, 9 010 nœuds, 21 908 relations**. Les quatre analyses des fonctions de production donnent un risque local `LOW`. Le driver et le vérificateur sont appelés par `runChefWorkerCycle`, lui-même appelé par le lanceur des workers ; les interfaces et les limites de parcours empêchent d'en déduire une couverture absolue.

Les callbacks des tests SQL ne sont pas résolus par le graphe (`UNKNOWN`), ce qui est consigné. Leur périmètre a été contrôlé directement dans les fichiers avant modification. Le premier contrôle agrégé des changements indique **13 fichiers, 18 symboles, trois processus, risque medium**. Le contrôle final enregistré donne **171 fichiers, 18 symboles, trois processus, risque medium** ; les fichiers supplémentaires sont principalement des preuves. La [comparaison à `main`](detect-main.log) donne **427 fichiers, 2 020 symboles et 376 processus, risque critical**, avec une liste de symboles plafonnée : elle inclut les apports hérités de nombreuses branches. Cet écart global ne constitue pas une autorisation de fusion en production. Les derniers ajouts sont les reçus de ces contrôles et la conclusion de revue, sans nouvelle modification de production.

La [revue indépendante](independent-review.md) vérifie séparément les gardes, la préservation des budgets et le reçu ciblé. Elle ne prétend pas avoir réexécuté les tests. Les empreintes distinguent les étapes : [fusion initiale](integration-sources.json), [annulations intégrées](source-manifest.json), [étape historique intermédiaire](final-source-manifest.json), puis [sources de la validation bornée](verified-source-manifest.json). Les preuves du dossier précédent restent historiques ; elles ne remplacent pas les nouveaux résultats.

## Limites et intégrations restantes

Les relevés CI de PR18, PR21 et PR24 montrent des jobs terminés en échec avec **runner_id=0, nom vide et aucune étape exécutée**. Les annotations explicatives sont annoncées mais leur endpoint est inaccessible via le connecteur ; les logs demandés sont absents. La cause exacte n'est pas prouvée : ni facturation ni défaut de code n'est affirmé. Les identifiants des runs sont dans la revue indépendante. Le contrôle à effectuer sur la nouvelle tête de PR18 est distinct de ces relevés historiques.

AETHER `27815bcc9660adcc925f1a6c2b8651ff04ff5062` n'est pas absorbé dans ce lot : son chemin de reprise chevauche celui de PR21, et sa migration `019_karta_approval_parent_guard.sql` porte le même numéro que `019_pending_action_execution_trigger.sql`. L'ordre et le suivi de ces migrations, ainsi que le passage aux workers v2, doivent être réconciliés dans leur intégration dédiée. Ce constat ne prouve pas une incompatibilité intrinsèque de leurs objets SQL.

Les tests d'annulation couvrent le processus enfant direct et l'absence d'étape suivante après une annulation connue. Ils ne garantissent pas l'arrêt de tous les descendants, n'annulent pas une opération distante déjà engagée et ne mesurent pas la latence d'un utilisateur en production. Une suite locale verte ne prouve ni disponibilité continue, ni coûts réels, ni fonctionnement des services externes.
