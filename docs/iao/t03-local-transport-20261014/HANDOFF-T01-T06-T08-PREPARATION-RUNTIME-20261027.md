# T03 — préparation bornée de l'adaptateur runtime T03/T04

## Verdict

`PREPARED_NOT_INTEGRATED / BLOCKED_T04_SHA_AND_T01_ADMISSION / READY=NO`

Ce document prépare le delta restant sans l'intégrer. Il ne vaut ni ACK T04, ni
admission T01, ni validation T06/T08. Au contrôle du 2026-10-27, T04 n'a pas
livré de SHA validé et le candidat T01 n'est pas admis. Conformément à l'ordre
propriétaire `T04 -> T03 -> T06`, aucun symbole produit n'a été modifié et aucun
appel Ollama n'a été effectué.

## Réutilisation obligatoire, sans doublon

Deux commits T03 plus anciens existent dans le worktree propriétaire
`purama-worktrees/claude7-karta-integration-20261005` :

- `45e8dc13b3f74af71575fc838cd04aab2d4cc100` — premier adaptateur
  `SmaranaIaoPort` et tests ;
- `3941b7ef984d7f016034df68ade46d1e8130c6b2` — propagation du signal
  d'annulation à l'ancienne surface `smarana.ask()`.

Ces commits ne sont ancêtres ni du HEAD T03 courant, ni du candidat T01. Ils ne
doivent pas être cherry-pickés en bloc :

1. leur `SmaranaContextAdapter` cible une ancienne API
   (`hasRevokedConsent`, `getMemory`, `getMemoryForExport`,
   `enqueueMemoryUpdate`) et un miroir local `smaranaPort.ts`, alors que le T04
   courant expose sa frontière KARTA depuis la racine du paquet ;
2. leur `SmaranaCompletionAdapter` fait calculer la réponse par
   `smarana.ask()`. Il est désormais incompatible avec la séparation des
   responsabilités : SMARANA/AKASHA fournit la mémoire, tandis que
   `LocalComputeFabricProvider` reste l'unique `IaoCompletionPort` T03 ;
3. réintroduire cet adaptateur de complétion créerait un chemin fournisseur
   concurrent et ne garantirait pas l'absence de fallback payant.

La logique réutilisable se limite aux idées de mapping mémoire, aux reçus
déterministes et aux cas de tests. Toute ligne reprise devra être réévaluée
contre le SHA final T04, sans importer un fichier source frère et sans créer de
second store, routeur, backend, cerveau ou transport.

## Composition cible unique

Après livraison T04 et admission T01, le seul delta T03 autorisé est une
implémentation concrète de `SmaranaIaoPort` pour le
`KartaRuntimeIaoPort` existant :

```text
HTTP/SSE T06
  -> KARTA IAO facade / permissions
  -> KartaRuntimeIaoPort
       |-> adaptateur T03/T04 -> exports racine SMARANA/AKASHA validés
       `-> LocalComputeFabricProvider -> socket Compute Fabric v2 -> pont T02 -> Ollama actif
```

Contraintes de composition :

- importer uniquement la surface publique du paquet T04 livré ; ne pas recopier
  ses types, SQL, lifecycle ou politique dans KARTA ;
- utiliser les frontières T04 finales correspondant à
  `prepareAuthorizedKartaContext`, `commitKartaResult` et à la reprise opaque
  PostgreSQL si elles sont encore exportées sous le SHA validé ;
- dériver `tenantId`, `actorId` et la finalité côté serveur. Ne jamais faire
  confiance à une identité ou permission fournie par le corps HTTP ;
- vérifier les permissions KARTA avant lecture mémoire et avant dispatch vers
  le moteur ;
- conserver les clés d'idempotence et digests T03 existants. Un même identifiant
  avec un payload divergent doit échouer fermé ;
- exiger un reçu durable T04 avant de présenter une reprise comme réussie ;
- propager le même `AbortSignal` à la mémoire et au transport ;
- conserver `LocalComputeFabricProvider` et son protocole v2 strict :
  `locality=local_only`, `paid_fallback=forbidden`, reçu
  `paid_fallback_used=false` ;
- ne jamais appeler Ollama directement depuis T03. Le pont vers l'instance
  existante appartient au périmètre T02 et doit être livré/autorisé séparément ;
- retourner des erreurs publiques génériques, sans fuite de chemin, socket,
  configuration, identité ou donnée mémoire.

La surface T04 observée est encore du WIP étranger à
`04b62c70a1abbe0f6dee9856a969dd39457180e6`. Les noms ci-dessus sont donc des
points de contrôle, pas une autorisation de coder contre un état non livré.

## Gates avant toute édition produit

T03 ne commence l'adaptateur que lorsque les preuves suivantes existent toutes :

1. SHA complet T04 propre, validation PostgreSQL réelle et ACK de réception ;
2. export public T04 figé avec contrat mémoire, provenance, purge après update,
   isolation tenant, idempotence et reprise ;
3. SHA complet du candidat T01 propre et admission explicite ;
4. ACK T06 de la composition HTTP/SSE sur ce candidat ;
5. autorité T02 pour utiliser le pont Compute Fabric vers l'Ollama déjà actif,
   sans start/stop/restart/download ;
6. analyse d'impact GitNexus sur les symboles exacts avant édition. Toute alerte
   HIGH/CRITICAL arrête l'édition et est remontée avant modification.

## Recette réelle à exécuter sur le SHA composé

Les commandes exactes dépendront du lanceur admis par T01/T02. Elles restent
`COMMAND_NOT_EXECUTABLE_YET`; inventer un endpoint ou un token serait une fausse
preuve. La matrice suivante est obligatoire sur le même SHA et avec le vrai
moteur local :

| Gate | Preuve PASS attendue |
|---|---|
| Conversation | réponse du modèle local, reçu v2 corrélé au request id et au digest |
| Streaming HTTP/SSE | ordre `status` puis résultat/erreur, fermeture propre et aucun flux après terminal |
| Annulation | client interrompu, signal propagé, socket fermé, effet déclaré `uncertain` après dispatch |
| Reprise | même requête rejouée après redémarrage sans second effet ; divergence de payload refusée |
| Erreur connexion | socket/pont/moteur indisponible -> erreur générique fail-closed, aucun fallback |
| Permissions KARTA | tenant/acteur non autorisé refusé avant mémoire et avant moteur |
| SMARANA/AKASHA | contexte autorisé seulement, provenance conservée, commit/purge/reprise validés |
| Zéro fallback payant | politique requête interdite + reçu `paid_fallback_used=false` + observation réseau bornée |

L'observation d'absence d'egress doit être bornée au processus/pont autorisé ;
elle ne peut pas être déduite du seul champ JSON du reçu. Aucun appel à une API
payante n'est permis pour cette recette.

## Preuves conservées, non rejouées

Le produit T03 est inchangé depuis les preuves fraîches du même jour :

```text
npm test -- --run test/iao-facade.test.ts test/localComputeFabricProvider.test.ts test/localComputeFabricCancellation.test.ts
PASS historique conservé — 3 fichiers, 69/69 tests

