# Qualification native de l’autorité SQL de l’API IAO

**PASS : 7 tests avec PostgreSQL 18.7 natif, plusieurs connexions et contention réelle observée.** Les tests ne font aucun appel fournisseur et ne constituent pas un déploiement de production.

## Preuves

- `public-api-native.tap.txt` : sortie TAP complète, identifiants de backends distincts et observations `wait_event_type = Lock`.
- `receipt.json` : commande, version Node, version PostgreSQL observée, empreintes des sources testées, résultat et vérification de l’arrêt du cluster.
- `postgres-bootstrap.log` : initialisation et arrêt du cluster jetable.
- `bootstrap-unix-socket-unavailable.log` et `.json` : premier essai interrompu avant les tests, car le système de fichiers n’autorisait pas les sockets Unix. Le passage à TCP sur `127.0.0.1` a permis la qualification sans service externe.

Les dépendances PostgreSQL ont été installées dans un répertoire d’outillage isolé, avec `embedded-postgres@18.7.0-beta.19` et son binaire `@embedded-postgres/linux-x64`. Aucun manifeste ou verrou de dépendances du projet n’a été modifié. Il s’agit du paquet publié par le mainteneur d’Embedded Postgres, et non d’un paquet publié par le projet PostgreSQL.

## Scénarios vérifiés

1. Deux clés du même projet concourent pour le dernier emplacement de débit : une seule admission réussit.
2. Deux créations simultanées du même identifiant externe produisent un seul rattachement interne durable.
3. Une révocation non encore validée bloque une réservation ; après validation de la révocation, la réservation est refusée sans appel enregistré.
4. Une révocation attend une admission déjà verrouillée ; après sa validation, toutes les admissions suivantes sont refusées.
5. Deux projets du même propriétaire concourent pour le budget CHEF restant : une seule réservation de 50 micro-unités réussit.
6. Une restriction de modèles validée pendant l’attente empêche l’admission suivante.
7. Un plafond de coût réduit pendant l’attente empêche l’admission suivante.

Dans chaque scénario concurrent, la suite attend une observation réelle des verrous PostgreSQL avant de libérer la transaction qui bloque les requêtes. Elle n’utilise pas un délai arbitraire comme preuve de concurrence.

## Reproduction

Utiliser exclusivement un cluster PostgreSQL 18 **jetable**. La suite refuse les paramètres de l’application et ne lit jamais `DATABASE_URL`. Le cluster doit écouter uniquement sur `127.0.0.1`, ou sur un socket Unix avec l’écoute TCP désactivée. Son `data_directory` réel doit correspondre exactement au chemin fourni.

Créer dans ce cluster neuf les rôles de test `anon` et `authenticated` sans connexion, sans privilèges administratifs, puis `service_role` avec les mêmes restrictions et `BYPASSRLS`. Ces rôles ne doivent avoir aucune appartenance à d’autres rôles. La suite vérifie ces propriétés avant toute création de base.

Depuis `karta`, définir explicitement :

```text
PURAMA_API_TEST_PG_CONFIRM=disposable
PURAMA_API_TEST_PG_HOST=127.0.0.1
PURAMA_API_TEST_PG_PORT=<port du cluster jetable>
PURAMA_API_TEST_PG_USER=<propriétaire du cluster jetable>
PURAMA_API_TEST_PG_PASSWORD=<mot de passe du cluster jetable>
PURAMA_API_TEST_PG_DATA=<data_directory absolu et observé>
```

Puis exécuter :

```bash
node --test --test-reporter=tap test/publicApi.native.mjs
```

La suite crée une base dont le nom est aléatoire et préfixé `purama_api_test_`, applique les migrations de production nécessaires et supprime uniquement cette base à la fin. L’outillage utilisé pour cette qualification a ensuite arrêté et supprimé son propre cluster. Le reçu confirme l’absence d’écoute TCP et la suppression du répertoire de données.

Documentation primaire de l’outillage : [Embedded Postgres — installation et configuration](https://github.com/leinelissen/embedded-postgres). Pour ce lancement, les options retenues étaient une authentification SCRAM, une écoute TCP `127.0.0.1`, aucun socket Unix et aucun utilisateur système supplémentaire.
