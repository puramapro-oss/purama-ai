# Entraide — refus avant la première migration et reprise vérifiée

## Résultat

**PASS — 92 tests sur PostgreSQL natif 18.6, Node 24.22.1 : aucun échec,
aucun test ignoré.** Le correctif ajoute un contrôle en lecture avant toute
modification de fonction ou de droits dans la première migration encore à
appliquer, `20261110020000_entraide_contact_atomic.sql`.

Cette livraison prolonge la PR #23 au commit de départ
`8914d209cd92c2c1e4408a81eaeadc6faea483d8`, sur la base `main`
`d116dc8a6429ea76c67167a195eb3f723f2251fb`. Elle conserve le protocole de
contacts, le protocole de missions et leur contrat HTTP. Aucun environnement
de production n'a été utilisé ou modifié.

## Défaut reproduit

Le fichier `020000` possédait son propre `BEGIN/COMMIT` et installait la
fonction contact ainsi que ses droits. Les étapes `021000` et `022000`
refusaient ensuite certains historiques incompatibles. Le refus tardif ne
pouvait pas annuler les modifications déjà validées par `020000`.

Les huit nouveaux scénarios négatifs ont d'abord été exécutés sur le code de
départ, avant correction : **0 réussite, 8 échecs**. Les différences
d'instantanés montrent notamment une fonction contact ajoutée ou remplacée
et des ACL modifiées. Ces tests n'utilisent aucune transaction extérieure
qui masquerait le premier `COMMIT`.

Après ajout du contrôle : **8 réussites, 0 échec** sur les mêmes scénarios.
Chaque refus laisse identiques les définitions et droits des fonctions,
tables, colonnes, politiques RLS, contraintes, données et reçus présents dans
la fixture. L'erreur reste `P0001 / entraide_missions_reconciliation_required`.

| Historique synthétique refusé | Ce qui doit rester intact |
| --- | --- |
| Autorité unifiée `entraide_command(text,jsonb)` | Autorité existante et droits ; aucune seconde autorité contact |
| Empreintes de schéma privé : activation, visibilité et métadonnées de contact | Sens des consentements, règles de lecture et données |
| Fonction contact étrangère à signature identique | Corps et ACL de cette fonction |
| Autorité #17 exacte, avec visibilité préexistante | Schéma dont la conversion n'est pas définie |
| Corps de fonction #17 modifié | Implémentation inconnue |
| Registre de reçus orphelin | Historique de requêtes |
| Colonne de version orpheline | État existant sans autorité reconnue |
| Reçu #17 portant une action incompatible | Reçu réellement créé puis modifié dans la fixture |

Le contrôle reprend aussi les préconditions des étapes suivantes concernant
les types du registre, sa clé primaire, la forme des données, les versions
et les résultats de mission. Il ne convertit pas automatiquement un protocole
privé ou personnalisé.

## Reprise autorisée et garanties conservées

Un neuvième scénario couvre une installation partielle légitime. Il applique
`020000` deux fois, compare l'état complet après chaque application, puis
termine `021000` et `022000`. Des appels réels avec le rôle `service_role`
relisent les contacts et blocages existants, créent puis rejouent une mission
avec reçu durable, envoient un contact et vérifient son acceptation persistée.

L'empreinte du corps contact reconnu est
`b50ce38f06a495573a15fc72c91cef210dfb724df33752b4b2fb4974ddff14dd`.
Le corps de cette fonction n'a pas changé. L'empreinte a été vérifiée lors
d'une revue indépendante. Dans un reçu de création, `mission_id` reste la
cible d'entrée, donc `null` ; l'identifiant créé est conservé dans
`response.mission.id`. Le test contrôle explicitement ce contrat.

La suite complète contient les 83 scénarios natifs préexistants et ces 9
nouveaux scénarios. Elle conserve notamment les chemins d'installation neuve,
de migration #17 exacte et de mise à jour additive d'une base #23 déjà
migrée. Les quatre courses entre connexions PostgreSQL indépendantes passent
encore : dernière place disponible, même contact répété, même reçu de
mission et quota quotidien concurrent.

