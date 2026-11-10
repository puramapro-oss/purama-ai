# CHEF — annulations respectées jusqu’à la validation finale

Audit et correctif du 10 novembre 2026. **PASS pour les 29 tests ciblés, le typage
et la compilation KARTA sur la base finale. PARTIEL pour la validation globale,
l’intégration et la mise en service.**

## Résultat et périmètre

Le correctif ferme six scénarios reproduits dans les décisions locales de CHEF :
un worker ou un profil pouvait démarrer malgré un signal déjà annulé ; une réponse
tardive pouvait encore être acceptée comme réussite ; le superviseur pouvait
finaliser une tâche après avoir lui-même annulé son cycle pendant la dernière
écriture de preuve.

Trois fichiers de production changent : `karta/src/chef/driver.ts`,
`karta/src/chef/verifier.ts` et `karta/src/chef/supervisor.ts`. Deux fichiers de
régression sont ajoutés. Aucun contrat SQL, prix, quota ou connecteur fournisseur
n’est modifié par ce lot.

La reproduction a été effectuée sur `e8f1ce2e16aacdfdb6108a2fa33bea70c198b94e`.
La branche parente a avancé pendant le travail ; le candidat final reprend
`b040af6dd7abe202a4dd7996f0ffad41c1b742bf`, tête observée de la PR 10. Ce commit
change notamment `qs` de 6.16.0 à 6.17.1 dans le lock KARTA, mais aucun de nos cinq
fichiers. Les dépendances KARTA ont été réinstallées depuis ce nouveau lock.
Les preuves prises sur la première base restent identifiées comme telles.

## Défauts reproduits et corrections

| Scénario | Avant correction | Comportement exigé et obtenu sur la première base |
| --- | --- | --- |
| Signal annulé avant `ProcessChefDriver.run()` | Un processus était lancé et pouvait réussir | Rejet contrôlé, aucun lancement |
| Signal annulé avant `CommandChefVerifier.verify()` | Un profil était lancé et pouvait réussir | Rejet contrôlé, aucun profil ni preuve acceptée |
| Annulation après résolution interne du worker, avant retour asynchrone | Réponse `completed` acceptée | Nouvelle lecture du signal après l’attente, puis rejet |
| Annulation après le dernier profil | Réussite globale acceptée | Contrôle après chaque attente, avant acceptation de preuve |
| Annulation entre deux profils | Profil suivant encore lancé | Arrêt avant le profil suivant |
| Annulation pendant la dernière écriture de preuve | Transition `verified_done` et finalisation de mission demandées | Retour `lost_lease`, aucune de ces deux demandes |

Les contrôles avant lancement, après installation des listeners et après les
attentes ferment les fenêtres concernées. Les handlers et leur nettoyage sont
initialisés avant l’enregistrement du listener d’annulation. Les erreurs
d’annulation restent génériques et ne recopient pas un `signal.reason` arbitraire.

Le superviseur relit la perte de bail après la boucle des preuves, avant tout
traitement final de réussite ou d’échec. Une écriture déjà engagée peut confirmer
son succès après l’annulation ; sa confirmation ne réautorise plus le cycle.
Les contrôles atomiques distants de propriétaire, tentative et fencing restent
nécessaires et sont inchangés.

## Preuves de reproduction

`chefCancellation.test.ts` contient sept scénarios : cinq échouaient avant
correction et deux contrôles d’annulation en cours réussissaient déjà. Les tests
observent de vrais processus Node locaux sans fichier métier, réseau ni fournisseur.
L’ordre réel des événements et un marqueur de sortie synchronisent les scénarios ;
aucun délai arbitraire ne provoque les courses. Les enfants sont nettoyés.

`chefSupervisorCancellation.test.ts` ajoute un scénario avec promesse différée et
faux timers. Le renouvellement distant réussit, puis son heartbeat échoue pendant
l’écriture de la dernière preuve. Le test observe réellement `signal.aborted`
avant de laisser l’écriture répondre `true`. Il échouait avec `verified_done`,
la transition finale et un appel de `tryFinishMission`.

