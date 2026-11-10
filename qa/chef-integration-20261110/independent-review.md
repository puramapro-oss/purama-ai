# Revue indépendante — intégration CHEF du 10 novembre 2026

**PASS pour la revue statique du patch identifié ci-dessous et pour la lecture du reçu des 44 tests ciblés. PARTIEL pour la validation intégrée. Aucun résultat de suite complète, de CI exécutée sur runner ou de production n'est certifié par cette revue.**

La revue a comparé les objets Git et les fichiers locaux en lecture seule. Elle n'a exécuté aucun test, aucune commande réseau, aucune fusion ni aucune modification de production. Sa seule écriture est le présent compte rendu. Les faits CI proviennent du diagnostic GitHub en lecture seule effectué précédemment dans cette session, distinct de la revue locale.

## 1. Références et périmètre exacts

| Élément | Référence |
| --- | --- |
| Base conservée, PR21 | `b826af125ce296d3808d3b71b93fd084e63dbdb7` |
| Annulations de PR18 | `8063016b84b3513af1e52efea79d58dbbaff5682` |
| Parent de PR18 / PR10 | `b040af6dd7abe202a4dd7996f0ffad41c1b742bf` |
| Compatibilité de PR24 | `9b066c5b10f6896041aec9359ee21b173c0f5014` |
| Arbre de fusion automatique initial | `e9b8a4638643315472552c366282f42b74595c91` |
| Base commune AETHER / PR21 / PR24 | `1daf6314d60f6dd336c3a3601ddf73cf432ef4b3` |
| AETHER consulté, non intégré par ce lot | `27815bcc9660adcc925f1a6c2b8651ff04ff5062` |

`integration-sources.json` consigne la **provenance de la fusion avant l'ajout des nouveaux gardes Git**. Son blob de superviseur `822db483cc598005fc829d9eafc198c4046441d3` décrit cette étape intermédiaire ; ce n'est pas l'empreinte finale du fichier testé.

`source-manifest.json` fige les fichiers réellement testés **après** ces gardes. La revue a recalculé les SHA-256 et objets Git de ses treize entrées : aucune divergence observée. Le superviseur final est bien `863e65552007b751e733c24edf9e54c53740cfb5`.

| Fichier revu | Blob Git observé |
| --- | --- |
| `karta/src/chef/driver.ts` | `ab49cb83ffb3db779044cb98ef4907ba50bc72db` |
| `karta/src/chef/verifier.ts` | `7d568ed21a7fa421db433e633c8a2d26b78f0476` |
| `karta/src/chef/supervisor.ts` | `863e65552007b751e733c24edf9e54c53740cfb5` |
| `karta/test/chefCancellation.test.ts` | `00b583d6d706f16e648042a6fa028ac3441ba7cc` |
| `karta/test/chefSupervisorCancellation.test.ts` | `401a3a8ea0767851da5337acfc060e201e0af166` |
| `karta/test/chefGitCancellation.test.ts` | `b7597af775f9eb56c0e3fe9a54ed6b94848cb5f9` |

## 2. Préservation de PR21 et des budgets

**Aucune régression de comptabilité identifiée dans la différence revue.** Le superviseur est identique octet pour octet à PR21 depuis son début jusqu'à la déclaration de `gitEvidence`. En particulier :

- Le reçu d'usage reste enregistré avant le retour pour perte de bail. Un reçu tardif peut régler sa propre réservation ; il ne valide pas la tâche d'une autre tentative.
- `attempt` et `fencingToken` restent transmis au règlement. La clé de reçu conserve son empreinte des métriques.
- Les métriques fournisseur absentes restent `null`. Elles ne deviennent pas des zéros observés.
- `recordUsage` reste un contrat `Promise<boolean>`. Un retour faux ou une erreur bloque la vérification et conserve la réconciliation nécessaire.
- Les règlements à zéro restent limités aux chemins précédant tout appel au driver.
- Aucun nouveau garde d'annulation n'a été placé avant le règlement du reçu déjà retourné par le driver.

Les fichiers `karta/src/chef/control-plane.ts`, `karta/src/chef/brief.ts`, `karta/migrations/018_chef_budget_reservations.sql`, `karta/migrations/019_pending_action_execution_trigger.sql` ainsi que les sources et tests de contexte/délégation ajoutés par PR21 restent identiques à cette base. Tous les tests budget de PR21 sont conservés ; le test du reçu tardif de `chefBudgetAccounting.test.ts` fait partie du reçu ciblé examiné.

