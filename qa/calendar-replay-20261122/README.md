# Calendar — confirmation d'un événement après conflit 409

## Périmètre et résultat

Correction du défaut reproduit sur `e95e282251a4e0ea19bda69675e31ce2c4af4cae`
(arbre `f4168c9fb0e768fa83aeaecf84b7358f9d135173`). Périmètre validé et réservé :
`karta/src/tools/calendar.ts`, `karta/test/calendarTool.test.ts` et ce reçu.

**PASS local :** après un POST 409, le GET ne confirme plus un événement simplement
parce qu'il répond HTTP 200. Le reçu doit correspondre à l'identifiant déterministe,
au titre, aux instants de début et de fin, au fuseau demandé et aux participants.
Un événement annulé, provisoire, déplacé, devenu récurrent, incomplet ou divergent
reste non confirmé. Aucun événement de remplacement ni nouvel identifiant n'est créé.

Les représentations UTC équivalentes, le statut confirmé par défaut et les alias IANA
reconnus par `Intl` restent acceptés. L'organisateur peut apparaître séparément dans
les participants uniquement si les champs `organizer`/`self` et son adresse concordent
avec le propriétaire du calendrier. Les alias d'adresse non prouvés ne sont pas déduits.

## Preuves exécutées le 22 novembre 2026

Répertoire des commandes de test : `karta/`. Les appels Calendar/OAuth sont interceptés ;
le setup bloque les requêtes `fetch` non simulées et remplace les identifiants réels.

| Contrôle | Commande / preuve | Résultat |
| --- | --- | --- |
| Reproduction avant correction produit | `vitest run test/calendarTool.test.ts` ; premier lot de 45 tests | 19 réussites et **26 échecs attendus**, car la promesse était résolue à tort ; sortie 1 |
| Réconciliation, dates, OAuth | `vitest run test/calendarTool.test.ts test/calendarSchedule.test.ts test/googleCalendarConnection.test.ts` | **138/138 PASS**, sortie 0 : 61 + 41 + 36 |
| Types KARTA | `npm run typecheck` | **PASS**, sortie 0 |
| Revue indépendante | Lecture du diff et des contrats d'erreur du moteur | **PASS**, aucun défaut bloquant identifié |
| Reprises du moteur | `vitest run test/loop.test.ts test/approval.test.ts test/approvalContinuation.test.ts --maxWorkers=1 --no-file-parallelism` | **PARTIEL**, sortie 1 : 15 tests loop réussis ; 58 tests d'approbation non exécutés après SIGKILL des deux workers |
| Diff | `git diff --check` et revue des fichiers réservés | **PASS** |

Le contrôle des reprises a d'abord été interrompu avec deux workers, puis une seule
exécution séquentielle bornée a confirmé la limite. Le rapport JSON Vitest affiche
`success: true` malgré cette interruption : le code de sortie, les 58 cas `pending`
et les erreurs de workers priment ; le lot n'est **pas** qualifié PASS. Un refus de
connexion Redis locale apparaît également dans le log. Aucun service n'a été activé.

Preuves brutes de cette session :
`/workspace/scratch/529e43e3c136/calendar-replay-20261122/evidence/`.

- `reproduction.json` SHA-256 : `7a65af8fac43b5e3207caad09b678966a527119ba21d0df758eefd75fa54cb0a`
- `calendar-focused.json` SHA-256 : `a4b88bf6befd67befe36275f95618bbdb9ee3a94ce5016cdc887489dd305f093`
- `typecheck.log`, `retry-contract-serial.log` et `gitnexus-detect.log` conservent les autres sorties.

## Impact et limites

GitNexus a été interrogé avant modification sur l'index canonique `purama-ai`, sans
le renommer ni reconstruire : `impact(calendarCreateEventTool)` et `impact(execute)`
renvoient **UNKNOWN**, aucun lien résolu ; l'index a 15 commits de retard et signale
47 appels `execute` non typés. Une première invocation parallèle a été tuée ;
l'invocation bornée séquentielle a abouti. Ces résultats ne prouvent pas un impact nul.

`detect-changes --scope all --repo <clone isolé>` a été exécuté avant commit et a
échoué : le clone n'est pas indexé. **BLOQUÉ dans ce clone** ; le responsable de
composition reprend cette vérification avec l'index canonique avant publication.
La revue manuelle borne le changement au chemin 409 du tool Calendar partagé par
le planificateur d'appels et la réservation intelligente.

La voie de création POST réussie et les protections OAuth/dates précédentes restent
hors changement. Un fuseau attendu omis ou un reçu ne donnant pas d'instant explicite
est non confirmé, sans prétendre que l'événement a nécessairement été déplacé.
Le moteur existant arrête les reprises automatiques après une exception du tool ;
ce patch ne promet pas une déduplication globale entre de nouvelles missions distinctes.
Il ne confirme ni participation humaine, ni consentement téléphonique, ni appel effectué.
Google réel, téléphonie et disponibilité continue : **NON TESTÉS**.

## Contrat officiel consulté

- [Ressource Events](https://developers.google.com/workspace/calendar/api/v3/reference/events) : statuts, événements supprimés renvoyés par GET, instants/fuseaux, participants omis et organisateur.
- [Events.get](https://developers.google.com/workspace/calendar/api/v3/reference/events/get) : événement obtenu par son identifiant et représentation des horaires.
- [Events.insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert) : identifiant client et champs de l'événement créé.
