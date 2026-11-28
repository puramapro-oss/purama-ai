# Réception des archives IAO dans le garde Wealth — 24 novembre 2026

## Périmètre et continuité

Correction de fiabilité déjà définie, `PRET_A_CODER`, reprise sous la validation collective du 21 novembre et la demande de finalisation du 24 novembre. Préparation : `/root/consolidation_current_gates` ; revue et publication : `/root`. Base reçue : `9ab7e16b9d1230185d52d216a406c90a3a4a486d`, branche isolée `fix/iao-wealth-evidence-20261124`. Intégration autorisée uniquement dans `audit/reliability-oauth-20261110` ; PR40 reste en brouillon et aucun déploiement de production n'est demandé.

Le workflow Wealth échoue avant l'installation de GitNexus : [run 45492058278](https://github.com/puramapro-oss/purama-ai/actions/runs/45492058278/job/138792674407), étape « Record the exact PR comparison », sortie 2. Après les 52 exceptions antérieures, seules deux archives immuables de PR108 restent signalées. Le même défaut existe sur la consolidation PR110 [run 45479509141](https://github.com/puramapro-oss/purama-ai/actions/runs/45479509141/job/138748550166). Ces échecs ne sont pas des résultats de tests applicatifs.

## Correction

Le garde existant reçoit deux couples chemin/blob exacts supplémentaires :

| Archive | Blob Git | Taille |
| --- | --- | --- |
| `qa/iao-continuity-20261124/auth-sdk/edge-npm-alignment-karta.log` | `82ac622e1bf22f17b5160b11f21de59ab29f8401` | 426 octets |
| `qa/iao-continuity-20261124/ci-first-attempt/device-job-excerpts.log` | `307635738311c75bbf1181d9ca648073aa7d3d64` | 6 619 octets |

Leur exemption conserve les trois conditions du garde : chemin absent de la base, blob exact, mode `100644`. Les journaux restent inchangés, y compris leurs espaces et sauts de ligne originaux. Aucun glob d'exclusion général ni assouplissement du contrôle des sources n'est ajouté. L'entrée de non-déploiement de la nouvelle branche est ajoutée à `vercel.json` ; toutes les entrées existantes sont conservées.

## Preuves locales

- Même harnais de 39 cas avant et après : **36 PASS / 3 FAIL avant**, puis **39 PASS / 0 FAIL après**. Les trois cas rouges portent sur les deux premières admissions des archives et leur composition avec PR104.
- Douze nouveaux cas couvrent admission exacte, changement des octets, renommage, chemin préexistant, mode exécutable, composition avec les archives antérieures et impossibilité de masquer une source défectueuse. Les 27 cas précédents sont préservés.
- Le garde réel sur `42d508b46dc7e7cda7efe3c6bfd4396450afedef` → `9ab7e16b9d1230185d52d216a406c90a3a4a486d` passe de la sortie **2** à **0**, avec 54 exceptions byte-identiques. Le garde testé après correction est celui de l'arbre de travail ; cette preuve n'est pas présentée comme l'exécution d'un commit déjà publié.
- Syntaxe Bash et contrôle d'espacement de la modification passent. Les empreintes des deux archives et l'identité du harnais rouge/vert sont vérifiées dans `verification.json`.

Les sorties sont conservées dans les reçus JSON ; leur contenu textuel est encodé sans modifier les octets des archives. Aucun test métier, aucun modèle, aucune connexion PostgreSQL et aucun appel fournisseur ne sont relancés par ce lot.

## Analyse de portée et limites

L'impact GitNexus a été demandé avant édition sur `main` du harnais, avec l'index antérieur `iao-runtime-composition-20261124` : symbole absent, résultat **UNKNOWN**, compteur inconnu. Ce résultat ne signifie pas qu'il n'existe aucun appelant.

Un index indépendant et borné aux deux scripts et au workflow Wealth a ensuite été construit en 4,585 secondes : 19 nœuds, 32 relations, deux flux, FTS désactivé. L'impact postérieur à l'édition trouve un appelant direct dans le fichier du harnais, risque LOW dans ce périmètre. Ce complément ne remplace pas l'impact antérieur et ne couvre pas l'ensemble du produit. Les détections finales préparée et comparée sont reçues séparément par le responsable de publication.

Les recherches ciblées n'ont trouvé ni branche ni PR Wealth concurrente correspondante. Le claim Mac `CHATGPT-ONE-RELIABILITY-20261110-272ffd` concerne l'outbox et l'espace des accords, sans chevauchement avec ces fichiers. Les autres périmètres et les travaux PR112, T04 et Fabric restent distincts. Cette observation bornée n'est pas un inventaire universel de tous les agents.

**CI de cette correction : NON TESTÉE au moment de la préparation.** Seule la réception du commit publié pourra compléter cette preuve. Aucun succès GitNexus de l'ensemble de la consolidation ni succès de production n'est revendiqué ici.

## Réconciliation avant publication

La consolidation a avancé pendant la préparation : PR112 est reçue au commit `48869219a22fef71edeb069a2f2b50d966edc363`. Les dix préimages du lot sont identiques entre les deux bases ; les changements concurrents sont disjoints. Le worktree a avancé par fast-forward, en conservant les dix contenus préparés exactement. Le garde corrigé passe aussi sur la comparaison complète `42d508b46dc7e7cda7efe3c6bfd4396450afedef` → `48869219a22fef71edeb069a2f2b50d966edc363`, sortie 0. Ce dernier commit est le parent du candidat à publier ; les reçus avant/après conservent leur base de préparation d’origine.
