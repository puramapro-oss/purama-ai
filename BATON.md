# Reprise T03 IAO

## T03 IAO — transport local annulable (2026-10-14)

- Base : `108291708a3d6858d26519704eb793d29b67cee6`, worktree isole `t03-iao-local-transport-20261014`, branche `codex/t03-iao-local-transport-20261014`.
- Lot inedit identifie : signal KARTA ignore par le transport HTTP Unix Compute Fabric ; aucun chevauchement produit avec le lot SMARANA `3941b7e`.
- Reproduction conservee : `docs/iao/t03-local-transport-20261014/red.txt`, 5 echecs / 12 tests sur le produit de base.
- Correction : signal natif HTTP + rejet avant dispatch + erreur d'annulation expurgee ; sockets fermees, effets toujours incertains apres envoi.
- Validation finale : 15/15 tests cibles PASS ; gate KARTA 399/399 PASS (31 fichiers, 0 skip), typecheck, lint cible et build exit 0. Commandes et SHA-256 testes : `docs/iao/t03-local-transport-20261014/evidence.json`. Aucun provider/secret/DB reel utilise.
- Impact produit avant edition LOW ; detect-changes staged HIGH (7 flux), sortie structuree MEDIUM (5) : collisions d identifiant vide documentees. Alerte examinee, graphe global UNKNOWN ; revue directe du scope et gate KARTA vertes. Voir rapport et preuves GitNexus.
- Livraison : commit local `[CODEX] IAO: cancel local compute transport` ; retrouver le SHA par `git log -1 --format=%H -- docs/iao/t03-local-transport-20261014/RAPPORT.md`. Rapport : `docs/iao/t03-local-transport-20261014/RAPPORT.md`.

Prochaine etape externe : revue du commit pour integration sur une tete canonique choisie, puis qualification separee du daemon. Fermeture socket verifiee ; arret du calcul, idempotence durable et budget reel UNVERIFIED. Aucune integration ni activation autorisee par ce rapport. Ne pas rejouer les preuves inchangees.

## T03 IAO — finalisation protocole local v2 (2026-10-14)

- Reprise confirmée sur `a5cbbcf80b058798f93b2e4ce4a1f9dcfd716e82` ; le défaut rouge était l'acceptation d'une réponse daemon sans attestation locale, plafonds ni preuve d'absence de fallback payant.
- Correctif : requête `protocol_version=2`, politique `local_only`/`forbidden`, reçu strict lié à la clé, au digest et aux plafonds. Toute divergence échoue fermé.
- Validation : 29/29 tests ciblés puis gate KARTA 404/404 PASS (31 fichiers, 0 skip), typecheck, lint ciblé et build verts. Le calcul d'un daemon fixture s'arrête à la déconnexion ; l'arrêt du daemon réel, sa déduplication durable et son routage interne restent `UNKNOWN`.
- Procédure réversible : `docs/iao/t03-local-transport-20261014/INTEGRATION-REVERSIBLE.md`. Ne pas injecter le runtime tant que la qualification daemon et l'intégration réelle manquent.

## T03 IAO — clôture (2026-10-14)

- Reprise propre sur `0b7d08707611479f444fc860e89828c953180eda`; aucun nouveau défaut produit démontré, donc aucun changement de `localComputeFabricProvider.ts`.
- Compatibilité locale IAO/KARTA/port SMARANA vérifiée ; non-interférence AKASHA et frontières de permission VAJRA revues. Les raccords SMARANA, AKASHA, VAJRA et daemon réels restent `UNKNOWN`.
- Validation fraîche : ciblé 69/69, KARTA 404/404, typecheck, lint ciblé et build verts. Preuves `docs/iao/t03-local-transport-20261014/closure-*`.
- GitNexus isolé : anciennes associations étrangères de `protocol_version` non reproduites ; trois candidats seulement dans l'adaptateur, mais impact propriété et graphe global `UNKNOWN` (index tronqué). Compare base LOW / 0 processus affecté, sans certificat global.
- Intégration réversible documentée avec l'ordre exact `a5cbbcf` puis `0b7d087`; aucun push, merge, déploiement ou daemon réel.