npm test -- --run test/iao-stream.test.ts
PASS historique T06 conservé — 2/2 tests sur port injecté
```

Ces preuves ne démontrent ni Ollama réel, ni PostgreSQL T04 réel, ni composition
T01. Elles n'ont pas été rejouées inutilement.

## Handoff

- **T01** : fournir le SHA admis et le point de composition unique ; ne pas
  intégrer les anciens commits T03 en bloc.
- **T06** : confirmer que la route SSE compose le même `KartaRuntimeIaoPort` et
  fournir l'ACK final après le SHA T03 ; le flux actuel est un flux de
  lifecycle/résultat, pas une preuve de tokens Ollama streamés.
- **T08** : qualifier indépendamment le SHA composé exact et conserver
  `NOT_TESTED` pour toute ligne sans moteur/mémoire réels.

État des recettes réelles à cette remise : conversation, SSE, annulation,
reprise, erreurs, permissions, mémoire et absence de fallback payant =
`NOT_TESTED_PRECONDITION`. Aucun runtime adapter SHA n'existe encore.

## Delta vérifié du 2026-10-28

L'avenant PostgreSQL Linux T04 n'est plus en attente d'approbation : le bloc
authentique `ACK_T04_PRIVATE_POSTGRES_LIMA_20261027=YES`, lié au SHA-256
`d124da1b0615252ded00a9b9ce3db73df161e757be1facae6df5a4dee7a4e669`, est
présent dans `LOCKS.md`, `.coord/LOCKS.md` et le claim T04. Cette autorisation
est strictement T04 et ne constitue ni livraison, ni admission, ni transfert de
chemin T03.

Contrôles frais en lecture seule :

```text
bash scripts/policy-check.sh
rc=0 — POLICY_OK

git -C .worktrees/t04-smarana-source-object-ids-20261027 rev-parse HEAD^{commit} HEAD^{tree}
rc=0 — 04b62c70a1abbe0f6dee9856a969dd39457180e6
       da4db843e13426e388946cce4cc80d4c6e9bc652

git -C .worktrees/t04-smarana-source-object-ids-20261027 status --short
rc=0 — sept entrées WIP, dont quatre sources/tests et trois états ; préservées

git -C .worktrees/t03-iao-local-transport-20261014 rev-parse HEAD^{commit} HEAD^{tree}
rc=0 — 7c2a322702d786d7618c94ef01a481d755d7160f
       e4516c11a0bf777d0c1203cffaacd2779c84fba4

git -C .worktrees/t03-iao-local-transport-20261014 status --short
rc=0 — vide avant ce delta documentaire

git -C .worktrees/t03-iao-local-transport-20261014 diff --check
rc=0 — PASS

node .gitnexus/run.cjs detect-changes --scope all --repo purama-master
rc=1 — UNKNOWN, cache npm externe possédé par root refusé avec EPERM ; aucun
       cache modifié, aucun symbole produit dans le delta documentaire
```

État de composition :

- T04 : `PARTIAL`, ACK d'exécution acquis mais SHA final et gates PostgreSQL
  métier absents ;
- T03 : `VERIFIED` pour la préparation documentaire seulement ; aucun symbole
  produit modifié et aucun adaptateur runtime livré ;
- T01 : `BLOCKED`, cible conditionnelle non créée et
  `ACK_T01_IAO_QA_ADMISSION=NO` ;
- T06 : `BLOCKED`, ACK final sur les SHA et chemins partagés non livré ;
- T02/Ollama : `PARTIAL`, configuration durcie préparée mais génération réelle
  non qualifiée sur le daemon partagé ; charger son label candidat créerait un
  second serveur, donc reste interdit ;
- conversation, streaming SSE, annulation, reprise, erreurs, permissions KARTA,
  mémoire SMARANA/AKASHA et absence runtime de fallback payant :
  `NOT_TESTED_PRECONDITION`.

Verdict de remise : `BLOCKED / READY=NO`. Prochaine transition admissible : T04
exécute les gates réelles autorisées et livre un commit propre ; T01/T06
réservent ensuite les chemins exacts et admettent la composition bornée. T03
pourra alors analyser l'impact GitNexus et implémenter le seul adaptateur mémoire
décrit ci-dessus, sans créer de second transport ni appeler Ollama directement.
