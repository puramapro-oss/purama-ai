# Admission cumulée des budgets CHEF — 10 novembre 2026

## Résultat vérifié

**PASS : 18 tests dédiés sur les vraies migrations PostgreSQL exécutées dans PGlite.**

La même assertion échoue sur les migrations historiques 008–017 : deux tâches estimées à 70 sont prises avant le retour de leur consommation, malgré un budget commun de 100. Avec la migration additive 021, la seconde attend. Les journaux `mac-baseline.txt` et `mac-budget.txt` conservent les résultats avant et après.

La validation finale de ce sous-lot a été effectuée sur un worktree Mac isolé, issu exactement de `1daf6314d60f6dd336c3a3601ddf73cf432ef4b3`, avec les mêmes fichiers transférés et vérifiés par SHA-256. Les premières exécutions dans le conteneur partagé n'ont pas produit d'assertions exploitables : un worker n'a pas démarré, puis un autre a été tué par SIGKILL. Ces exécutions ne sont pas comptées comme des validations du produit.

## Comportement

La prise d'une tâche verrouille la mission puis additionne la consommation déjà enregistrée, les estimations des tâches `claimed`, `running` et `verifying`, et l'estimation de la candidate. Les limites de tokens et de coût sont vérifiées séparément. Une estimation absente n'est jamais assimilée à zéro lorsque sa dimension est plafonnée. Un zéro explicite reste autorisé.

Une réservation temporaire ne met pas la mission en pause : une tâche moins coûteuse peut avancer et la capacité est réévaluée après la fin des tâches actives. Une tâche admissible confiée à un autre fournisseur ne se trouve pas bloquée par une tâche plus chère. Les restrictions existantes de session, dépôt, worktree, scope, tentatives et nombre de travailleurs sont conservées.

Les additions utilisent le type numérique PostgreSQL pour éviter un débordement de `bigint` pendant la comparaison. Le RPC reste réservé au rôle serveur. L'application répétée de la migration conserve les prises existantes.

## Limites exactes

Il s'agit d'un contrôle d'admission fondé sur des estimations, pas d'un plafond garanti des factures API. L'estimation entière reste réservée pendant une tentative active, même si une partie de sa consommation a déjà été comptée. Ce conservatisme évite de soustraire par erreur une consommation appartenant à une tentative antérieure ; il peut temporairement réduire le parallélisme.

Une dépense réelle plus élevée que l'estimation, un reçu d'usage absent ou une action fournisseur dont l'issue est inconnue exigent encore un plafond fournisseur et un rapprochement. La migration 021 ne prouve pas à elle seule l'arrêt d'un processus après expiration de sa lease ; la quarantaine de processus relève du sous-lot CHEF suivant.

PGlite utilise un seul backend. Les tests reproduisent plusieurs prises avant l'enregistrement de la consommation et exécutent le vrai SQL ; ils ne remplacent pas une validation de charge sur plusieurs connexions PostgreSQL natives.

La migration 022 transmet ensuite les estimations depuis le brief canonique jusqu'à l'insertion SQL. Elle conserve le hash des briefs historiques sans estimations. Aucune estimation n'est inventée pour les anciennes missions plafonnées.

## Analyse d'impact

GitNexus a été interrogé avant l'édition. La fonction SQL n'étant pas reliée dans le graphe, le fichier 010 a été signalé UNKNOWN ; une recherche et la lecture des migrations ont confirmé qu'il contenait la dernière définition de `chef_claim_next_task`. Le symbole TypeScript `SupabaseChefControlPlane.claimNext` est LOW, avec cinq éléments impactés : un appel direct depuis `runChefWorkerCycle`, les tests du superviseur et des preuves Git, puis `worker-main.main`. L'impact sur le lancement des missions a été communiqué avant l'édition.

## Reproduction

Depuis `karta/` :

```sh
CHEF_BUDGET_BASELINE=1 node node_modules/vitest/vitest.mjs run test/chefBudgetAdmission.test.ts --maxWorkers=1 -t 'reserves 70'
node node_modules/vitest/vitest.mjs run test/chefBudgetAdmission.test.ts --maxWorkers=1 --reporter=verbose
```

La première commande doit échouer sur l'assertion d'admission de la seconde tâche ; la seconde doit réussir avec 18 tests.

**NON TESTÉ : application des migrations sur une base distante et dépense réelle d'un fournisseur.**