## T03 IAO — remise T01 fail-closed (2026-10-27)

- HEAD produit repris propre à `1c18c1d7a98c9bdfaf094a71814db163ec55c2f2`, arbre `38e0521fdfac425e61c44b12bce55d01c1b9a63d`; contrats et ACK T03/T04/T06 réconciliés dans l'ordre `T04 -> T03 -> T06`.
- Preuves fraîches sans delta produit : T03 ciblé 69/69 PASS ; contrat SSE T06 2/2 PASS. Ces résultats restent des preuves sur fixtures/ports injectés.
- Candidat T01, WIP T04 et fichiers propriétaires préservés. Aucun second cerveau/transport, aucun appel au service Ollama étranger.
- Verdict réel : `BLOCKED / READY=NO`. `ACK_T03_T04_CURRENT_RUNTIME_ADAPTER=NO_SHA_AVAILABLE`, correction SMARANA `source_object_ids` absente, ACK T02 d'usage du processus Homebrew absent et T07 non acquis.
- Remise détaillée : `docs/iao/t03-local-transport-20261014/HANDOFF-T01-20261027.md`. Conversation, streaming, annulation, erreurs, reprise et absence de fallback payant sur Ollama réel restent `NOT_TESTED_AUTHORITY`.
- GitNexus `detect-changes` tenté avant commit : `UNKNOWN` pour incompatibilité d'index partagé (stockage 43, runtime 42) ; revue Git directe limitée à trois fichiers documentaires, aucun symbole produit.

## T03 IAO — delta raccordement fail-closed (2026-10-27)

- Autorité T02 actualisée : usage borné du daemon Ollama existant autorisé, mais
  interdiction cloud durable seulement `PARTIAL` (`OLLAMA_NO_CLOUD` absent) ;
  aucun appel T03 avant admission.
- T04 reste non livré : correctif `source_object_ids` en WIP à
  `04b62c70a1abbe0f6dee9856a969dd39457180e6`, VM PostgreSQL `PARTIAL`, gates
  mémoire réelles `NOT_TESTED_ENV`, aucun commit/ACK de réception.
- T01 reste non admissible à
  `40721466724e8a3dd703a433f2c21a09cdaad954`, merge WIP préservé.
- Aucun delta produit ni appel Ollama. Conversation/SSE/annulation/reprise/
  erreurs/permissions/mémoire/fallback E2E restent `NOT_TESTED_PRECONDITION`.
- Handoff différentiel :
  `docs/iao/t03-local-transport-20261014/HANDOFF-T01-RACCORDEMENT-20261027.md`.

## T03 IAO — préparation adaptateur T03/T04 sans intégration (2026-10-27)

- Préconditions toujours absentes : aucun SHA T04 validé et aucun candidat T01
  admis ; édition produit et recette Ollama restent interdites.
- Deux commits historiques propriétaires retrouvés :
  `45e8dc13b3f74af71575fc838cd04aab2d4cc100` et
  `3941b7ef984d7f016034df68ade46d1e8130c6b2`. Ne pas les cherry-pick en bloc :
  leur adaptateur de complétion via `smarana.ask()` ferait doublon avec le
  transport Compute Fabric v2 et ne satisfait pas le verrou zéro fallback.
- Cible préparée : un seul adaptateur mémoire `SmaranaIaoPort` contre les exports
  publics du SHA T04 final ; `LocalComputeFabricProvider` reste l'unique port de
  complétion. Aucun delta produit, service, base ou moteur utilisé.
- Les 69/69 T03 et 2/2 T06 historiques du même jour sont conservés sans replay.
  Toutes les recettes réelles restent `NOT_TESTED_PRECONDITION`.
- Gate documentaire : `git diff --check` PASS et politique canonique
  `POLICY_OK`. `gitnexus detect-changes --scope all --repo purama-master` tenté
  avant commit : `UNKNOWN`, index stockage 43 incompatible avec le runtime 42 ;
  aucun symbole produit n'est modifié et aucun rebuild d'index n'a été lancé.
- Handoff borné T01/T06/T08 :
  `docs/iao/t03-local-transport-20261014/HANDOFF-T01-T06-T08-PREPARATION-RUNTIME-20261027.md`.
