# T03 — IAO : annulation du transport local Compute Fabric

Date : 2026-10-14. Statut : **LOCAL_DELTA_VERIFIED**, intégration et service réel non qualifiés.

Base : `purama-ai@108291708a3d6858d26519704eb793d29b67cee6`.
Branche : `codex/t03-iao-local-transport-20261014`.
Worktree : `/Users/matissdornier/purama/.worktrees/t03-iao-local-transport-20261014`.
Le commit de livraison est celui qui ajoute ce rapport ; le retrouver par `git log -1 --format=%H -- docs/iao/t03-local-transport-20261014/RAPPORT.md`.

## Recherche du lot libre

Lecture préalable : AGENTS, politique globale, brief/plan/erreurs, contrats IAO, verrous racine et `.coord/LOCKS.md`, historiques et livraisons concernées. Contrôle initial : `POLICY_OK`. Espace initial : 29 Gio disponibles ; aucune installation, suppression ou copie de dépendances. Les dépendances existantes sont référencées par liens ignorés dans ce worktree ; Vitest utilise `--no-cache`. La lecture des processus via `ps` est interdite par le sandbox : la liberté du lot est établie par les verrous/handoffs et la comparaison de chemins, sans prétendre à une visibilité complète des processus.

La réservation `T03-IAO-LOCAL-TRANSPORT-20261014` couvre uniquement le fichier adaptateur, le nouveau fichier de tests et les preuves/documents de ce worktree. Les ajouts aux registres de coordination sont append-only. Les checkouts canoniques, les WIP et les dépôts réservés restent hors écriture produit.

| Ensemble | Exigence et constat actuel | Décision |
| --- | --- | --- |
| IAO / KARTA | `IAO_LIVE_EXPERIENCE.md:318-320,393-404` demande arrêt borné, annulation supportée et effet inconnu après interruption. Le contrat IAO révision 2 et `KartaRuntimeIaoPort.prepare()` transmettent déjà un signal ; `LocalComputeFabricProvider.complete()` le perd avant HTTP. | **Manque reproduit et traité ici** : la socket continuait après annulation ou délai KARTA expiré. |
| SMARANA | Le lot livré `3941b7ef984d7f016034df68ade46d1e8130c6b2` transmet déjà le signal à `smarana.ask()` et contient les adaptateurs contre le contrat T04. Les travaux coût/consentement/timeouts existent dans les livraisons T04, avec un WIP canonique protégé et une décision de lignée encore ouverte dans les handoffs. | Aucune seconde mémoire, copie de sources SMARANA, nouvelle gestion de coût ou nouvelle orchestration. Ce lot local ne dépend pas de leur intégration. |
| AKASHA | La spécification gouverne mémoire/contexte/vérité et exige reprise sans duplication. Le registre `.coord/LOCKS.md` réserve toujours le ledger d'export restart-safe de `final16-t03-akasha-ai` et l'ancien dossier FINAL16 T03. | Dépôt et ancien handoff intouchés ; pas de ledger concurrent. |
| VAJRA / permissions | `CONTRACTS-COMMUNS.md:7,80` réserve le confinement des outils et interdit qu'une donnée accorde des droits. Les routes IAO utilisent l'identité serveur ; la mémoire est filtrée selon autorisation/sensibilité dans l'adaptateur. | Réutilisation des frontières existantes. Test du refus SMARANA avant HTTP et de l'annulation par un acteur étranger. Aucun nouveau broker ; intégration VAJRA complète non certifiée. |
| Infrastructure Local OSS | Handoff `local-oss-cancellation/work-report.md` : annulation de groupe de processus déjà livrée en `9cdcec1d26fb60157683271b9a702e6948da085d`. Handoff `local-oss-resilience-next/work-report.md` : backoff borné livré en `613f64b5c8fd375cd7464d74c5be0896ab6d414e`. | Ne pas refaire ces capacités ni toucher au runner actif. La fermeture HTTP Unix ici est une autre frontière. |
| Compute Fabric réel | Le contrat exige une déduplication durable par clé+digest, et les spécifications exigent confinement/coût/arrêt réels. Une socket locale et une réponse de fixture ne démontrent pas ces propriétés du daemon. | Qualification du daemon, arrêt du calcul, budgets réels et absence de repli interne restent **UNVERIFIED** ; aucune activation dans cette livraison. |