Les journaux `baseline.log` et `baseline-supervisor.log` conservent ces six échecs.
Les fichiers JSON associés indiquent commandes, version Node, base et codes retour.

## Vérifications déjà exécutées sur la première base

Runtime : Node 24.22.1, Vitest 5.0.1, Linux.

| Commande dans `karta` | Résultat | Journal |
| --- | --- | --- |
| Six fichiers ciblés CHEF | PASS — 29/29 tests, dont les huit nouveaux scénarios | `targeted.log` |
| `npm run typecheck` | PASS | `typecheck.log` |
| `npm run build` | PASS | `build.log` |
| `npm test` | PARTIEL — 495/496 ; un timeout PGlite à 5 secondes | `full-suite.log` |
| Historique conversation isolé | 37/39 ; deux timeouts à 5 secondes | `history-isolated.log` |
| Même historique sur la base originale sans correctif | 37/39 ; deux timeouts à 5 secondes | `history-original-base.log` |
| `npm test -- --maxWorkers=2 --testTimeout=20000` | PASS — 496/496, 47 fichiers | `full-suite-runtime-budget.log` |

Les dépassements de temps touchent des fixtures SQL dont les sources et
dépendances sont inchangées par notre correctif. Leur reproduction sur la base
originale ne démontre pas la cause précise de leur lenteur. Le passage avec un
budget de 20 secondes **ne valide pas** le délai standard de 5 secondes.
Le test d’historique, ses assertions et la configuration permanente de Vitest
n’ont pas été modifiés.

## Validation finale sur la base actualisée

Runtime final : **Node 22.23.4**, même version majeure que la CI, et lock KARTA
de `b040af6dd7abe202a4dd7996f0ffad41c1b742bf`. Le runtime était déjà disponible
dans le cache ; aucun paquet du dépôt n’a été changé pour le sélectionner.

| Contrôle sur la base finale | Résultat | Journal |
| --- | --- | --- |
| Installation du lock KARTA | PASS | `final-install.log` |
| Six fichiers CHEF, deux workers, délai de test standard 5 s | PASS — 29/29 tests | `final-targeted-node22.log` |
| TypeScript KARTA sans émission | PASS | `final-typecheck-node22.log` |
| Compilation KARTA | PASS | `final-build-node22.log` |
| `npm test` standard | BLOQUÉ — commande dépassant 300 s ; aucune réussite ni aucun compte de tests revendiqués | `final-default-node22-timeout.json` |
| Suite complète, deux workers et 20 s par test | PARTIEL — 487/496 tests réussis, 46 fichiers réussis ; worker de l’historique SQL interrompu par SIGKILL | `final-suite-node22.log` |
| Fichier d’historique SQL isolé, un worker et 20 s par test | PASS — 39/39 tests | `final-history-node22.log` |

Les derniers essais appellent directement les exécutables Vitest et TypeScript
du package avec Node 22 ; les commandes exactes figurent dans les JSON associés.
La cause du SIGKILL n’est pas établie. L’erreur du pool Vitest rend ce passage
global non réussi, même si les tests du correctif passent. Aucun résultat Node 24
de la première base n’est réattribué à cette base finale. La CI standard n’est
pas déclarée validée par ces commandes adaptées.
Le passage isolé du fichier interrompu couvre ses 39 cas ; il n’efface pas
l’erreur de l’exécution globale. Les comptes de ces passages se recouvrent et
ne doivent pas être additionnés comme des tests distincts.

## Analyse d’impact et revue

GitNexus 1.6.12 a été indexé et utilisé avant les modifications. Les quatre
analyses de symboles (`run`, `verify`, `runProfile`, `runChefWorkerCycle`) ont
retourné LOW. Les appelants directs remontent vers le superviseur, puis
`worker-main.ts`. Les limites de dispatch par interfaces et la troncature de
certains parcours du graphe ont été prises en compte par lecture du code et tests.

