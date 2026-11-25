# Réception native de la découverte partenaires

## État avant la CI

**PARTIEL : recette ajoutée et contrôles statiques PASS ; exécution PostgreSQL native NON TESTÉE localement.**

La branche `test/partner-discovery-postgres-20261124` ajoute une preuve de concurrence réelle à la RPC existante `purama_ai.partner_discovery_import`. Les deux migrations, le handler et les règles produit restent identiques. Elle complète les neuf tests PGlite déjà présents avec des sessions PostgreSQL indépendantes.

Base de publication : `afaffbe26d7976f132d053b4600eb4fba300437b`, après conservation de la PR113 par avance rapide. La première lecture et les contrôles syntaxe/lint ont été effectués sur `48869219a22fef71edeb069a2f2b50d966edc363`. Les 18 fichiers indexés et le workflow préparé ont conservé leurs empreintes après cette avance. Le reçu d'impact initial reste un historique de cette première base.

| Vérification | État au moment de la préparation |
|---|---|
| Syntaxe Node du fichier natif | PASS |
| ESLint recommandé avec globals Node, fichier ajouté uniquement | PASS, zéro erreur et avertissement |
| Migrations et test SQL existant | Empreintes conservées |
| Index GitNexus borné actualisé sur la base de publication | PASS pour l'opération d'indexation ; couverture limitée |
| PostgreSQL 18, huit oracles et nettoyage réel | NON TESTÉ localement ; attendu dans la CI |
| Publication, déploiement ou vérification en production | Non établis par cette recette |

Le statut runtime ne doit passer à **PASS** qu'après réception du rapport généré par la véritable exécution et du résultat du job correspondant.

## Périmètre livré

- `karta/test/partnerDiscovery.native.mjs` : huit oracles et réception JSON.
- `.github/workflows/purama-chef-hardening.yml` : appel du fichier dans le service PostgreSQL 18 existant, puis archivage du rapport, y compris en cas d'échec du step natif.
- `vercel.json` : seule la clé de cette branche est ajoutée à `git.deploymentEnabled` avec la valeur `false`, pour éviter une prévisualisation Vercel automatique de cette qualification.
- Ce dossier : scope, preuves statiques, index borné, détection des changements et manifeste de préparation.

Aucun paquet ou lanceur PostgreSQL n'est ajouté au projet. Le module `pg` et le service de test existaient déjà. Le CLI GitNexus 1.6.12 a été rétabli hors du dépôt pour l'analyse, sans modification des dépendances du projet.

## Huit oracles

| Cas | Ordonnancement observé | Résultat attendu |
|---|---|---|
| Même adresse normalisée | Le second PID attend le verrou advisory du premier | Une ligne, un incrément ; première preuve conservée |
| Même organisation sans adresse | Même attente, sans protection par la clé unique d'adresse | Une ligne et un incrément |
| Deux adresses distinctes du même compte | Sérialisation par le verrou du compte | Deux lignes et deux incréments |
| Deux comptes distincts | Le second compte termine avant le commit du premier | Progression indépendante ; une ligne et un incrément par compte |
| Annulation du premier import | Le successeur attend, puis le premier effectue ROLLBACK | Seule la ligne du successeur et son incrément persistent |
| Lot invalide avec successeur | Attente prouvée avant l'erreur de validation du premier | Annulation complète du lot, puis succès du successeur |
| Insertion ordinaire de la même adresse exacte | Attente `transactionid` sur l'insertion non validée | Ligne manuelle préservée ; aucun incrément IA |
| Droits de la RPC | Appels réels sous les trois rôles de la fixture | Refus SQL pour `anon` et `authenticated` ; succès pour `service_role` |

Les courses vérifient des PID distincts, `wait_event_type = Lock`, l'événement attendu et le PID bloquant exact fourni par `pg_blocking_pids`. Le verrou n'est jamais présumé à partir d'un délai arbitraire. La barrière est bornée à cinq secondes ; les transactions définissent aussi des limites SQL et d'inactivité. L'isolation **READ COMMITTED** est interrogée sur le serveur et vérifiée.

## Fixture et sécurité de la cible

La recette reprend le contrat de `consultationStore.native.mjs` : variables `PURAMA_TRIAL_TEST_PG_*` explicites, hôte client `127.0.0.1` ou socket local, répertoire de données exact, version majeure PostgreSQL 18 et rôles déjà créés par la qualification des abonnements. Elle n'utilise aucun repli vers `DATABASE_URL` ni vers une connexion applicative.