Les installations #23 déjà migrées continuent de sauter `020000/021000` et
d'utiliser l'étape additive `022000`. Le nouveau contrôle protège une étape
encore à appliquer ; il n'annule pas rétroactivement une migration déjà
validée dans un autre environnement. Les migrations suivantes conservent
leurs propres contrôles.

## Preuves et reproduction

- [Échec avant correction](../../qa/entraide-preflight-20261110/before.json) et
  [journal intégral](../../qa/entraide-preflight-20261110/before.txt).
- [Mêmes huit scénarios après correction](../../qa/entraide-preflight-20261110/after.json)
  et [journal](../../qa/entraide-preflight-20261110/after.txt).
- [Qualification finale de 92 tests](../../qa/entraide-preflight-20261110/final.json)
  et [journal complet](../../qa/entraide-preflight-20261110/final.txt).
- [Empreintes et portée de la revue](../../qa/entraide-preflight-20261110/RECEIPT.json).

Avec un service PostgreSQL de test isolé et `ENTRAIDE_DATABASE_URL` configurée
selon le [README](README.md) :

```sh
npm ci --ignore-scripts --prefix tests/entraide
npm run test:native --prefix tests/entraide
```

Le garde-fou du harness exige une adresse de bouclage, un port explicite
différent de 5432 et la base administrative `entraide_test_admin`. Il crée
des bases jetables et utilise seulement des identités synthétiques. La
qualification locale a démarré puis arrêté PostgreSQL 18.6 sur TCP local.

La CI antérieure de la PR #23 a également été débloquée : le
[job 130156377488 du run 42840462976](https://github.com/puramapro-oss/purama-ai/actions/runs/42840462976/job/130156377488)
a réellement exécuté et réussi ses **83 tests** après relance. Le
[journal extrait](../../qa/entraide-preflight-20261110/ci-83-excerpt.txt)
identifie le commit de fusion testé et les totaux. Ce résultat concerne le
commit de départ ; les checks attachés à la nouvelle tête de PR constituent
la preuve CI propre au présent correctif. Les passages successifs ne sont
pas additionnés comme des scénarios distincts.

## Revue et limites

L'analyse GitNexus est bornée au périmètre Entraide : 42 fichiers indexés au
départ, 934 nœuds et 63 processus. L'impact de `createDb` indique 7 appelants
directs, 1 dépendant indirect et un risque MEDIUM ; le harness reste inchangé.
La fonction SQL n'est pas reconnue comme symbole : son risque d'après le
graphe est **UNKNOWN**, jamais une preuve d'absence d'impact. Une réindexation
incrémentale a été interrompue avec le code 137 ; les contrôles
`detect-changes` staged et compare ont ensuite réellement pu être exécutés.

Le diff de cette correction reste dans la migration, les tests et leur
documentation/preuves. La comparaison globale de la PR avec `main` couvre
70 fichiers, 791 symboles et 63 processus, et est classée CRITICAL par
l'outil. Cette comparaison inclut les travaux déjà présents dans la PR et
justifie de conserver une réception intégrée avant toute mise en production.

**PARTIEL :** protection des historiques explicitement examinés, sans preuve
universelle sur tous les schémas personnalisés. La conversion des contrats
privés divergents doit préserver séparément l'activation des profils, le
sens de la visibilité et les identités de reprise des contacts.

**NON TESTÉ par cette correction :** connexion Supabase hébergée, PostgREST
distant, fonctions Edge déployées, intégration ONE ID, appareils physiques
et charge de production. Les preuves navigateur antérieures restent dans
le [rapport de réconciliation](RECONCILIATION-20261110.md) ; elles n'ont pas
été rejouées pour ce changement SQL. Aucun effet humain, paiement, déploiement
ou disponibilité universelle n'est déduit de ces tests.
