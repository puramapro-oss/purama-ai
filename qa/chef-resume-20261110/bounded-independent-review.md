# Contre-vérification indépendante de KARTA

**Statut : PARTIEL. La qualification globale est BLOQUÉE.** La campagne bornée a couvert exactement les 95 fichiers attendus, mais seuls 82 ont terminé avec succès. Les rapports individuels prouvent **1 345 assertions réussies sur 1 642 recensées** ; **297 assertions restent sans résultat vérifié** après l’arrêt forcé de 13 workers. Aucune assertion `failed` n’est enregistrée ; cela ne constitue pas un succès global.

## Sources et méthode

La relecture porte sur `bounded/summary.json`, les **95 rapports JSON Vitest**, leurs **95 journaux bruts**, les reçus de commandes, `bounded/combined.log`, l’inventaire des tests et leurs empreintes. Aucun test supplémentaire n’a été exécuté par cette relecture. Le résumé d’exécution original reste intact.

- Base testée : `1a49ad646b529c6fb95335105c8a4e5f28468d76`.
- Node : `v22.23.4` ; un processus Vitest à la fois, `--maxWorkers=1`.
- Commande par fichier : `node node_modules/vitest/vitest.mjs run test/<fichier>.test.ts --maxWorkers=1 --reporter=default --reporter=json --outputFile=<rapport>` depuis `karta/`.
- Aucune option CLI n’allonge les délais des tests. Le lanceur conserve les assertions et les délais du dépôt ; les 95 empreintes des fichiers de tests sont inchangées.
- Fenêtre de campagne : 2026-11-10T21:39:03.589594+00:00 à 2026-11-10T21:44:24.849099+00:00 ; 321.253 secondes.
- SHA256 du résumé original : `d4e8ab85676a8533dd4ee62f3628c4b0cf9c7044a99802b4788968496cd6cfe8`.
- SHA256 du journal combiné : `bfdcac383959bb3e935bcb064ca16e96769bf51e47820cd0349bce997271c509`.

## Résultats établis

| Contrôle | Résultat | Statut |
|---|---:|---|
| Fichiers attendus / reçus / rapports distincts | 95 / 95 / 95 | PASS |
| Fichiers manquants, inattendus ou dupliqués | 0 / 0 / 0 | PASS |
| Fichiers entièrement réussis | 82 | PASS local à ces fichiers |
| Fichiers arrêtés avec erreur de worker | 13 | BLOQUÉ |
| Assertions réussies | 1 345 | PASS local à ces assertions |
| Assertions sans résultat vérifié (`pending`) | 297 | NON TESTÉ complètement |
| Assertions `failed` | 0 enregistrée | Ne clôt pas le gate |
| Erreurs non gérées de worker | 13 | BLOQUÉ |
| Délais maximum du lanceur dépassés / interruptions signalées | 0 / 0 | PASS |
| Empreintes JSON, journaux et noms/statuts conformes aux reçus | 95 / 95 | PASS |
| Journal combiné identique à la concaténation des journaux bruts | Oui | PASS |
| Tests et `supervisor.ts` identiques aux empreintes enregistrées | Oui | PASS |

Les 13 échecs de processus ont tous un code de sortie **1** du processus Vitest et le message `Worker exited unexpectedly with signal SIGKILL` dans leur journal. **Le signal est prouvé ; sa cause n’est pas établie.** Les relevés de mémoire disponible ne suffisent pas à conclure à un arrêt par manque de mémoire.

## Compteurs trompeurs de Vitest

Les 13 rapports JSON issus des workers arrêtés annoncent malgré tout `success: true`. Leur compteur `numFailedTests` vaut zéro. L’agrégat `numPendingTests` vaut **2**, alors que les entrées `assertionResults` contiennent **297 statuts `pending`**. Les journaux de `chefBudgetMigration` et `chefEvidenceFreshness` avertissent aussi que le rapport JSON a été produit alors que des tests étaient encore considérés comme en cours.

Il faut donc réconcilier **code de sortie, états individuels et erreurs du journal**. Le lanceur a correctement marqué les 13 fichiers `success: false` ; cette relecture conserve ce résultat et corrige seulement l’interprétation des compteurs dans le présent rapport et `verification-summary.json`.

