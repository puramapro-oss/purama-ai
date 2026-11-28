# Entraide — rapprochement vérifié des PR #17 et #23

## Qualification native et navigateur — 10 novembre, passe de continuation

Sur le candidat publié `c9337987ae1f3c820b8947bd3da4e6f1721c57c4`, le runtime
non privilégié permet maintenant une vraie instance PostgreSQL 18.6 jetable.
La commande du workflow `npm run test:native --prefix tests/entraide` produit
**83 PASS, 0 échec, 0 SKIP**, dont les quatre courses multisession précédemment
ignorées : dernière place, contact répété, reçu de mission unique et quota quotidien.
Les trois états de migration et les droits actuels sur les reprises sont inclus.
Les 83 cas recouvrent une partie des 111 tests PGlite historiques ; leurs décomptes
ne s’additionnent pas.

Le parcours UI → vrai HTTP → PostgreSQL natif → UI produit **3 PASS** dans Firefox
148.0.2 / Playwright 1.59.1, sans reprise automatique ni scénario ignoré. Il couvre
la mission privée puis publique, l’adhésion et la fin déclarée, le consentement
de contact et sa révocation, les réponses perdues, les brouillons et la largeur
mobile de 390 pixels. Le premier passage a révélé une comparaison de test entre
un `bigint` SQL renvoyé en texte par `pg` et un compteur JSON numérique. Le test
compare maintenant leurs entiers exacts avec `BigInt`. Aucune source produit,
politique d’accès, migration ou validation HTTP n’a changé dans cette continuation.

Les commandes, journaux avant/après, versions et empreintes sont conservés dans
[`native-qualification/RECEIPT.json`](../../qa/entraide-reconciliation-20261110/native-qualification/RECEIPT.json).
Les traces et captures synthétiques complètes restent dans le dossier local
`test-results/`. Les installations npm de l’application et des dépendances SQL,
la provenance du paquet privé de matching, son garde SHA-256 et l’ESLint du test
ont été vérifiés. L’impact GitNexus du banc est LOW, avec un fichier appelant.

Cette preuve locale lève les anciens blocages natifs et navigateur décrits plus
bas. L’authentification Supabase hébergée, PostgREST distant, les fonctions Edge
déployées, la charge réelle, les appareils physiques et la production restent
**NON TESTÉS**. Aucune publication ni migration distante n’a été effectuée.
La livraison du client et de l’API reste coordonnée ; le RPC historique #17 reste
retiré et ne redevient pas une deuxième autorité.

## Historique de la première qualification

Les résultats ci-dessous décrivent la première passe, conservée avec ses limites
d’origine. Les quatre SKIP et le blocage navigateur ne décrivent plus la passe
native de continuation ci-dessus.

## Périmètre exact

Correctif local préparé sur la branche existante de la PR #23,
`codex/human-one-project-flow-20261110`, à partir de
`eb09c6d1a1c134bbf430f20c3fb6f94f8ec3afcb`.
La source #17 examinée est
`0660d23c28e48ac0522725546848b0c842202708`.
Aucune base applicative, migration distante, publication, opération financière
ou autre checkout n’a été modifié par cette qualification.

Le protocole canonique reste le RPC de service `entraide_mission_command` et son
compteur `revision`. Le préambule de `021000`, lorsqu’elle n’est pas encore
appliquée, reconnaît l’implémentation #17 exacte par SHA-256 et retire son RPC
SECURITY DEFINER. La migration additive `022000` transforme ensuite `version` en
`revision = version - 1` et conserve les identités, membres, dates et réponses
historiques. Sur une base #23 où `021000` est déjà enregistrée, **seule `022000`
est appliquée**. Il n’existe aucune nouvelle migration insérée sous cette version.
Une installation inconnue ou partielle est refusée.

Le registre durable reprend la clé `(actor_id, request_id)` de #17. Une réservation
concurrente attend la transaction propriétaire ; un même identifiant ne peut
changer d’action, de mission, de contenu ou de précondition. Une erreur métier
annule aussi la réservation. La réponse d’une reprise relit les droits et l’état
actuels : elle ne réinscrit pas un membre ayant quitté la mission, ne republie pas
une mission masquée et ne révèle pas un ancien reçu privé après perte d’accès.

La page et l’adaptateur historique envoient un identifiant pour chaque mutation.
Après une réponse incertaine, ils conservent cet identifiant et la révision de
départ. La page propose une reprise explicite avant une nouvelle action. La
traduction HTTP de `expected_version` est transitoire ; envoyer les deux compteurs
est refusé. Une ancienne création #17 en vol peut retrouver son vrai UUID via son
reçu. Les lectures et les clients actuels utilisent exclusivement `revision`.

## Preuves exécutées ici

Les journaux et le reçu machine se trouvent dans
`qa/entraide-reconciliation-20261110/`.