Sources de conception également consultées : `DIRECTIVE-AKASHA.md`, `CODEX-DIRECTIVE-PURA-AKASHA.md`, `SMARANA-BRIEF.md`. Leurs empreintes sont dans `evidence.json`. Les rapports Local OSS sont sous `/Users/matissdornier/purama/.coord/handoffs/PURAMA-H200-CHEF-20261004/`. Les anciens résultats servent seulement à éviter les doublons ; ils n'ont pas été rejoués ni recertifiés.

L'historique de `localComputeFabricProvider.ts` sur toutes les références ne contient aucune correction du signal. La comparaison de ce fichier entre `1082917` et `3941b7e` est vide. Le lot SMARANA livré concerne d'autres fichiers : aucun chevauchement produit avec cette livraison.

## Parcours fonctionnel livré

`IaoFacade.submit` → `KartaRuntimeIaoPort.prepare` → contexte SMARANA autorisé → `LocalComputeFabricProvider.complete` → HTTP sur socket Unix. Le cancel de la façade ou l'expiration KARTA abortent le même signal, désormais transmis à `http.request`.

- Signal déjà annulé : rejet avant création d'une requête HTTP.
- Requête en cours, avant les headers ou pendant un flux : Node détruit la requête/socket ; le serveur de test constate la déconnexion.
- Succès, échec, interruption : le délai absolu est conservé et le listener natif est libéré à la fermeture. Le motif arbitraire d'`AbortSignal.reason` n'est jamais propagé ; l'erreur est `memory-unavailable:cancelled`.
- L'état KARTA demeure terminal après annulation. Un résultat tardif ne remplace pas le statut et la fermeture du transport ne transforme jamais `effect: uncertain` en preuve d'arrêt du calcul.
- Une reprise dans la même façade ne renvoie pas la requête annulée/bloquée. Après reconstruction de KARTA, la clé et le digest restent identiques ; la déduplication durable appartient toujours au daemon. Le test ne prétend pas démontrer une persistance après crash.
- Deux appels concurrents sur la même instance restent indépendants : annuler l'un ne coupe pas l'autre.

Le produit modifié se limite à `karta/src/integrations/localComputeFabricProvider.ts`. Aucun store, scheduler, worker, orchestration, permission ou route nouvelle.

## Budgets et séparation local/client

| Limite existante conservée | Portée exacte de la preuve |
| --- | --- |
| Socket Unix configurée côté serveur ; `POST /v1/complete` fixe | Aucune URL HTTP externe construite par cet adaptateur. Les propriétés supplémentaires du demandeur ne configurent pas la destination. |
| `kind: memory`, `difficulty: 4`, `concurrency: 1`, `max_tokens: 1024` | Enveloppe envoyée constatée par le serveur de test ; ce n'est pas une preuve du respect des tokens/CPU/GPU ni un quota global dans le daemon. |
| Délai adaptateur 100–600 000 ms, défaut 180 000 ms ; deadline absolue même si le serveur émet des octets | Interruption locale vérifiée, sans augmenter aucun plafond. Le délai KARTA plus court ferme maintenant aussi la socket. |
| Message ≤32 000 caractères, contexte configuré 1 000–256 000 caractères, réponse ≤2 Mio | Contrats préexistants conservés ; tests de filtrage, dépassement réponse, réponse malformée et délai inclus dans la gate. |
| Aucun retry ni redirection HTTP ni second fournisseur dans l'adaptateur | Réponses 302/429/500 : une seule requête Unix, rejet, aucun repli. Ce constat ne certifie pas le routage interne du daemon. |

Aucun montant, tarif ou crédit n'est inventé. Aucun secret lu, copié ou configuré. Aucun appel au socket réel, modèle, GPU, fournisseur, DB distante, service de production ou navigateur.

## Preuves et commandes

