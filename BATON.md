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