| Contrôle | Résultat observé | Limite |
|---|---|---|
| Suite SQL / HTTP / contrats / clients / SDK | **PASS : 111**, 0 échec ; **4 SKIP** natifs | `protocol-final.log`, Node 24.22.1, PGlite 0.5.8 ; 115 tests enregistrés |
| Passage réel du schéma #17 au schéma canonique | **PASS : 15** scénarios inclus dans les 111 | Fixtures SQL exactes, rôles, droits, reçus, reprises désordonnées et vrai handler HTTP |
| Mise à niveau d’une base #23 déjà appliquée | **PASS : 5** scénarios inclus dans les 111 | Ancien SQL exact, versions enregistrées et sautées, migration additive seule, réapplication connue et refus d’un corps/registre inconnu |
| Reprise de l’adaptateur historique | **PASS : 2** tests inclus dans les 111 | Vraie bibliothèque pure et vrai transport, session et pair HTTP synthétiques ; également exécutés séparément dans `compatibility-client.log` |
| TypeScript ciblé avant/après | **PASS** | Trois sources modifiées et leurs dépendances, 279 fichiers ; 0 diagnostic avant et après. Ce n’est pas le typecheck du dépôt complet |
| ESLint ciblé et whitespace du patch | **PASS** | Sources TypeScript modifiées ; pas un audit du dépôt complet |
| Refus du gate natif sans URL dédiée | **PASS du refus attendu** | `native-gate-refusal.log` sort avec code 1 avant toute base ; ce n’est pas un test PostgreSQL natif réussi |
| PostgreSQL natif et concurrence multisession | **BLOQUÉ / NON TESTÉ** | Binaires 18.6 présents ; préparation du répertoire pour le compte système `nobody` refusée par le runtime (`chown`, EINVAL), avant `initdb`. Aucune simulation d’UID |
| Navigateur et parcours tactile/visuel | **NON TESTÉ** | Aucun navigateur utilisable validé dans cette session ; aucune qualification UI revendiquée |
| Supabase hébergé, fonctions déployées, données de production | **NON TESTÉ** | Aucun accès ou déploiement utilisé |

Les 15 scénarios #17, les cinq scénarios de mise à niveau #23 et les deux tests
d’adaptateur sont inclus dans les 111 : ils ne s’y ajoutent pas. Les quatre cas
natifs restent explicitement ignorés localement, avec un test supplémentaire
d’une seule réservation de mission pour deux connexions concurrentes.

GitNexus a été exécuté avant les modifications. L’impact indexé de la validation
HTTP et de la page est LOW. L’adaptateur sans appelant résolu et les fonctions SQL
sont UNKNOWN : les recherches textuelles et la lecture du trajet
handler → ports de service → RPC complètent ce graphe. L’index annonce lui-même
des flux tronqués ; une absence d’arête n’est pas une preuve d’absence d’usage.
La détection finale du patch agrégé classe le risque **HIGH**, avec 32 symboles
et six flux affectés. Ce signal est conservé dans `gitnexus-changes.log` ; les
tests SQL/HTTP et la contre-revue indépendante qualifient le périmètre décrit,
sans transformer ce graphe en preuve de tests natifs ou de déploiement.

## Ordre de transition et limites restantes

1. Qualifier ce patch sur un environnement isolé autorisé dans les trois états :
   installation neuve, deux migrations #17 exactes déjà appliquées, puis #23 avec
   `021000` déjà enregistrée. Le workflow natif utilise
   une base PostgreSQL dédiée et doit réellement réussir avant qualification de
   la concurrence. Il couvre aussi les modifications des sources Entraide.
2. Pour une installation neuve ou #17, appliquer les versions encore absentes
   dans l’ordre `020000`, `021000`, `022000`, avec arrêt des anciennes écritures
   pendant la transition. Pour une base #23 ayant enregistré les deux premières,
   appliquer seulement `022000` ; ni données, ni compteurs, ni visibilité, ni
   consentements ne sont réinitialisés. Ne pas réappliquer #17 après ce passage.
3. Déployer les fonctions et le client réconciliés ensemble en staging ; vérifier
   l’authentification hébergée, les parcours navigateur et les refus inter-comptes,
   puis faire recharger les anciens clients. Le RPC #17 est retiré, pas maintenu
   comme une deuxième autorité.

Le moteur initial et le schéma de `021000` restent ceux de #23 ; son nouveau
préambule ne concerne que les installations où elle n’est pas encore appliquée.
Tous les nouveaux mécanismes de reçus et de reprise sont dans `022000`. Le test
de sélection des versions modélise un historique de migrations enregistré ; il
ne constitue pas une exécution du CLI Supabase hébergé. Aucune opération de
production n’est proposée automatiquement.

Les appels #23 anciens sans `request_id` conservent leur comportement antérieur ;
ils n’obtiennent pas la garantie d’une reprise durable. Les clients modifiés
l’envoient systématiquement. Les intentions non confirmées sont conservées en
mémoire pendant la session de la page ; une fermeture de l’onglet impose une
relecture de l’état avant une nouvelle intention.

La pagination des listes reste nécessaire pour une charge importante. Les quotas
de contacts sont transactionnels, mais le limiteur HTTP de rafale reste local au
worker. `terminee` reste une déclaration de l’organisateur, sans preuve indépendante
de livraison et sans autorisation de paiement. Ce reçu ne déclare donc pas le
produit entier prêt pour une ouverture commerciale universelle.