Environnement : Node `v26.0.0`, versions exactes des dépendances et SHA-256 des sources/configurations dans `evidence.json`. Les preuves sont fraîches pour ces fichiers et ces commandes ; aucune modification produit après la gate.

| Vérification | Résultat | Preuve |
| --- | --- | --- |
| Première suite nouvelle sur le produit de base | **5 FAIL / 7 PASS** : pré-annulation, interruption avant réponse, pendant flux, expiration KARTA, annulation via façade | `red.txt` (premiers 12 tests, avant les 3 cas complémentaires) |
| Première correction + suite historique adaptateur | 21/21 PASS | `targeted.txt` |
| Suite nouvelle finale : 15 cas, dont concurrence et cleanup | 15/15 PASS | `targeted-final.txt` |
| `cd karta && npm test -- --no-cache` — gate complète du package, exécutée une fois | **399/399 PASS**, 31 fichiers, 0 skip | `full-tests.txt` |
| `cd karta && npm run typecheck` | exit 0 | `typecheck.txt` |
| ESLint des deux fichiers source/test avec `--max-warnings 0` | exit 0, aucun avertissement | `lint.txt`, commande dans `evidence.json` |
| `cd karta && npm run build` | exit 0 | `build.txt` |

Le contrôle concerne KARTA et le delta transport. Il ne constitue pas une gate du frontend purama-ai ni une recette navigateur/mobile/production.

## Impact et limites de livraison

GitNexus 1.6.12 est exécuté depuis le cache existant, avec registre et index privés sous `/private/tmp/t03-iao-gitnexus-*`, mode `--index-only`. L'index partagé et son verrou ne sont pas modifiés.

Impact avant édition : `requestFabric` LOW, un appelant direct (`complete`), puis `KartaRuntimeIaoPort.prepare` et `IaoFacade.#prepare` ; `complete` LOW, un appelant direct (`prepare`). Aucun flux remonté sur ces symboles ne signifie pas absence de flux : l'index signale 751 entrées et 1001 callees omis, ainsi que 3 parcours coupés. **Exhaustivité du graphe UNKNOWN**. Pour l'aide de test `socketServer`, l'impact renvoie UNKNOWN ; ses appels sont vérifiés directement dans le seul nouveau fichier de tests. L'analyse des changements avant commit et la revue du diff direct sont conservées dans les preuves ; aucun certificat global de graphe n'est revendiqué.

Le contrôle staged a ensuite annoncé **HIGH / 7 flux** (`gitnexus-detect-changes.txt`). Son résultat structuré, obtenu sur le même diff pour consulter les 26 symboles sans la limite d'affichage du CLI, annonce **MEDIUM / 5 flux** (`gitnexus-detect-changes.json`). Tous ces flux sont attribués au symbole `promise` du nouveau test, dont l'identifiant indexé est la chaîne vide. La requête conservée dans `gitnexus-empty-id.json` montre 40 autres symboles de fichiers distincts avec cet identifiant vide (résultat volontairement borné, non exhaustif). Le backend mappe les processus par identifiant, ce qui rend cette association ambiguë. L'alerte HIGH a été signalée et examinée ; elle n'est pas requalifiée en PASS. Risque global calculé **UNKNOWN** ; anomalie GitNexus hors scope, aucune modification de son code/index partagé.

Revue directe : seul l'adaptateur local change dans `karta/src`; les autres sources produit sont identiques à la base. Le nouveau test n'est importé par aucune source KARTA et le build inclut uniquement `src/**/*.ts`. Les flux de publication/worker mentionnés n'ont aucun hunk modifié. Le périmètre et les empreintes des sources testées sont contrôlés avant commit (`diff-review.txt`). Le scan Gitleaks du diff staged est vert (`gitleaks.txt`) ; il ne constitue pas un audit de l'historique. Les journaux texte conservent leur contenu ; seules les lignes blanches terminales sont retirées pour `git diff --check`.