Une annulation du driver peut empêcher le retour d'un reçu : cela ne prouve pas une consommation nulle. Le patch ne libère pas les réservations inconnues sur cette hypothèse. Il ne crée pas non plus une nouvelle voie de réconciliation fournisseur.

## 3. Revue des gardes et des régressions

**Aucun défaut de code bloquant identifié dans ce patch.**

Le driver conserve l'unique garde de préannulation de PR21, avec son message existant. Les ajouts de PR18 vérifient ensuite l'annulation à la fermeture du processus et après l'attente de sa réponse. Le vérificateur contrôle l'entrée, chaque profil, la fermeture du processus et le retour de chaque attente, y compris après le dernier profil. Les gestionnaires et leur nettoyage sont définis avant l'installation du listener d'annulation et son rattrapage explicite : aucune utilisation avant initialisation n'a été identifiée. Les erreurs ne recopient pas un `signal.reason` arbitraire.

Dans le superviseur, les ajouts contrôlent la perte de bail après le premier contrôle Git, dans les deux chemins d'erreur Git, après l'accusé de transition vers `verifying` et après son heartbeat. Ils empêchent un accusé tardif de déclencher l'étape suivante. Le garde de PR18 après la boucle de preuves empêche la dernière écriture déjà engagée d'autoriser une finalisation locale après annulation. Les erreurs Git ordinaires conservent leur chemin `retryable` lorsque le bail n'est pas perdu. Le nettoyage final du renouvellement et les contrôles SQL de fencing restent inchangés.

Couverture lue dans les trois nouveaux fichiers :

- Sept cas utilisent de véritables processus Node locaux pour la préannulation sans lancement, l'arrêt en cours, la confidentialité du motif et les frontières de reprise asynchrone du worker et des profils. La synchronisation observe `stdout`, `spawn` ou `close`, sans délai arbitraire de déclenchement.
- Un cas suspend la dernière écriture de preuve et fait échouer un heartbeat pendant l'attente. La fixture `recordUsage` retourne maintenant `true`, conformément au contrat de PR21 ; elle ne reste pas bloquée avant la preuve à cause d'un ancien retour `undefined`.
- Cinq cas suspendent les réponses Git ou les accusés d'entrée en vérification. Ils vérifient l'absence de nouvelle transition, de heartbeat, de preuve et de finalisation après l'annulation, ainsi que l'unique appel d'accounting déjà réalisé.

Le léger chevauchement du cas de préannulation du driver avec un test existant est utile : la nouvelle fixture prouve aussi l'absence réelle de processus et l'absence de divulgation du motif. Aucun second moteur d'annulation ni mécanisme de budget parallèle n'est introduit.

Les gardes locaux ne retirent pas un effet fournisseur déjà accepté et ne rendent pas atomique une opération distante déjà engagée. L'arrêt des processus ne constitue pas une garantie générale sur tous leurs descendants. Ces limites ne sont pas présentées comme résolues.

## 4. PR24, dépendances et CI conservées

Les quatre fichiers suivants sont identiques octet pour octet à PR24 : `.github/workflows/purama-chef-hardening.yml`, `package.json`, `package-lock.json` et `tests/dependency-compat.cjs`. Leur version de base est également identique entre `1daf6314` et PR21, sauf le test alors absent : leur reprise ne remplace aucune évolution concurrente de PR21.

Les scripts `typecheck`, `test:quality` et `check:database-contracts` sont conservés. Les overrides OpenTimestamps et request restent ciblés. Le minimatch global reste en version 11 dans le lock ; l'ancien package racine de `b040af6` n'est pas réintroduit. Le test de compatibilité est le même blob que celui de `b040af6`. Les autres mises à jour de dépendances de cette ancienne branche sont déjà dans PR21, notamment `qs` 6.17.1 dans le lock KARTA.

**Limite CI explicite :** PR24 exécute `npm ci --no-audit` et réserve `npm audit` aux événements hors pull request. Le workflow conservé ne déclenche un push que sur `codex/purama-chef-hardening-20260927`. Une CI de pull request d'intégration ne fournit donc pas de résultat d'audit de dépendances. Les tests, le typage, les builds et le contrôle des contrats restent présents. Cette revue n'a modifié aucun de ces choix ni ajouté une exemption.

Les preuves importées dans `DEPENDENCY_QUALITY.md`, `karta/CHEF_EVIDENCE_SCOPE.md` et `qa/chef-cancellation-20261110/` appartiennent à PR10/PR18. Leurs nombres de tests, anciens diagnostics TypeScript ou audits ne constituent pas des résultats de cette nouvelle intégration. Le compte rendu final doit utiliser les nouveaux reçus pour l'état actuel.

