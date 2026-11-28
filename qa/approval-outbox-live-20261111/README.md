# Qualification native du relais d’approbations

Ce harnais appelle `drainApprovalOutboxOnce` et les fonctions SQL réelles de la migration 027, avec les migrations préalables 001, 002, 005, 006, 019, 020 et 026. BullMQ et ioredis proviennent des dépendances verrouillées de `karta/package-lock.json`.

La livraison reprend la [composition PR45](https://github.com/puramapro-oss/purama-ai/pull/45), base `f039a882b6b40aa4f45b5d340b3da149eb40597a`. Les sources du produit et les migrations sont conservées. Le composant PostgreSQL existant est réutilisé ; ses 17 contrôles SQL ne sont pas recopiés.

PostgreSQL et Redis utilisent chacun un socket Unix privé, sans écoute TCP. Le cluster PostgreSQL est initialisé et arrêté par le composant `Cluster` du harnais existant `qa/iao-runtime-20261110/native-outbox.py`. Redis est un processus enfant appartenant au présent essai, avec AOF et `appendfsync always`. Aucun service Mac, Hostinger, OVH ou de production n’est utilisé.

## Régressions du lanceur, sans serveur

```sh
python3 qa/approval-outbox-live-20261111/test_wrapper_lifecycle.py
```

Ces quatre contrôles Python utilisent des doubles inertes pour le cluster, l’enfant et les appels système. Ils n’exécutent aucun des six groupes natifs ci-dessous. La CI CHEF exécute seulement cette commande et conserve son reçu, avec les empreintes du lanceur et du test.

La contre-épreuve a reproduit trois échecs sur le lanceur initial, avec un contrôle valide réussi. Une erreur de découverte des sources ou d’empreinte pouvait laisser un répertoire détenu sans reçu ; une erreur de signal enfant pouvait interrompre le nettoyage PostgreSQL et l’écriture du reçu. Après correction, les mêmes quatre tests réussissent : la préparation précède l’allocation du cluster, les nettoyages sont indépendants et le reçu conserve les causes d’échec. Ces résultats qualifient ce contrat du lanceur, pas la reprise PostgreSQL/Redis réelle.

## Scénarios natifs prévus

1. Redis indisponible laisse une intention SQL réessayable ; après reprise, un seul job est conservé. L’approbation déjà finalisée ne redevient pas réclamable et son journal parent reste identique.
2. Une perte d’accusé après une vraie écriture Redis ne crée pas un deuxième job. Redis est réellement arrêté brutalement puis redémarré avant la reprise.
3. Deux clients SQL distincts tentent une réclamation concurrente ; un seul obtient le bail et publie. Les PID PostgreSQL sont consignés ; les transactions de réclamation restent ouvertes 600 ms et une troisième connexion doit observer les deux transactions actives simultanément avant leur `COMMIT`.
4. Les jobs BullMQ terminés (`completed` et `failed`) sans reçu SQL restent conservés et bloquent une reprise aveugle.
5. Un reçu SQL correspondant à un run métier en état `error` est reconnu comme réception, sans devenir un succès métier.
6. Un redémarrage brutal de Redis et de PostgreSQL après publication préserve l’intention SQL, l’identité, l’horodatage et l’unicité du job.

Les contrôles vérifient aussi que les paramètres privés de l’action ne figurent pas dans le job Redis et qu’aucun appel HTTP n’est effectué.

## Limites explicites

- Le transport des RPC utilise `psql` sous `service_role` ; PostgREST, HTTP, OAuth et l’identité réellement déployée ne sont pas testés.
- Les consommateurs BullMQ sont des fixtures inertes. Le harnais ne lance pas le moteur métier complet, un fournisseur externe ou un effet financier.
- L’authentification de la base jetable comprend seulement `auth.users` et une fonction `auth.uid()` de fixture, comme le harnais PostgreSQL existant.
- La perte d’accusé est injectée après le retour d’une écriture réelle dans Redis. Le stockage, les fonctions SQL et l’algorithme du relais ne sont pas simulés.
- Entre certaines tentatives, seul `next_attempt_at` de l’intention de fixture est avancé pour éviter d’attendre le délai de reprise. Les statuts, identités et reçus attendus sont produits par les fonctions réelles.
- Redis utilise une file propre à chaque cas et un seul essai de consommateur pour atteindre les états terminaux. La politique complète des tentatives métier en production n’est pas qualifiée.
- Ce harnais ne constitue ni une qualification de production, ni une recette 24/7, ni une vérification de toutes les migrations de l’application.

## Exécution

Un nouveau répertoire de résultats est obligatoire ; le script refuse d’en réutiliser un.

```sh
python3 qa/approval-outbox-live-20261111/run.py \
  --repo /absolute/path/to/purama-ai \
  --pg-bin /absolute/path/to/postgresql/bin \
  --redis-server /absolute/path/to/redis-server \
  --output /absolute/path/to/new-native-result
```

Les sorties sont `native-run-receipt.json`, `native-protocol-results.json`, `execution.log`, `postgres.log` et `redis.log`. Le reçu enveloppe les empreintes des sources avant et après l’exécution, les commandes, les versions, les codes de sortie et le nettoyage. Un succès exige les six groupes réussis, aucune dérive des sources, aucun appel HTTP et l’arrêt des deux serveurs privés.

Le harnais refuse d’assimiler un refus de création de socket par l’environnement à un échec fonctionnel du produit. Un tel refus exige les permissions normales de l’environnement, sans changer les protections ou passer à un autre transport pour les contourner.

## Dépendance Redis utilisée pour cette campagne

Redis **7.4.10**, source officielle : <https://download.redis.io/releases/redis-7.4.10.tar.gz>.

SHA-256 officiel vérifié : `669ab6689b5e7d0c479e8d526ccbadae36b69a11370742ffe23822b9df8d85ba` ; registre primaire : <https://raw.githubusercontent.com/redis/redis-hashes/master/README>.

Compilation locale, un seul travail : `make -j1 MALLOC=libc BUILD_TLS=no OPTIMIZATION=-O1 redis-server`. Aucune installation système. La version utilisée est une dépendance de cet essai isolé, pas une prescription de version de production.

## État de la campagne du 11 novembre 2026

**Harnais : revue statique PASS. Exécution native : BLOQUÉE, zéro groupe exécuté sur six.** La première tentative a échoué au démarrage de PostgreSQL sur la création du socket Unix (`Operation not permitted`), avant les migrations, Redis et les assertions. Le cluster de cet essai a été nettoyé. La demande d’escalade normale a ensuite été rejetée automatiquement avant exécution ; aucun deuxième essai, autre transport ou autre hôte n’a été utilisé.

Le produit a été rapproché de la [PR44 existante](https://github.com/puramapro-oss/purama-ai/pull/44), tête `8c764d196e419228521b508161792d4b8174543f`, arbre `4abe36b80414611b0c20123590093adfdeac8f9b`. Sa [CI 42967515129](https://github.com/puramapro-oss/purama-ai/actions/runs/42967515129) a réussi 1 900 tests KARTA, le typage, la compilation et les contrôles du site. Les deux audits npm conditionnels restent ignorés. Cette CI ne lance pas le présent harnais et ne remplace pas sa qualification native.

Ce lot ajoute uniquement le harnais et son état vérifié ; le correctif produit de PR44 n’est pas dupliqué. Les 18 régressions indépendantes et leurs preuves causales sont archivées dans le dossier de vérification de cette campagne, sans ajouter un deuxième fichier de tests concurrent à la PR.