Elle crée une base neuve `purama_partner_discovery_test_<suffixe aléatoire>`, y charge les deux migrations réelles et ne modifie pas les rôles du cluster. Le cycle de vie du cluster reste celui du service CI existant. Sur TCP, le contrôle d'identité conserve le répertoire de données et la version : le port local peut être transféré vers l'adresse propre du conteneur Docker.

## Commande et preuve attendue

Depuis `karta`, après les étapes existantes de la fixture PostgreSQL :

```bash
node --test test/partnerDiscovery.native.mjs
```

Le script résout le chemin du rapport depuis son emplacement dans le dépôt, indépendamment du répertoire courant :

```text
qa/partner-discovery-20261124/native/runtime-report.json
```

Le workflow archive ce rapport sous `partner-discovery-native-${github.sha}`. Le rapport contient notamment l'identité PostgreSQL, les PID, l'isolation observée, les barrières de concurrence, les huit résultats, les données persistées et les empreintes des sources. Une synthèse statique ou un reçu PGlite ne remplace pas ce rapport.

Pour obtenir un statut runtime **PASS**, la recette exige aussi : fermeture de tous les clients suivis ; zéro session dans sa base avant et après sa suppression ; absence effective de cette base ; zéro erreur de connexion ou de nettoyage ; empreintes des sources inchangées. Une erreur de nettoyage fait échouer la réception même si les huit assertions métier réussissent.

## Couverture GitNexus et limites

L'analyse demande 19 chemins précis. Elle indexe 18 fichiers, dont le nouveau test, les fixtures, les tests de découverte et les migrations : 851 nœuds, 2 035 relations, 33 communautés et 35 parcours. Le workflow n'est pas représenté dans ce graphe ; son ajout et la clé de branche Vercel sont contrôlés par le diff.

L'index réside hors du dépôt, avec heap Node 256 MiB, buffer LadybugDB 96 MiB, un worker, une seule tranche de parsing en vol et `--index-only`. Les négations de configuration incluent explicitement `karta/test/`. Aucun index complet des dépendances n'a été lancé et aucun guide d'agent n'a été réécrit.

La recherche plein texte est indisponible. La présence des fichiers SQL dans l'index ne prouve pas la résolution de leurs fonctions ni de leurs appels dynamiques. L'impact de la RPC reste **UNKNOWN** si sa cible ne peut pas être résolue ; la lecture SQL directe et la réception native constituent le complément. Les reçus `backend-detect-*` distinguent le périmètre préparé de la comparaison historique avec `origin/main`. La première détection préparée compte 15 fichiers, 92 symboles du nouveau test et zéro parcours affecté dans ce graphe : risque `low`. La comparaison historique compte 3 218 fichiers, 553 symboles et 34 parcours : risque `critical`. Ce dernier niveau porte sur l'écart historique à `main`, qui comprend des travaux antérieurs hors de cette qualification ; il ne représente pas le seul ajout natif. Le nombre de fichiers préparés augmente ensuite avec les reçus de détection et le manifeste, sans nouveau symbole produit.

La qualification vise READ COMMITTED. Elle ne prouve ni les niveaux REPEATABLE READ/SERIALIZABLE, ni une capacité de charge en production, ni la sérialisation de toute écriture manuelle. Le scénario d'insertion ordinaire couvre précisément la collision sur la clé d'adresse exacte existante.

## Navigation des preuves

- `scope.json` : base de publication, origine de l'impact et périmètre autorisé.
- `backend-receipt.json` : contrôles syntaxe/lint et état native NON TESTÉ à la préparation.
- `impact-before.json` et son log compressé : impact initial, conservé comme historique.
- `backend-index-scope.json` : 19 chemins demandés et limites de ressources.
- `backend-index-initial-receipt.json` et `backend-index-receipt.json` : première analyse et rafraîchissement incrémental après l'avance rapide.
- `backend-impact-fresh.json` : résultat de résolution de la RPC dans le graphe actualisé.
- `backend-detect-staged.json` et `backend-detect-main.json` : détection avant commit et limites d'interprétation.
- `backend-manifest.json` : empreintes locales des éléments préparés, sans prétention de réception en CI.

Les logs associés sont compressés pour conserver les sorties originales. `runtime-report.json` est volontairement absent tant qu'aucune exécution native n'a produit cette preuve.