Le premier `detect-changes --scope staged` a classé le lot agrégé **HIGH** :
cinq fichiers, treize symboles, sept parcours recensés. La comparaison à `main`
sur la première base a classé l’héritage complet **CRITICAL** : 215 fichiers et
1 285 symboles. Ces alertes ont été signalées ; les résultats ne justifient aucune
fusion automatique de l’ensemble des branches. Les sorties sont conservées dans
`impact-*.log`, `context-supervisor.log`, `detect-staged.log` et `detect-main.log`.

La réindexation après déplacement de la base a dépassé 240 secondes. Les deux
premières nouvelles analyses `detect-changes` ont dépassé 75 secondes chacune.
Ces échecs sont conservés dans `final-index-timeout.json` et `final-detect-*`.
L’index confirmé reste celui de la base initiale ; les trois sources CHEF
originales sont identiques entre les deux bases. L’analyse initiale n’est donc
pas présentée comme une indexation réussie de tous les changements hérités de
la nouvelle base. La comparaison Git exacte des cinq fichiers et leurs
empreintes sont consignées dans `source-manifest.json`.

Les deux commandes ont ensuite **abouti sous Node 22.23.4**, sans changer l’index
ni les sources : `final-detect-node22-staged.log` confirme les cinq fichiers,
treize symboles et sept parcours attendus, risque HIGH ;
`final-detect-node22-main.log` rapporte 217 fichiers hérités, 1 285 symboles et
250 parcours, risque CRITICAL. Cette comparaison utilise toujours l’index initial
et n’est pas une requalification complète des nouvelles dépendances ou du site.
Le dernier contrôle avant commit, incluant les fichiers de preuve préparés,
confirme les mêmes treize symboles et sept parcours attendus ; sa sortie figure
dans `precommit-detect.log`. Les blancs supplémentaires en fin de journal ont été
normalisés, sans suppression des erreurs ni des résultats d’essai.

Une seconde revue statique par un agent distinct a lu le patch et les huit
scénarios, vérifié l’ordre des handlers, les gardes après attente, les chemins
d’échec et l’absence de changement des contrôles distants. Aucun défaut bloquant
n’a été trouvé. Cette revue n’est pas présentée comme une seconde exécution des
tests. `git diff --check` a réussi.

Les changements publiés des PR 13 à 16 et de la branche AETHER observée ne
modifiaient pas ces trois fichiers de production. Les worktrees Mac non publiés
ne sont pas observables depuis ce checkout. La mise à jour de PR 10 a été relue
avant de déplacer la base ; les empreintes des cinq fichiers du correctif sont
restées identiques.

## Limites et intégration

- **PARTIEL — intégration :** proposition isolée au-dessus de PR 10, sans fusion
  ni déploiement de production. Le mainteneur doit rapprocher les lignées actives.
- **NON TESTÉ — services réels :** aucun worker fournisseur, aucune base Supabase
  distante et aucun pilote Hostinger n’ont été sollicités par ces essais.
- **NON TESTÉ — effets externes :** arrêter un cycle ne démontre ni l’arrêt de
  tous les descendants d’un processus, ni l’annulation d’une action déjà engagée
  chez un fournisseur. Une preuve déjà enregistrée n’est pas effacée.
- **NON TESTÉ — réception globale :** ce lot ne certifie pas l’application ONE,
  les paiements, les appareils réels, les performances de production ni une
  disponibilité continue.

L’intégration conserve les dépendances et réserves de `karta/CHEF_EVIDENCE_SCOPE.md`,
notamment les migrations 016/017 incompatibles avec une autre lignée T1. Ce lot
n’ajoute aucune migration et ne résout pas cette incompatibilité. Le document
`DEPENDENCY_QUALITY.md` décrit séparément les contrôles et défauts de l’application
racine ; le typage KARTA réussi ne qualifie pas cette application.

Le mainteneur du dépôt prend en charge l’intégration. L’opérateur des services
qualifie ensuite un pilote réel avec annulation avant lancement, pendant
vérification et pendant l’enregistrement final, puis vérifie la reprise et le
rapprochement des effets déjà engagés.
