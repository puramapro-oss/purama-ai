# Planificateur des agents statiques — qualification du 10 novembre 2026

**PASS pour le correctif local décrit ci-dessous. Production NON TESTÉE.**

Base examinée : `1a49ad646b529c6fb95335105c8a4e5f28468d76` (PR36).
Le code de la PR34 relatif aux agents personnalisés reste inchangé. Le seul
fichier de production modifié par ce lot est `karta/src/scheduler/cron.ts`.

## Défauts reproduits et correction

La lecture des utilisateurs actifs précédait le calcul du créneau de déduplication.
Une lecture retardée pouvait ainsi déplacer la clé de `12:00` à `12:01` pour le
même événement programmé. Le créneau est maintenant figé depuis
`TaskContext.date`, avant toute attente, en conservant le format des identités
BullMQ existantes et les seize cadences statiques.

L'arrêt d'un timer node-cron n'interrompait pas son callback déjà commencé. Une
lecture ou une mise en file tardive pouvait donc lancer une nouvelle soumission
après l'arrêt. Les contrôleurs de shutdown invalident désormais les callbacks
avant de détruire les timers, et la boucle recontrôle cette invalidation avant
chaque utilisateur. Les contrôleurs retirés ne permettent pas de redémarrage.

Le callback retournait `undefined` alors que le travail asynchrone continuait.
Il attend maintenant la promesse du travail, pour que node-cron observe sa
fin effective. Les journaux du scheduler ne recopient plus les détails d'erreur
fournisseur. Les rejets synchrones ou asynchrones de destruction sont capturés.

## Vérifications réellement exécutées

| Contrôle | Résultat | Preuve |
| --- | --- | --- |
| Contre-épreuve sur source initiale, timers contrôlés | 5 FAIL / 1 PASS | `baseline.json`, `baseline.log`, `baseline-command.json` |
| Contre-épreuve sur source initiale, vrai node-cron | 3 FAIL | `baseline-real-cron.json`, `baseline-real-cron.log`, `baseline-real-cron-command.json` |
| Nouvelles suites seules après correction | 9/9 PASS | Reprises incluses dans la campagne suivante |
| Deux suites nouvelles et sept fichiers voisins | 108/108 PASS, aucun ignoré, neuf fichiers | `final-targeted.json`, `final-targeted.log` |
| Typage KARTA | PASS, exit 0 | `typecheck.log`, `final-receipt.json` |
| Compilation initiale | Interrompue, exit 137 | `build.log`, `final-receipt.json` |
| Compilation reprise, heap plafonné à 256 Mio | PASS, exit 0, source identique | `build-retry.log`, `build-retry-command.json` |

Les neuf nouveaux tests font partie des 108, ils ne s'y ajoutent pas. Les deux
familles de contre-épreuves se recouvrent fonctionnellement et ne représentent
pas huit défauts distincts. La cause précise du SIGKILL initial n'est pas établie.
Aucune source, assertion ou dépendance n'a été changée pour faire passer la
reprise de compilation.

Environnement : Node 24.22.1, npm 11.9.0, node-cron 4.6.0. Les trois cas du
second fichier exécutent la bibliothèque node-cron installée avec une horloge
contrôlée. Les lectures de base, mises en file et rapports utilisent des doubles
inertes. Un test voisin historique (`agentsRegistry`) tente une connexion Redis
locale refusée sur `127.0.0.1:6379` ; le journal la conserve.

## Impact et provenance

`query` et les deux analyses `impact` ont réussi avant modification. Elles lisent
l'index `iao-resume-cb46` sur `90d8f30`, sans le modifier. Les empreintes de
`cron.ts`, de son appelant `karta/src/index.ts` et de `agents/index.ts` correspondent
exactement à la base courante : `impact-index-identity.json`.

- `startSchedulers` : LOW, un appelant direct (`karta/src/index.ts`).
- `runScheduledCycle` : LOW, `startSchedulers` direct et `index.ts` indirect.
- Aucun processus supplémentaire n'est résolu par ce graphe ; les callbacks et
  les opérations externes restent vérifiés par lecture et par les tests.

Les commandes et sorties sont conservées dans `impact-commands.json` et les
trois fichiers `query.log`, `impact-start.log`, `impact-cycle.log`. La détection
finale des changements et la qualification globale appartiennent au lot
d'assemblage parent ; ce reçu ne prétend pas les avoir exécutées.

SHA-256 du source corrigé :
`bb4ab70ae63aa4f4a300e1626140c7d92cba10698e878c5a062c49181416cd4f`.
Les empreintes des deux tests, du manifeste et du lockfile sont dans
`final-receipt.json`. Les dépendances n'ont pas été modifiées.

## Portée et limites

L'arrêt empêche de commencer la soumission suivante. Il ne retire pas une
soumission Redis déjà commencée, ni un travail déjà accepté. Un rapport quotidien
déjà lancé n'est pas interrompu par cette modification. Les délais des requêtes
de base, leur pagination et la déduplication propre du rapport restent des
périmètres distincts ; cette modification ne leur attribue pas de garantie.

Les appels Supabase/Redis réels, l'exploitation avec plusieurs processus,
la charge, les fournisseurs et la production n'ont pas été testés. Aucune
campagne, notification, dépense ou migration distante n'a été exécutée.

## Références officielles consultées

- [Contexte des événements node-cron](https://www.nodecron.com/event-listening.html) :
  distinction entre instant programmé et instant effectif du déclenchement.
- [Cycle de vie node-cron](https://www.nodecron.com/task-lifecycle.html) :
  l'arrêt d'une tâche inline laisse finir le travail en cours ; la destruction
  retire le timer du registre.
- [API node-cron](https://www.nodecron.com/api-reference.html) :
  callback asynchrone et types des contrôles du timer.

Ces propriétés ont aussi été vérifiées dans la version 4.6.0 installée ; aucune
nouvelle fonctionnalité du fournisseur n'a été introduite.
