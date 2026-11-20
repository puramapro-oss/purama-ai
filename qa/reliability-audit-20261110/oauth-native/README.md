# OAuth — contre-épreuve et qualification PostgreSQL native

**PASS : 11 groupes de contrôles natifs sur la migration corrigée, sur deux moteurs.**
La même migration et le même banc ont réussi dans des clusters jetables
PostgreSQL 18.4 sur macOS et PostgreSQL 16.15 sur Linux.
Il ne qualifie pas un fournisseur OAuth, une session réelle ou la production.

## Défaut trouvé par la contrelecture indépendante

La première version utilisait un `UPDATE ... WHERE expires_at > clock_timestamp()`.
Une requête pouvait évaluer sa durée de validité, attendre derrière un
`SELECT FOR UPDATE` qui ne modifiait pas la ligne, puis consommer le nonce après
son expiration. Le simple verrou ne garantissait pas une nouvelle évaluation de
la condition temporelle après l'attente.

Le banc a observé la connexion réellement bloquée, vérifié que le nonce était
encore valide à cet instant, attendu son expiration en base, puis libéré le
verrou. Sur la source initiale, un reçu était néanmoins retourné. La source
corrigée verrouille d'abord la ligne, puis prélève l'heure d'admission, contrôle
la consommation et l'expiration, et utilise cette même heure pour la mutation.

| Version de la migration, SHA-256 | Résultat natif |
| --- | --- |
| `aa53db76df986c60817253d34ae9c46757d3a47efeef23f36a1dfbfa47ce49dc` | **10 PASS / 1 FAIL**, expiration pendant attente de verrou |
| `e0b0e94339d2f83966603bbfeeea74cfa6e1669808c06c6dfd16d6f8bc65ec67` | **11 PASS / 0 FAIL** |

Le script `verify_native.py` est strictement identique dans les deux campagnes :
SHA-256 `2474b629686dd265434b5f2594e41a2e79da4316ecf005a76deed3f48b3cf4d0`.
Les assertions n'ont pas été assouplies entre les deux exécutions.

## Ce qui a été exécuté

| Groupe | Preuve finale |
| --- | --- |
| Métadonnées et RLS | Deux fonctions `SECURITY INVOKER`, chemin fixe, RLS activée ; rôle de test `service_role` sans contournement RLS |
| Création et répétition | Durée serveur de 600 secondes ; premier reçu conforme ; répétition refusée |
| Identité et purpose | Mauvais acteur, acteur absent et mauvais purpose refusés ; acteur obligatoire pour Google et Gmail |
| Expiration préalable | Aucun reçu et `consumed_at` inchangé |
| Entrées invalides | Créations refusées avec SQLSTATE 22023 ; consommations invalides sans reçu |
| Droits des clients | Douze opérations refusées avec SQLSTATE 42501 : lecture, insertion, modification, suppression et deux RPC pour chacun des rôles `anon` et `authenticated` |
| Concurrence native | Douze connexions distinctes, toutes observées simultanément en attente de verrou ; un seul reçu et onze résultats vides |
| Expiration pendant attente | Connexion observée bloquée avant expiration ; libération après expiration ; aucun reçu et aucune consommation |
| Annulation de transaction | Consommation annulée par rollback, puis une seule consommation durable possible |
| Échec de création | Collision de clé provoquant 23505 ; suppression de maintenance annulée et reçu d'un autre acteur conservé |
| Suppression d'acteur | Suppression en cascade des deux purposes ; nonces inutilisables ensuite |

Ces onze groupes contiennent plusieurs assertions. Les douze opérations de
droits et les douze clients ne s'ajoutent pas artificiellement au nombre de
groupes. Les preuves peuvent recouper les suites PGlite et handlers du lot parent.

Les trois campagnes ont utilisé des clusters distincts, des ports libres et
uniquement `127.0.0.1`, avec vérification du `data_directory` et de l'identifiant
du serveur avant les écritures. Chaque exécution a confirmé l'arrêt de son
serveur, la suppression du cluster et la fermeture du port. Aucun paiement,
envoi, calendrier, serveur existant ou fournisseur OAuth n'a été appelé.

## Dossier de preuves et provenance

- `baseline/` : résultat en échec, transcript SQL complet, journal PostgreSQL,
  migration et helper de cette campagne.
- `final/` : résultat réussi, transcript SQL complet, journal PostgreSQL,
  migration et helper qualifiés sous PostgreSQL 18.4 sur macOS.
- `linux-pg16/` : seconde exécution réussie, cette fois via le lanceur portable,
  sous PostgreSQL 16.15 sur Linux et l'utilisateur non privilégié UID 1000.
  La commande, le code de sortie et les journaux complets sont conservés.
- `ci-portability-review.json` : revue du workflow Ubuntu et périmètre exact
  de la vérification Linux ; l'exécution GitHub Actions reste distincte.
- `transfer-receipt.json` : empreintes et tailles vérifiées après rapatriement,
  intégrité de l'archive de transport et absence de cluster restant.
