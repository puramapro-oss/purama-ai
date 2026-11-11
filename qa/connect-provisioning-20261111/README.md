# Connect : réservation durable et qualification bornée

## Périmètre

Le point de départ est la PR 51, tête `a4650f16942c6dd0d13eace1055b33a7c93c0f50`, intégrée au commit `85cfd25a44913c77720842ca7f73a661854a447b`. Le handler initial porte le blob Git `2862575141409212700e990ed2c7fc19600cb97f`. Les 95 tests commerce annoncés par cette contribution, dont neuf tests Connect, ne qualifient pas une intégration Stripe réelle.

La reproduction locale utilise le handler exact, débarrassé uniquement de ses types par Node 24.22.1, et des adaptateurs inertes. Trois séquences laissent deux comptes externes simulés pour une liaison : insertion refusée puis nouvelle demande, demandes concurrentes ayant lu l’absence de liaison, et création acceptée dont la réponse est perdue. Les contraintes uniques empêchent deux liaisons mais ne peuvent annuler une création externe. Deux témoins évitent une conclusion excessive : une insertion effectivement commise dont le reçu est perdu, et un échec de création de session, permettent de retrouver la liaison sans recréer le compte.

Le handler initial reflète également le message d’une exception et accepte un GET authentifié avec effets de création. Le candidat ferme ces deux chemins.

## Protocole proposé

Une seule RPC canonique résout la liaison et le journal privé avant chaque nouvelle AccountSession. La migration corrective `20261111203000_connect_provisioning_admission_gates.sql` préserve les données existantes et remplace cette résolution : une liaison historique sans journal attesté exige un rapprochement, même si son `user_id` correspond. Une opération en quarantaine bloque aussi les sessions, même si une ancienne liaison demeure présente.

**Création fermée dans le handler servi.** La configuration historique mélange Express et un contrôleur sans Dashboard, avec collecte des exigences par Stripe et pertes à la charge de l’application. Cette combinaison n’est pas qualifiée et n’est pas remplacée par un choix financier arbitraire. Le handler transmet `p_parameters: null`, mode de résolution seule du même RPC : aucun nouvel intent, aucune reprise d’un intent pending, aucun renouvellement de bail et aucune création Stripe. Aucun champ HTTP ni paramètre d’environnement ne l’active. Un compte déjà lié reste accessible uniquement si le journal, la liaison, l’opération, la version d’API et le contexte fournisseur concordent.

Le protocole de création est qualifié séparément, hors ligne, avec une politique synthétique injectée explicitement dans la factory de tests. Avant Stripe, une opération unique par utilisateur est persistée avec un UUID opaque, les paramètres de création figés, la version d’API, l’empreinte privée du contexte de clé et l’échéance. La clé d’idempotence et la métadonnée de corrélation utilisent uniquement cet UUID. L’empreinte est conservatrice : un changement de clé bloque aussi une session sur une liaison bound, sans modifier cette liaison. Une rotation vers le même compte et le même mode doit être requalifiée ; cette correction ne fournit pas de procédure automatique pour modifier le contexte immuable.

Le bail d’essai dure 60 secondes. Toute reprise applicative conserve l’opération, les paramètres et la clé. Le délai est de **23 heures**, avec une marge minimale de 15 secondes vérifiée sur les horaires émis par PostgreSQL et le temps monotone écoulé depuis la demande de réservation. La vérification précède immédiatement l’appel au SDK. La configuration fixe `timeout: 10000` et `maxNetworkRetries: 0` ; elle ne démontre pas l’absence de toute reprise interne ni une borne absolue de lecture du corps de réponse. Le code officiel du SDK 15.12.0 conserve une exception pour la première fermeture de connexion, et son client Fetch efface le timer après réception des en-têtes. Le comportement réel de ce transport et de ses délais/reprises reste **NON TESTÉ** ; les doubles qualifient le protocole applicatif.

La finalisation verrouille l’opération et l’utilisateur, puis confirme la liaison et l’état final dans une transaction. Elle est idempotente et n’écrase aucune liaison historique. Les identifiants fournisseur reçus sont conservés même en cas de contradiction. Un reçu non vérifié, plusieurs identifiants ou un conflit de liaison imposent un rapprochement explicite ; une nouvelle requête ne les transforme pas automatiquement en succès. Un reçu vérifié tardif de la même opération expirée peut finaliser un succès connu, sans nouvelle création fournisseur.

Après expiration, aucune nouvelle opération et aucune nouvelle création Stripe ne sont lancées automatiquement. Aucun compte Stripe n’est supprimé en compensation. La disparition d’un utilisateur ne détruit pas le journal de l’opération : si elle gagne la course, le reçu reste privé et aucune liaison n’est recréée.

Le journal n’est accessible directement ni à `anon`, ni à `authenticated`, ni à `service_role`. Seules les deux RPC explicitement accordées à `service_role` utilisent leurs privilèges de définition. Les INSERT, changements d’identité, DELETE et TRUNCATE directs de `connect_accounts` sont aussi révoqués pour `service_role`, y compris les anciens grants par colonne. Ce rôle conserve SELECT et la mise à jour des seuls champs d’état serveur : onboarding, capacités, KYC, exigences et date de mise à jour. La finalisation canonique reste le seul écrivain applicatif des identités.