## 5. Résultat ciblé effectivement examiné

`targeted-cancellation.result.json` indique une sortie 0, sans timeout, sous Node 22.23.4. `targeted-cancellation.vitest.json` confirme **44 tests réussis sur 44, zéro échec, zéro test en attente**, répartis sur huit fichiers physiques. Le compteur interne de suites Vitest vaut 16 ; il ne désigne pas seize fichiers.

Les huit fichiers sont `chefCancellation`, `chefSupervisorCancellation`, `chefGitCancellation`, `chefDriver`, `chefVerifier`, `chefSupervisor`, `chefVerificationGitIntegration` et `chefBudgetAccounting`, tous suffixés `.test.ts` sous `karta/test/`.

La suite complète est en cours au moment de la rédaction. **Aucun PASS global n'est attribué ici.** La lecture du reçu ciblé n'est pas une réexécution indépendante des tests, ni une validation PostgreSQL native, Redis ou fournisseur réel.

## 6. CI distante : échec observé avant runner, cause non confirmée

Les relevés précédents de cette session donnent le même motif observable pour des branches différentes : jobs conclus en échec avec `runner_id: 0`, nom de runner vide et `steps: []`. Il n'y a donc pas de preuve que les commandes du workflow aient été exécutées pour ces jobs.

| Référence | Run / tentative | Jobs KARTA et site |
| --- | --- | --- |
| PR18, `8063016b84b3513af1e52efea79d58dbbaff5682` | [42741839345](https://github.com/puramapro-oss/purama-ai/actions/runs/42741839345), tentative 1 | `129584522205`, `129584522579` |
| PR21, `b826af125ce296d3808d3b71b93fd084e63dbdb7` | [42744010152](https://github.com/puramapro-oss/purama-ai/actions/runs/42744010152), tentative 1 | `129591654375`, `129591654793` |
| Même PR21 | [42744010152](https://github.com/puramapro-oss/purama-ai/actions/runs/42744010152), tentative 2 | `129593073928`, `129593074256` |
| PR24, `9b066c5b10f6896041aec9359ee21b173c0f5014` | [42745424978](https://github.com/puramapro-oss/purama-ai/actions/runs/42745424978), tentative 1 | `129596251405`, `129596251045` |

Les métadonnées de checks consultées ne fournissaient pas l'explication : `output.title`, `output.summary` et `output.text` étaient nuls, avec deux annotations annoncées. Le chargement de l'endpoint des annotations a été refusé par le connecteur (`400 INVALID_ARGUMENT`, endpoint non autorisé). La lecture des logs du dernier job KARTA consulté a renvoyé `404 BlobNotFound`. Le statut combiné historique des commits n'apportait pas ces annotations.

**BLOQUÉ pour la cause précise.** Une annotation historique de facturation citée dans le document de PR10 concerne un autre run ; elle ne prouve pas la cause des échecs actuels. Ni facturation, ni quota, ni panne de runner ne sont affirmés ici. La résolution exige l'explication de check effectivement affichée par GitHub ou un accès autorisé à ses annotations. Aucun changement de CI, paiement, communication externe ou relancement n'a été effectué pendant ce diagnostic.

## 7. AETHER actuel : apport identifié, intégration laissée hors périmètre

Le commit `27815bcc9660adcc925f1a6c2b8651ff04ff5062` descend directement de `1daf6314d60f6dd336c3a3601ddf73cf432ef4b3`. Il apporte notamment :

- Une identité durable de livraison liée à l'utilisateur, l'agent et au contenu canonique, avec comparaison du job réellement conservé et du journal : `karta/src/queue/delivery-identity.ts`, `delivery-guard.ts`, `queues.ts`, `worker.ts`, `karta/src/engine/logger.ts` et migration `020_execution_fingerprints.sql`.
- Un contrôle du parent avant approbation et des preuves de continuation : `019_karta_approval_parent_guard.sql`, `karta/src/engine/approval-continuation.ts` et `loop.ts`.
- Une clé de suivi rendue par l'API et des états UI explicites : `karta/src/api/server.ts`, `src/hooks/useKartaEmployees.ts`, `src/lib/karta-run-status.ts` et les écrans KARTA concernés.

L'intersection textuelle des fichiers modifiés par AETHER et PR21 contient `karta/src/engine/loop.ts`. Leurs fonctions de reprise se chevauchent également : PR21 possède déjà `prepareAgentTriggerContext`, l'origine persistée de délégation et un garde d'action résolue. Une copie du fichier AETHER ferait perdre ces apports ; empiler les deux chemins sans arbitrage du contexte et des règles de continuation créerait des doublons. Les règles ne sont pas identiques : PR21 peut ignorer une action déjà exécutée et poursuivre, tandis que le garde AETHER arrête les actions restantes quand la même action résolue est reproposée.

**Conflit potentiel de numérotation à traiter dans un lot séparé :** PR21 ajoute `019_pending_action_execution_trigger.sql`, AETHER ajoute `019_karta_approval_parent_guard.sql`. Ce sont deux fichiers et objets SQL différents ; la revue ne conclut pas qu'ils sont intrinsèquement incompatibles. Leur numéro commun, leur ordre et leur suivi par l'outil réel de migration doivent cependant être réconciliés avant déploiement.

La migration 020 et `delivery-guard.ts` imposent explicitement de drainer/arrêter les anciens workers avant de démarrer les producteurs/workers v2. Le patch `karta/test/evidence/aether-pr20-brief-integration.patch` est une proposition avec dépendances à PR20 ; il ne constitue pas un rapprochement exécuté de PR21. Aucun de ces éléments n'a été absorbé dans le lot CHEF courant et aucun déploiement n'en découle.

## Conclusion de revue

**PASS — pas de correction de production supplémentaire demandée par cette revue sur les six blobs CHEF identifiés.** La composition conserve les budgets et le contexte de PR21, les annulations de PR18, les quatre fichiers exacts de PR24 et leurs preuves historiques distinctes. La décision de publication doit s'appuyer sur le résultat final de validation du même snapshot ; les limites CI et AETHER ci-dessus restent explicites.

## Complément indépendant — 10 novembre 2026, 03:59:32 UTC

**PASS pour la campagne locale bornée : 801 tests réussis sur 801, dans 63 fichiers physiques répartis sur 17 lots.** Ce statut qualifie la campagne séparée décrite ci-dessous. Il ne transforme pas les campagnes précédentes en succès et ne constitue pas un PASS de la commande globale standard.

### Recalcul des reçus et couverture physique

La revue a lu et parsé séparément les dix-sept fichiers `bounded/*.vitest.json`, au lieu de reprendre seulement les totaux de `bounded/summary.json`. Pour chaque reçu, elle a vérifié `success`, les compteurs, le statut de chaque fichier et chaque cas de test, ainsi que l'absence de messages d'échec. Les résultats se répartissent ainsi :

| Reçu dans `bounded/` | Fichiers physiques | Tests réussis |
| --- | ---: | ---: |
| `00-non-sql.vitest.json` | 47 | 592 |
| `01-approval.test.vitest.json` | 1 | 15 |
| `02-approvalTriggerContext.test.vitest.json` | 1 | 8 |
| `03-chatHistoryIsolation.test.vitest.json` | 1 | 39 |
| `04-chefBudgetMigration.test.vitest.json` | 1 | 2 |
| `05-chefBudgetReservations.test.vitest.json` | 1 | 28 |
| `06-chefControlPlane.test.vitest.json` | 1 | 8 |
| `07-chefEvidenceFreshness.test.vitest.json` | 1 | 31 |
| `08-chefEvidenceGate.test.vitest.json` | 1 | 17 |
| `09-chefHardening.test.vitest.json` | 1 | 15 |
| `10-chefIndependentReview.test.vitest.json` | 1 | 2 |
| `11-chefMission.test.vitest.json` | 1 | 5 |
| `12-chefRuntimePolicy.test.vitest.json` | 1 | 4 |
| `13-connectPermissions.test.vitest.json` | 1 | 4 |
| `14-loggerFinalization.test.vitest.json` | 1 | 11 |
| `15-runtimeHardening.test.vitest.json` | 1 | 3 |
| `16-walletRpcPermissions.test.vitest.json` | 1 | 17 |
| **Total** | **63** | **801** |

Le recalcul retrouve **592 + 209 = 801 cas de test** dans les tableaux `assertionResults`, tous au statut `passed`. Les sommes des compteurs sont également 801 tests totaux et 801 réussis, avec **zéro test échoué, pending, todo ou skipped**, et zéro suite échouée ou en attente. Les 17 codes de sortie consignés sont 0 ; aucun lot n'est marqué interrompu ou expiré. Chaque commande conservée vise les fichiers réellement présents dans son reçu, avec `--maxWorkers=1 --no-file-parallelism`.

Les chemins de `testResults` ont été normalisés puis comparés à un inventaire indépendant de `karta/test/**/*.test.ts`, correspondant au `include` de Vitest : **63 occurrences, 63 chemins distincts, aucun fichier omis, supplémentaire ou exécuté dans plusieurs lots**. Les listes de fichiers et les compteurs par lot du résumé correspondent aux reçus détaillés. Quelques cas `it.each` existants ont le même libellé affiché pour des entrées différentes ; ils ne sont pas des relances de fichiers. Le chiffre 801 désigne des cas de test exécutés, pas 801 intitulés distincts ni un nombre d'appels `expect`. Les 44 tests ciblés précédents sont inclus dans ce périmètre et ne s'ajoutent pas à 801.

`bounded-suite.result.json` confirme la sortie globale 0, sans timeout ni erreur de lancement, en **272,979 secondes** pour le processus complet. Les horodatages internes de `bounded/summary.json` couvrent 272,856666 secondes ; la somme des durées arrondies des lots vaut 272,596 secondes. Ces mesures ont des périmètres différents et ne mesurent pas la latence de PURAMA en production.

### Empreintes et modifications de fixtures SQL

Les **16 entrées distinctes de `verified-source-manifest.json`** ont été recalculées à partir des fichiers présents, en SHA-256 et en blob Git : **16 correspondances, aucune divergence**. Les 63 SHA-256 de tests enregistrés dans `bounded/summary.json` ont également été recalculés et correspondent à l'inventaire actuel sans divergence. Le manifeste vérifié complète le premier snapshot par les deux fixtures ajustées et le lanceur de validation bornée ; il ne modifie pas les empreintes des trois sources CHEF revues précédemment.

Relecture des deux différences de tests par rapport à PR21 :

- `karta/test/chatHistoryIsolation.test.ts`, blob `4064c0589e5601bc08f1515f5b7abdc87a366149` : l'initialisation et la fermeture PGlite des cas de précontrôle passent dans des hooks explicites à 30 secondes. Chaque cas paramétré conserve sa propre base. Le cas sans tables conserve une fixture séparée. Les huit variantes de schéma, l'exécution de la migration sous test, les rejets attendus, le rollback et la comparaison du snapshot de droits restent dans les tests et sont conservés.
- `karta/test/chefEvidenceFreshness.test.ts`, blob `349825710aa22afb9f725872a05b1c740da642c9` : seul le bootstrap de la base historique et des migrations 008 à 016 est déplacé dans un `beforeAll`, avec fermeture dans un `afterAll`. Les insertions de données historiques, l'application de la migration 017 et les assertions restent dans le test. La conservation des anciennes preuves avec identité de claim inconnue et leur refus comme preuve courante restent vérifiés.

La différence ne retire aucune assertion ni migration. Les lignes d'assertion et de référence aux migrations comparées sont identiques avant/après ; la lecture du diff confirme que les changements portent sur les fixtures et leur nettoyage. Aucun fichier de migration, `karta/vitest.config.ts`, timeout de test ou retry n'a été modifié par ces deux ajustements. Le budget de hook explicite de 30 secondes correspond au budget de hook déjà configuré. Le lancement borné ne contient aucun argument augmentant ces délais ou ajoutant une reprise automatique.

### Campagnes antérieures conservées et portée du PASS

Les reçus antérieurs restent présents et gardent leur statut :

| Campagne / reçu | Résultat conservé |
| --- | --- |
| `full-suite-launch-error.json` | **NON EXÉCUTÉ** : l'outil optionnel `/usr/bin/time` manquait ; zéro test lancé lors de cette tentative. |
| `full-suite-default.result.json` et `full-suite-default.vitest.json` | **ÉCHEC** : sortie 1, 799 tests réussis sur 801, deux timeouts à 5 secondes dans les cas de schéma incomplet de `chatHistoryIsolation.test.ts`, durée 84,693 secondes. |
| `final-suite-interrupted.json` | **INTERROMPU** : sortie de session 130 ; aucun décompte complet ni PASS. La pression mémoire et les compteurs OOM concernent le cgroup partagé, sans identification des processus tués. |
| `bounded-suite.result.json` et les 17 reçus détaillés | **PASS borné** sur les fixtures corrigées et les sources identifiées : 801/801, couverture physique complète et unique. |

Le succès borné établit que chaque fichier de cette suite KARTA passe dans les processus isolés décrits. Il ne démontre pas la réussite de la commande standard globale avec son parallélisme habituel, ni une qualification PostgreSQL native multiconnexion, Redis, fournisseur, navigateur ou production. Le blocage de CI avant runner et les contraintes d'intégration AETHER consignés plus haut restent inchangés.

Ce complément repose sur la relecture indépendante des reçus, des empreintes et du diff. **Aucun test n'a été relancé par le réviseur ; seule cette note a été complétée.**