- `manifest.json` : empreintes finales du banc, du lanceur, des preuves et des
  deux sources courantes du dépôt.

Les premiers appels Desktop Commander ont expiré sans résultat de test exploitable.
Une inspection ultérieure a trouvé les entrées transférées, aucun processus du
banc et un répertoire temporaire vide, sans données PostgreSQL. Ce répertoire a
été retiré après vérification de son état vide. Une reprise distincte a produit
la contre-épreuve ci-dessus ; les timeouts ne sont pas présentés comme un PASS.

Le helper TypeScript est **empreinté et relu**, pas exécuté par ce banc SQL.
Sa version finale est
`cf6b4e0d4431dc655ea6bbb82615a926f3348d5f5a68dbdbf587187efe41b5c2`.
Sa génération aléatoire, son hachage, ses vérifications de reçu et son utilisation
par les handlers relèvent de leurs propres suites. Les deux flows exigent un
acteur vérifié ; aucun test ne considère un callback Gmail sans acteur comme une
consommation autorisée.

## Commande portable pour la CI

Le lanceur ne télécharge rien et ne se connecte jamais à un service PostgreSQL
existant. Il utilise `PG_BIN` si défini, sinon recherche une installation complète,
notamment sous `/usr/lib/postgresql` sur Ubuntu. Le script crée lui-même son
cluster et impose ses paramètres de connexion. Depuis la racine du dépôt :

```bash
bash qa/reliability-audit-20261110/oauth-native/run-native.sh \
  --migration supabase/migrations/20261110233000_oauth_connection_states.sql \
  --helper supabase/functions/_shared/oauth-state.ts \
  --fixture-root "$RUNNER_TEMP/purama-oauth-native-clusters" \
  --output "$RUNNER_TEMP/purama-oauth-native-results"
```

Pour un environnement dont les binaires ne sont pas dans les emplacements
recherchés, `PG_BIN` doit désigner le dossier contenant `initdb`, `pg_ctl`,
`postgres` et `psql`. Le lanceur échoue explicitement si un binaire manque.
Le contrôle de syntaxe Bash et le chemin explicite jusqu'à l'aide du banc ont
réussi localement. Le lanceur a aussi exécuté les onze groupes avec succès sous
Linux, UID 1000, PostgreSQL 16.15, en 5,7 secondes, sans `sudo` ni installation.
Ce contrôle utilise `PG_BIN` explicite ; la découverte automatique des binaires
du runner hébergé a été relue et reste à confirmer pendant la CI.
L'exécution GitHub Actions reste à vérifier par le lot parent ;
le présent dossier ne revendique pas une CI hébergée déjà exécutée.

Le job KARTA a été fixé par le lot parent sur `ubuntu-24.04`, comme le job site.
La documentation de cette image indique PostgreSQL 16.15 déjà installé et son
service désactivé. Le banc crée son propre cluster sous `RUNNER_TEMP`, ne lance
aucun service système, efface les paramètres `PG*` hérités et contrôle l'identité
du serveur avant les fixtures. `initdb` et le serveur tournent sous le même
utilisateur non privilégié. Un port occupé entre sa sélection et le démarrage
fait échouer l'installation ; les fixtures ne sont appliquées qu'après le
démarrage et le contrôle d'identité. Un arrêt forcé du processus par l'hébergeur
reste différent du nettoyage applicatif observé ici.

## Limites

La qualification native porte sur PostgreSQL 18.4 et 16.15, avec le schéma minimal reproduit.
Les migrations réelles, les réglages du serveur retenu, PostgREST, les sessions
et fournisseurs réels restent des vérifications distinctes. La consommation
unique du nonce n'est pas une garantie d'exécution unique d'un effet fournisseur
après une panne. La révocation d'une identité entre authentification HTTP et
admission SQL n'est pas rendue atomique par ce registre.

## Références de contrelecture

- [Isolation des transactions PostgreSQL 18](https://www.postgresql.org/docs/18/transaction-iso.html) :
  attente des verrous et traitement des versions concurrentes de ligne.
- [Fonctions temporelles PostgreSQL 18](https://www.postgresql.org/docs/18/functions-datetime.html) :
  distinction entre l'horloge réelle et les instants fixés à une transaction.
- [Image GitHub Actions Ubuntu 24.04](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md) :
  PostgreSQL 16.15 installé et service désactivé ; annonce de migration du label
  `ubuntu-latest` vers Ubuntu 26.04 en novembre 2026.
- [Privilèges des runners GitHub](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#administrative-privileges) :
  élévation de privilèges optionnelle par `sudo`, absente de ce lanceur.
- [Exigences d'initdb](https://www.postgresql.org/docs/18/app-initdb.html) :
  initialisation par le propriétaire du futur processus serveur, sans root.

Le défaut et sa correction sont établis par les exécutions natives conservées,
pas par une interprétation de la documentation seule.