Les objets SQL sont qualifiés, leur `search_path` est borné et les identités/paramètres/échéances du journal sont protégés contre les mises à jour. Le délai d’attente des verrous est borné. Les réponses et journaux du handler ne contiennent pas l’objet d’exception ni son message interne. Une AccountSession doit confirmer le compte demandé, fournir un secret non vide et une expiration entière future avant tout succès HTTP ; la réponse porte `Cache-Control: no-store`.

## Vérifications et limites

- **PASS local : 34 tests Deno natifs**, dans `tests/commerce/connect-handler.test.ts` et `tests/commerce/connect-provisioning.test.ts`, avec l’import map existante et interdiction du réseau et des sous-processus. Les cas de création utilisent explicitement une politique synthétique et des ports inertes ; le handler réellement servi est testé séparément avec sa création fermée.
- **PASS local : 31 scénarios PostgreSQL natifs**, dont six courses avec attente de verrou réellement observée par `pg_stat_activity`, sur PostgreSQL 18.6. Les onze nouvelles gardes appliquent la migration corrective deux fois sans altérer les données bound/pending/legacy ; elles vérifient la résolution seule, le contexte des liaisons confirmées, les grants par table/colonne/PUBLIC et 21 refus DML réels. Les six champs d’état serveur et la lecture utilisateur restent autorisés.
- Le transport local remplace uniquement psql et le socket par pg 8.23.1 et une connexion loopback à un cluster jetable dont l’identité est vérifiée. Les SQL et assertions du dépôt sont exécutés sans substitution. Arrêt du cluster, suppression du répertoire et fermeture du port sont vérifiés. Le workflow existant utilise psql et PostgreSQL 16 ; sa CI sur cette correction reste à observer. Un binaire absent ou un contrôle/arrêt incomplet produit un échec, jamais un skip réussi.

Commande du harnais natif, exclusivement dans un environnement de qualification avec binaires déjà installés :

```sh
python3 tests/commerce/connect-provisioning-postgres.py \
  --pg-bin /usr/lib/postgresql/16/bin \
  --report /tmp/connect-provisioning-result.json
```

Le harnais CI crée son propre répertoire et cluster, utilise un socket privé, désactive TCP, vérifie l’identité du serveur, puis arrête uniquement ses processus. Il n’efface son répertoire qu’après preuve d’arrêt. Il charge les deux migrations historiques Connect identifiées par leur blob, la migration de réservation durable puis la migration corrective détectées relativement au script ; son reçu consigne les empreintes.

**NON TESTÉ à ce stade :** PostgREST/Supabase déployé, intégration réelle SDK `15.12.0` / API `2025-09-30.clover`, création Stripe réelle, KYC, responsabilités et frais fournisseur. Les tests Deno chargent des types et adaptateurs inertes ; ils ne qualifient pas le SDK distant. Aucun choix financier de remplacement n’est adopté et aucune création n’est activée. Aucun paiement, transfert, déploiement de fonction ou migration de production n’a été réalisé par cette préparation.

Avant toute admission, retirer les anciens handlers et écrivains, traiter leurs requêtes déjà parties et qualifier l’ordre de déploiement avec le handler fermé. Une permission SQL refusée ne peut empêcher un ancien handler d’envoyer d’abord une requête à Stripe. Vérifier ensuite les migrations et permissions effectivement déployées, la provenance des anciennes liaisons, le contexte fournisseur, le transport et la politique financière retenue. Ces gates ne sont pas remplacées par un indicateur d’environnement. Les résultats incertains et les rotations exigent une procédure de rapprochement qualifiée ; aucun nouvel identifiant d’opération n’est créé automatiquement.

Le journal contient notamment l’adresse email figée nécessaire à la requête initiale, y compris après finalisation ou suppression de l’utilisateur : sa rétention et sa purge doivent être définies avec les responsables des données. Elles ne sont pas implémentées par ce correctif. Aucune durée légale ni conservation indéfinie n’est inventée. Les sessions déjà émises et leur expiration restent une responsabilité de l’intégration fournisseur.

## Références primaires

[Stripe, migration vers les propriétés de contrôleur](https://docs.stripe.com/connect/migrate-to-controller-properties) documente notamment l’incompatibilité du Dashboard `none` avec collecte des exigences par Stripe et pertes à la charge de l’application. La création historique reste fermée jusqu’à qualification explicite de ces choix.

[Stripe, idempotence API v1](https://docs.stripe.com/api/idempotent_requests) précise la réutilisation de la même clé avec les mêmes paramètres, la conservation de la réponse initiale y compris certains échecs, et l’élagage possible après au moins 24 heures. Une clé statique par utilisateur ne suffit donc pas à garantir une reprise durable.

[Stripe, erreurs de bas niveau](https://docs.stripe.com/error-low-level) distingue les résultats indéterminés après incident réseau ou erreur serveur et recommande de persister la clé d’opération, de conserver les paramètres et de rapprocher les résultats inconnus avant de recommencer. La métadonnée opaque permet de rattacher un reçu au journal local ; elle ne remplace pas la vérification de l’identité du fournisseur ou d’une signature webhook.

Sources exactes du transport conservé : [RequestSender.ts, stripe-node v15.12.0](https://github.com/stripe/stripe-node/blob/v15.12.0/src/RequestSender.ts), blob `d69c3c0b87d959efbbeef7ac8c0f7e1354d8d8a2`, et [FetchHttpClient.ts](https://github.com/stripe/stripe-node/blob/v15.12.0/src/net/FetchHttpClient.ts), blob `bea479b463de1e985ff09c0fbd746ecb39d0adf0`. Leur lecture est une preuve de configuration et de portée, pas une qualification fournisseur en fonctionnement.
