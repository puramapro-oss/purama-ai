# T03 -> T01 — raccordement IAO/KARTA, état différentiel 2026-10-27

## Verdict

`BLOCKED_PRECONDITIONS / READY=NO / NO_RUNTIME_ADAPTER_SHA`

Ce handoff remplace uniquement l'état de coordination devenu obsolète dans
`HANDOFF-T01-20261027.md`. Il ne remplace aucun commit produit T03 et ne vaut ni
ACK d'intégration, ni admission du candidat T01.

Le raccordement runtime demandé n'a pas été commencé : la livraison T04 validée
et l'admission du candidat T01, explicitement requises avant cette étape, sont
toutes deux absentes. Aucun second cerveau, routeur, transport, backend, store,
worker ou daemon n'a été créé.

## T03 repris sans doublon

- Worktree : `.worktrees/t03-iao-local-transport-20261014`.
- Branche : `codex/t03-iao-local-transport-20261014`.
- HEAD documentaire avant cette remise :
  `24adf611db56e4268ee1344f807220dedb60418f`.
- Commits produit à réutiliser, dans l'ordre :
  `a5cbbcf80b058798f93b2e4ce4a1f9dcfd716e82`, puis
  `0b7d08707611479f444fc860e89828c953180eda`.
- Le provider existant reste le transport Unix Compute Fabric v2. Il ne parle
  pas directement HTTP à Ollama ; ajouter un client Ollama ici créerait un
  second transport et chevaucherait T02.
- Adaptateur runtime T03/T04 courant :
  `ACK_T03_T04_CURRENT_RUNTIME_ADAPTER=NO_SHA_AVAILABLE`.

## Delta d'autorité vérifié

### T02 / Ollama

`ACK_T02_EXISTING_HOMEBREW_OLLAMA_USE=YES` autorise désormais l'usage borné de
l'instance existante sur `127.0.0.1:11434`, sans droit de démarrage, arrêt,
redémarrage ou téléchargement. T02 a observé une génération locale et uniquement
des sockets loopback pendant sa recette.

Cette preuve reste `PARTIAL` pour l'interdiction durable de cloud : le service
actif ne porte pas `OLLAMA_NO_CLOUD=1`. Elle n'autorise pas T03 à appeler le
moteur avant les préconditions de composition ci-dessous.

### T04 / SMARANA-AKASHA

Le correctif `source_object_ids` est présent uniquement comme WIP étranger dans
`.worktrees/t04-smarana-source-object-ids-20261027`, encore à la base
`04b62c70a1abbe0f6dee9856a969dd39457180e6`. Aucun SHA candidat n'existe.

Les gates statiques T04 rapportées (`check`, `build`, `diff --check`) sont
vertes, mais les preuves PostgreSQL réelles exigées restent non exécutées. La VM
Linux privée `purama-t04-pg` et sa base ont été créées, mais cet environnement
est seulement `PARTIAL`, hors identité littérale du claim initial et sans
approbation de raccordement, migrations ni tests SMARANA. En particulier :

- update avec provenance non NULL : `NOT_TESTED_ENV` ;
- fermeture/réouverture puis purge : `NOT_TESTED_ENV` ;
- rollback, isolation tenant et legacy NULL : `NOT_TESTED_ENV` ;
- `PURGE_AFTER_UPDATE` : `NOT_TESTED_ENV` ;
- commit/release/ACK de réception T04 : absents.

Le WIP T04 et ses bases ont été laissés intacts.

### T01 / admission

Le candidat reste au checkpoint non admissible
`40721466724e8a3dd703a433f2c21a09cdaad954`, arbre
`c1c7997ddaf279ff0602adb7e412b1ee05d991fc`, avec
`MERGE_HEAD=108291708a3d6858d26519704eb793d29b67cee6` et de nombreux fichiers
étrangers modifiés/non suivis. Il n'existe aucun SHA final admis.

L'ordre propriétaire reste `T04 -> T03 -> T06`. T03 ne peut donc pas fabriquer
le SHA d'adaptateur attendu en sautant T04 ou T01.

## Tests et portée de preuve

Les preuves T03 du 2026-10-27 sur le même produit inchangé restent :

```text
npm test -- --run test/iao-facade.test.ts test/localComputeFabricProvider.test.ts test/localComputeFabricCancellation.test.ts
PASS — 3 fichiers, 69/69 tests
```

Elles couvrent les contrats sur fixtures et ports injectés, pas le moteur réel.
Le test T06 `test/iao-stream.test.ts` reste `PASS — 2/2` sur port injecté.

Faute de livraison T04 validée et de candidat T01 admis, aucune nouvelle recette
Ollama n'a été exécutée par T03. Statuts exacts :

| Critère | Statut T03 | Motif |
|---|---|---|
| Conversation réelle | `NOT_TESTED_PRECONDITION` | T04 non livré, T01 non admis |
| Streaming HTTP/SSE réel | `NOT_TESTED_PRECONDITION` | aucun adaptateur composé sous SHA |
| Annulation réelle | `NOT_TESTED_PRECONDITION` | aucun appel moteur autorisé à ce stade |
| Reprise/déduplication réelle | `NOT_TESTED_PRECONDITION` | mémoire validée absente |
| Erreurs moteur/connexion | `NOT_TESTED_PRECONDITION` | candidat non admis |
| Permissions KARTA | `NOT_TESTED_PRECONDITION` | composition finale absente |
| Mémoire SMARANA/AKASHA | `BLOCKED_T04` | purge après update non validée |
| Absence de fallback payant E2E | `NOT_TESTED_PRECONDITION` | T02 seulement borné, config durable PARTIAL |

## Séquence de reprise autorisée

1. T04 fait approuver l'environnement PostgreSQL privé, exécute les migrations
   et toutes les gates réelles, puis livre un commit propre et un ACK de
   réception sous SHA complet.
2. T01 compose et publie un candidat propre, exact et explicitement admis.
3. T03 complète uniquement l'adaptateur runtime manquant entre les ports déjà
   propriétaires, sans client Ollama, mémoire ou lifecycle concurrent.
4. Sur ce SHA exact, T03 exécute conversation, SSE, annulation, reprise,
   erreurs/connexion, permissions, mémoire validée et observation d'egress.
5. T06 reçoit le SHA final de composition ; T08 qualifie ensuite le même
   candidat de façon indépendante.

Aucun Ollama, service, base, secret, API payante, push, déploiement, reset,
stash, clean ou suppression n'a été utilisé par cette remise.