La fermeture de la connexion libère le transport local et transmet l'intention d'arrêt au service. Elle ne prouve pas que le service tue son calcul, réconcilie un effet, persiste son idempotence ou interdit tout fournisseur payant. L'API reste indisponible sans runtime explicitement injecté, selon le contrat existant. Les budgets à l'intérieur de SMARANA/Compute Fabric et le raccord serveur réel nécessitent les contrats et preuves de leurs propriétaires.

Livraison locale seulement : aucun merge, push, déploiement, migration, action sur processus existant ni nettoyage. Prochaine étape d'intégration : examiner ce commit sur la tête canonique choisie, conserver les adaptateurs SMARANA livrés, puis qualifier séparément le daemon autorisé avant tout câblage réel.

## Finalisation du 2026-10-14

Reprise vérifiée sur `a5cbbcf80b058798f93b2e4ce4a1f9dcfd716e82`, dont le parent est la base annoncée `108291708a3d6858d26519704eb793d29b67cee6`. Les preuves historiques 399/399, typecheck, lint et build du premier commit ont été relues avant tout changement ; elles n'ont pas été assimilées à des preuves du nouveau delta.

Le défaut supplémentaire reproduit est une confiance excessive envers le daemon : toute réponse JSON `{text, engine?, model?}` devenait un succès vérifié, même si le daemon n'attestait ni exécution locale, ni plafonds acceptés, ni absence de fallback payant. `finalisation-red-attestation.txt` conserve l'échec rouge. Le protocole client v2 exige désormais une politique `local_only`/`forbidden` à la requête et un reçu strict qui lie version, clé d'idempotence, digest, plafonds et `paid_fallback_used=false`. Un reçu absent, divergent ou surdéclaré échoue fermé ; aucun autre fournisseur n'est appelé.

Les impacts frais avant édition de `complete`, `requestFabric` et `isResponse` sont **LOW** dans l'index privé de ce worktree. L'index reste tronqué ; son exhaustivité globale demeure **UNKNOWN**. L'ancienne alerte GitNexus HIGH n'est donc pas effacée par ces résultats ciblés. L'analyse finale staged annonce encore **HIGH / 7 flux** en attribuant les sept flux au champ `protocol_version`. Une inspection dédiée trouve cinq candidats ambigus, tous avec `uid` vide ; l'impact les remappe ensuite vers des fonctions sans rapport (`listDeclarations`, `formatEUR`, `updateProspect`, une fonction de test IAO et `CarouselContent`). Les candidats résolus sont LOW, deux restent UNKNOWN. Cette incohérence démontre une collision d'index, pas l'absence de risque : le verdict graphe demeure **UNKNOWN**. Les sorties et la revue directe du diff sont conservées dans `gitnexus-finalisation-*` et `finalisation-direct-scope.txt`.

Portée exacte des preuves finales :

- annulation, deadline et fermeture du transport Unix : vérifiées localement ;
- arrêt d'un calcul : vérifié uniquement sur un daemon fixture qui annule son intervalle à la déconnexion ; **daemon réel UNKNOWN** ;
- permissions : refus SMARANA avant HTTP et refus d'annulation par un autre acteur vérifiés dans le parcours IAO/KARTA local ; **VAJRA réel UNKNOWN** ;
- reprise : stabilité clé+digest et absence de re-dispatch dans une même façade vérifiées ; **déduplication durable du daemon réel UNKNOWN** ;
- budget et absence de fallback payant : demande et reçu v2 stricts vérifiés ; **application interne par le daemon réel UNKNOWN** ;
- intégration composée locale IAO → KARTA → port SMARANA fixture → transport Unix fixture : vérifiée ; **intégration serveur/SMARANA/daemon réelle UNKNOWN**.

La procédure d'intégration et de retour arrière est dans `INTEGRATION-REVERSIBLE.md`. Elle garde le runtime non injecté et les routes en `503` tant que les qualifications réelles manquent.

Gate finale du delta : tests ciblés **29/29 PASS** ; package KARTA **404/404 PASS**, 31 fichiers, 0 échec, 0 skip ; typecheck, lint ciblé et build exit 0. Les sorties sont les artefacts `finalisation-*` de ce dossier.