**Aucun saut volontaire de test n’est établi.** L’inventaire statique contient seulement trois conditions `skipIf(process.platform === "win32")`, dans `chefProcess.test.ts` et `chefSupervisor.test.ts`. Ces deux fichiers ont terminé ici avec toutes leurs assertions réussies. Les 297 `pending` après SIGKILL ne doivent pas être présentés comme 297 tests volontairement ignorés, ni comme 297 tests dont on sait qu’ils n’ont jamais démarré.

## Fichiers dont la qualification reste bloquée

| Fichier | Assertions réussies | Assertions `pending` | Motif prouvé |
|---|---:|---:|---|
| `approval.test.ts` | 0 | 15 | SIGKILL du worker |
| `approvalContinuation.test.ts` | 0 | 42 | SIGKILL du worker |
| `approvalParentGuard.test.ts` | 0 | 48 | SIGKILL du worker |
| `chatHistoryIsolation.test.ts` | 32 | 7 | SIGKILL du worker |
| `chefBudgetAdmission.test.ts` | 0 | 18 | SIGKILL du worker |
| `chefBudgetMigration.test.ts` | 1 | 2 | SIGKILL du worker |
| `chefBudgetReservations.test.ts` | 0 | 28 | SIGKILL du worker |
| `chefControlPlane.test.ts` | 0 | 8 | SIGKILL du worker |
| `chefEstimates.test.ts` | 0 | 44 | SIGKILL du worker |
| `chefEvidenceFreshness.test.ts` | 30 | 1 | SIGKILL du worker |
| `chefHardening.test.ts` | 0 | 15 | SIGKILL du worker |
| `commercePrivileges.test.ts` | 0 | 58 | SIGKILL du worker |
| `loggerFinalization.test.ts` | 0 | 11 | SIGKILL du worker |

## Périmètre directement lié au supervisor

Les cinq fichiers qui appellent réellement `runChefWorkerCycle` sont **PASS : 41 assertions sur 41**.

| Fichier | Assertions réussies | Statut |
|---|---:|---|
| `chefBudgetAccounting.test.ts` | 12 | PASS |
| `chefGitCancellation.test.ts` | 5 | PASS |
| `chefSupervisor.test.ts` | 20 | PASS |
| `chefSupervisorCancellation.test.ts` | 1 | PASS |
| `chefVerificationGitIntegration.test.ts` | 3 | PASS |

Ce résultat valide les scénarios présents dans ces tests ; il ne prouve pas une couverture exhaustive du supervisor.

Le périmètre élargi de 18 fichiers, comprenant annulation, Git, arrêt worker, processus, adaptateurs de preuves/budgets/quarantaine et migrations de budgets, reste **PARTIEL : 15 fichiers réussis, 132 assertions réussies et 48 `pending`**. Les blocages de ce périmètre sont `chefBudgetAdmission`, `chefBudgetMigration` et `chefBudgetReservations`. `chefWorkerShutdown` simule le supervisor et vérifie l’orchestration du démon ; il ne remplace pas les cinq tests appelant la vraie fonction.

Les listes exactes des 18 fichiers et les résultats individuels des 95 fichiers sont consignés dans `verification-summary.json`.

## Portée et suite nécessaire

L’inventaire de fichiers est complet ; **aucun pourcentage de couverture de lignes ou de branches n’a été mesuré**. Cette campagne ne certifie ni le produit entier, ni un déploiement, ni les services réels en production.

La campagne globale précédente (`full-karta`) reste également non concluante : le reçu consigne un code **-9**, sans rapport JSON final. La campagne bornée apporte une preuve plus précise, mais ne remplace pas les résultats manquants par un succès.

**Action restante — responsable : agent parent / runner GitHub CI existant.** Exécuter le gate KARTA inchangé sur un runner distinct, puis vérifier sa sortie finale, l’inventaire exact, les états des assertions et l’absence d’erreurs non gérées. La qualification globale ne pourra passer à PASS qu’avec ces preuves.
