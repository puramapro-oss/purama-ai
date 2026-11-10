# CHEF — rétablissement des contrôles d’annulation perdus à la consolidation

**Rapport local avant publication et CI — 10 novembre 2026.**

La PR existante [18](https://github.com/puramapro-oss/purama-ai/pull/18) porte ce correctif. Son état et ses contrôles GitHub donnent la qualification distante postérieure à ce rapport. Ce document conserve les résultats locaux, y compris les campagnes interrompues.

## Résultat du correctif

**PASS sur le défaut reproduit : cinq scénarios échouent sur la base intacte, puis réussissent avec le correctif.**

Base exacte : `1a49ad646b529c6fb95335105c8a4e5f28468d76`, tête de la consolidation PR36 au moment de la préparation. Le travail antérieur de PR18, `7cef7e57268ba2326d256d10277434a751ae1275`, contenait cinq gardes et leur test qui n’avaient pas été repris dans PR33/PR36. Les autres améliorations récentes ont été conservées.

**Rapprochement avant publication :** PR36 a ensuite avancé vers `ca2f92b2887c711d152cbfd7e3615c3264a875a8`. Ses deux modifications du lecteur partagé de corps et de son test ont été reprises intégralement. Le sous-arbre KARTA est identique entre les deux bases, ainsi que les empreintes du correctif CHEF. Les reçus locaux conservent leur vraie base `1a49ad6` ; la CI devra qualifier la composition publiée sur `ca2f92b`. Voir [la preuve de rapprochement](./publication-base-reconciliation.json).

Un renouvellement du bail peut réussir côté serveur, puis son heartbeat échouer. Le cycle local est alors annulé alors que le jeton distant peut encore être valide. Une réponse tardive à une opération déjà envoyée ne doit pas permettre au superviseur de lancer une nouvelle transition, un heartbeat ou une vérification.

Le correctif ajoute les contrôles de `lostLease` aux cinq frontières suivantes dans `runChefWorkerCycle` :

| Frontière | Défaut reproduit sur la base | Résultat corrigé |
| --- | --- | --- |
| Rejet du premier contrôle Git après annulation | Nouvelle transition `retryable` | Retour `lost_lease` |
| Succès du premier contrôle Git après annulation | Transition `verifying`, heartbeat et appel du verifier | Arrêt avant ces actions |
| Accusé de réception tardif de la transition `verifying` | Heartbeat et appel du verifier | Arrêt après l’accusé de réception |
| Accusé de réception tardif du heartbeat `verifying` | Appel du verifier | Arrêt avant cet appel |
| Rejet du contrôle Git final après annulation | Nouvelle transition `retryable` | Retour `lost_lease` |

Le fichier de test est repris exactement de PR18, blob `b7597af775f9eb56c0e3fe9a54ed6b94848cb5f9`. Il utilise des promesses différées et l’horloge simulée ; aucun délai artificiel n’a été ajouté pour faire passer les assertions. Les cinq cas contrôlent également une comptabilisation unique, l’absence de nouvelle preuve et l’absence de finalisation.

## Périmètre et préservation des travaux récents

- Un seul fichier de logique produit change : `karta/src/chef/supervisor.ts`, six lignes ajoutées et une supprimée.
- Le test absent est réintégré dans `karta/test/chefGitCancellation.test.ts` ; les tests d’annulation déjà présents restent identiques.
- La comptabilité d’usage tardive conserve sa place avant le contrôle de perte de bail. Les chemins d’arrêt, de quarantaine, de preuves et le nettoyage `finally` restent inchangés.
- `driver.ts`, `verifier.ts`, `process.ts`, `control-plane.ts`, `worker-main.ts` et `git-state.ts` restent identiques à la base, empreintes dans [scope-manifest.json](./scope-manifest.json).
- `vercel.json` ajoute uniquement `git.deploymentEnabled["codex/chef-cancellation-20261110"] = false`. Cela désactive les déploiements Git automatiques de cette branche selon la [documentation Vercel](https://vercel.com/docs/project-configuration/git-configuration). Aucune autre règle ni workflow n’est modifié.
- Le planificateur PR34 était déjà repris dans la consolidation ; aucun second correctif de ce lot n’est ajouté. Les travaux OTS et AKASHA restent ceux de la base.

Empreinte SHA-256 du superviseur vérifié : `a3e66a1909f10fbefdf6cf6cbb8716e388a5f46874cdf925e46cd2697acdc1bd` ; blob Git : `b9c9060426b5c2c2eef7343bfe7e5f3479044177`.

## Vérification locale

Environnement : Node **22.23.4**, Vitest **5.0.3**, installation isolée depuis le lockfile avec `npm ci --offline --ignore-scripts --no-audit --no-fund`. Aucun délai ni assertion de test existant n’est modifié. Les tests remplacent les identifiants fournisseurs par des valeurs de test et refusent les appels `fetch` imprévus.

| Contrôle | Résultat prouvé |
| --- | --- |
| Contre-épreuve sur la production intacte de la base | **5 échecs / 5**, [JSON](./baseline-five.json), [journal](./baseline-five.log) |
| Mêmes cinq scénarios après correction | **5 réussites / 5**, [JSON](./fixed-five.json), [journal](./fixed-five.log) |
| Fichiers appelant réellement `runChefWorkerCycle` | **41 / 41 tests réussis dans 5 fichiers** |
| Typage de tout KARTA | **PASS**, Node avec `--max-old-space-size=512`, [reçu](./typecheck-bounded.receipt.json) |
| Compilation KARTA | **PASS**, commande standard `tsc -p tsconfig.build.json`, [reçu](./build.receipt.json) |
| Suite KARTA globale, un worker | **Interrompue par SIGKILL**, sortie `-9`, sans rapport JSON final, [reçu](./full-karta.receipt.json) |
| Tous les fichiers KARTA en processus successifs | **PARTIEL : 95 / 95 fichiers pris en compte, 82 fichiers réussis, 13 workers arrêtés par SIGKILL** |
| Assertions de cette campagne successive | **1 345 réussies, 297 sans résultat final, 0 assertion échouée enregistrée** ; 13 erreurs de worker non gérées |
| Vérification locale des contrats générés | **BLOQUÉE par SIGKILL** dans les deux tentatives ; aucun PASS attribué |
| Parcours de production et services réels | **NON TESTÉS par ce lot local** |

Les 41 tests du superviseur sont inclus dans les 1 345 réussites ; ils ne doivent pas être additionnés. Les 5 tests de reproduction réussis sont également repris dans ce sous-ensemble.

La campagne successive dure 321,253 secondes. Les 95 fichiers attendus figurent chacun une fois dans son inventaire, sans absence ni doublon. Le superviseur et les tests ont les mêmes empreintes avant et après. Le [lanceur](./run-bounded-validation.py) conserve les commandes et les résultats ; le [journal combiné](./bounded/combined.log) contient leurs sorties.

**Attention à la lecture des JSON Vitest interrompus :** ils affichent parfois `success: true` alors que le processus sort avec une erreur et que ses assertions sont encore `pending`. Le compteur global rapporté `numPendingTests` vaut seulement 2, alors que la lecture des statuts individuels trouve **297 assertions non terminées**. Le lanceur exige aussi un code de sortie nul et toutes les assertions réussies ; il a donc correctement classé ces 13 fichiers en échec de campagne. Le [résumé indépendant](./verification-summary.json) et la [contre-vérification](./bounded-independent-review.md) donnent les chiffres corrigés de cette ambiguïté, sans modifier les rapports d’origine.

Les SIGKILL sont prouvés. Leur cause exacte ne l’est pas : aucun compteur cgroup exploitable n’est disponible ici. Ils ne sont pas attribués avec certitude à la mémoire, et ils ne permettent pas de déclarer les tests concernés réussis. Une tentative de typage sans limite de heap a également été arrêtée ; la nouvelle exécution complète avec un heap borné à 512 MiB a réussi.

## Analyse d’impact et revue

L’analyse GitNexus préalable identifie `main` dans `worker-main.ts` comme appelant direct du superviseur et classe l’impact amont à **LOW**. La détection sur le diff de code identifie **une fonction modifiée et cinq flux CHEF**, risque **medium**. Les appels à travers les interfaces ne sont pas tous représentés par le graphe ; ils ont été relus dans les sources et exercés par les tests.

L’index neuf a échoué avant sa finalisation. Un snapshot vérifié de l’index du commit `90d8f30322e864ccfd186e97cbfe7edf3afec9a9` a donc été copié dans ce checkout isolé, sans modifier l’index source. Les sources CHEF concernées étaient identiques entre ce commit et la base `1a49ad6`. Les chemins locaux du snapshot ont été relocalisés ; son commit et sa date d’indexation n’ont pas été présentés comme plus récents. Voir [la provenance](./index-snapshot-provenance.json).

Les comparaisons GitNexus globales avec `main` ont été lancées et arrêtées par SIGKILL. Elles ne constituent pas un contrôle réussi de toute la consolidation. Le diff ciblé et la [revue indépendante](./independent-review.md) qualifient le correctif local ; la CI de la PR doit fournir la qualification globale sur son propre runner.

## Qualification distante et livraison

La CI [42890295731](https://github.com/puramapro-oss/purama-ai/actions/runs/42890295731) est une preuve historique réussie sur `5dc305097e28cc19fb67c1c6d93270815982390d`. Elle ne qualifie pas ce nouveau correctif. La base PR36 `1a49ad6` ne portait pas de CI propre lors de sa lecture ; ses derniers commits avaient été préparés avec `[skip ci]`.

Ce lot prépare une nouvelle vérification par le workflow déjà configuré, sur la PR18 existante, pour résoudre les vérifications localement interrompues. Le déploiement automatique de cette branche est désactivé. La tête, l’arbre publié et les résultats CI finaux doivent être lus dans [la PR18](https://github.com/puramapro-oss/purama-ai/pull/18). Aucune fusion vers `main`, migration distante ou mise en production n’est effectuée par la préparation locale décrite ici.

Le critère de livraison est un correctif réduit, reproductible et relu, rattaché à la consolidation actuelle, avec son état de CI explicite. Ce rapport ne prétend pas certifier tous les usages, services ou performances de PURAMA en production.
