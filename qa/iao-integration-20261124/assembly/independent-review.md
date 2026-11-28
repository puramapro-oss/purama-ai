# Revue indépendante — projection mémoire et DreamForge

**Verdict : PASS dans le périmètre logiciel décrit ; aucun défaut bloquant identifié.**

Relecteur : `/root/iao_runtime_review`. Date UTC : 2026-11-24T01:32:25.141546+00:00.
Revue de lecture et d’exécution ; aucune commande Git, aucune édition produit. Ce reçu est le seul fichier écrit par cette tâche. Le correctif séparé `terminalAt` / `isTerminal` de la façade reste sous la responsabilité de l’agent coverage et n’est pas couvert par ce verdict.

## Projection mémoire

Le fichier antérieur de `iao-current` correspond exactement au hash de base du reçu mémoire. La comparaison complète avec le candidat limite la modification produit à `buildMemoryPrompt`. GitNexus `context buildMemoryPrompt --repo iao-integration-karta-20261124` confirme le chemin `LocalComputeFabricProvider.complete` et les tests concernés ; index ciblé KARTA, FTS indisponible.

- **Non-divulgation : PASS.** Filtre strict `authorized === true` et `sensitivity === "normal"` inchangé. La notice de contenu incomplet ne dépend que des sources éligibles. Ajouter une source interdite, personnelle, financière ou santé ne modifie pas le prompt ; testé avec budget nul et non nul. Les caractères `<` sont échappés dans les deux charges JSON ; les délimiteurs fournis par le contenu ne deviennent pas des frontières externes. Le texte décodé est conservé.
- **Budget et Unicode : PASS.** Le total des extraits reste dans le budget de texte existant en unités UTF-16 ; un couple de substituts complet n’est plus coupé. Les cas zéro, épuisement, ajustement exact et réemploi d’une unité restante passent. Il ne s’agit pas d’un budget de tokens ou de l’enveloppe JSON complète ; les graphèmes composés ne sont pas garantis indivisibles.
- **Validation intégrale : PASS.** `memorySources` parcourt et valide tout le paquet avant filtrage, tri ou troncature. Les sources malformées tardives, accesseurs, proxys, itérateurs, tableaux creux et autorisations non booléennes restent refusés sans exécuter leurs comportements.
- **Politique : PASS.** Tri de pertinence, bornes du message, RPC/2 `kind: memory`, `local_only`, refus du repli payant, corrélation/digest et admission des ressources inchangés. Le message utilisateur devient une chaîne JSON documentée ; sa qualité d’interprétation par un modèle réel n’est pas mesurée par ces tests.

Exécution indépendante depuis `karta/` :

```text
./node_modules/.bin/vitest run test/localComputeFabricMemoryProjection.test.ts test/localComputeFabricMemoryBoundary.test.ts --maxWorkers=1 --reporter=verbose
Exit 0 — 2 fichiers, 54 tests PASS : 14 nouveaux + 40 tests de frontière existants.
Durée : 669 ms.
```

Le transport du test de projection est explicitement simulé en processus. Ce résultat ne qualifie ni un socket Unix natif, ni un démon, ni un modèle réel.

## DreamForge

Lecture du patch `evidence/host-chat-20261124/changes.patch`, du panneau complet, des appels de commit/lifecycle de l’application et du pont v1. Les contrôles suivants sont cohérents avec leurs assertions exécutées :

- **Corrélation : PASS.** `applyProposal` exige l’identifiant exact. Un ancien identifiant ou un retour muté ne consomme pas une nouvelle proposition ; le panneau conserve seulement la chaîne d’identifiant et le pont possède sa scène détachée. Consommation avant commit, résultat observé et révision contrôlée évitent une double application ou un succès inventé.
- **Réentrance et anciens handles : PASS.** Garde de génération avant et après l’admission hôte ; garde avant publication d’un ancien état après annulation/invalidation. Les réponses tardives, remplacements A-B-A, changements tenant/session/projet/révision et demandes réentrantes ne remplacent pas le nouveau contexte.
- **Arrêt : PASS.** Annulation/invalidation ferment la demande courante et invalident les retours tardifs. L’annulation ne défait pas une édition acquise et ne prouve pas l’arrêt physique du fournisseur distant. Suspension et démontage empêchent une nouvelle admission.
- **Historique commun : PASS.** Proposition conversation, édition manuelle et AR logicielle passent par le même commit et les mêmes undo/redo ; projet et IDs d’objet restent cohérents. La pose AR reste séparée du document. Une frame absente retire un réticule non placé sans détruire une scène placée.

Exécution indépendante depuis `PURAMA_DreamForge/studio/` :

```text
node --test tests/app-lifecycle.test.mjs tests/app-ar.test.mjs tests/iao-bridge.test.mjs tests/host-lifecycle.test.mjs tests/host-lifecycle-cleanup.test.mjs
Exit 0 — 115 tests PASS, 0 échec, 0 annulé, 0 ignoré.
Durée : 3830,271636 ms.
```

**Quatre scénarios adverses supplémentaires PASS**, exécutés par `node --input-type=module` sur les vrais modules avec le helper DOM synthétique existant, sans créer de test produit : démontage/remontage réentrant dans `readBinding` pendant chacun des trois appels `propose`, `applyProposal`, `cancelProposal` ; puis remplacement dont l’observateur d’abort lance une proposition imbriquée. Les trois anciennes admissions retournent `closed` sans toucher la nouvelle proposition. Dans le quatrième cas, l’appel externe retourne `superseded` sans dispatch ; la demande imbriquée la plus récente reste applicable.

Verdict transmis à l’agent AR avant gel du paquet. Ces répétitions indépendantes ne s’ajoutent pas au compteur de 277 tests de sa suite générale. Les sorties ont été observées directement ; ce reçu conserve commandes et résultats, pas un nouveau journal complet.

## Sources vérifiées et limites

```text
Base mémoire SHA256 : 46ad324197ea8d1456767571904f916e7f92970e1b9511ada74a5c9948ab53b1
Candidat mémoire SHA256 : 6106e335c105bb2b3f912c01a781289baf50bda60f8441501a5ef0a3d6a3556f
Suite projection SHA256 : dc5d7f94da82f97f93c66ecd5b6d013a51e253b53e961559862d30f3d1cac2ea
Patch DreamForge SHA256 : d06eb29e0a4f07e8878dade55c6d3c5d50082b4924c3eaeb65fcb64bc52d6ce0
DreamForge app.mjs SHA256 : 63348cd220743a09dde4585bae7892a98a3474165cc6e6ed648682fb987cf654
DreamForge proposal-panel.mjs SHA256 : 0af6c55d53d1daa12432706a1534c63b6b5eeafbda3c30f28ed105aea53144ad
DreamForge iao-bridge.mjs SHA256 : 2a057a0ca3e277f7be76e66cac0c94bda7104573ca61d2f64646be47763de927
DreamForge host-lifecycle.mjs SHA256 : 5d93f587a6e483a11855e48bcb2d2d97b5418784d6af63c829fec3e56689b474
```

**NON TESTÉ par cette revue :** compte et autorité ONE réels, SMARANA et modèle de production, résistance sémantique exhaustive aux injections, caméra/vision et AR physique, sauvegarde serveur, synchronisation entre appareils, performance/coût du modèle, artefacts build/ZIP. Ces éléments restent distincts de la validation locale des deux lots. Aucun blocage logiciel nouveau n’a été observé dans le périmètre revu.
