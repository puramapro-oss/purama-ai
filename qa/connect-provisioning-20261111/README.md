# Connect : réservation durable et qualification bornée

## Périmètre

Le point de départ est la PR 51, tête `a4650f16942c6dd0d13eace1055b33a7c93c0f50`, intégrée au commit `85cfd25a44913c77720842ca7f73a661854a447b`. Le handler initial porte le blob Git `2862575141409212700e990ed2c7fc19600cb97f`. Les 95 tests commerce annoncés par cette contribution, dont neuf tests Connect, ne qualifient pas une intégration Stripe réelle.

La reproduction locale utilise le handler exact, débarrassé uniquement de ses types par Node 24.22.1, et des adaptateurs inertes. Trois séquences laissent deux comptes externes simulés pour une liaison : insertion refusée puis nouvelle demande, demandes concurrentes ayant lu l’absence de liaison, et création acceptée dont la réponse est perdue. Les contraintes uniques empêchent deux liaisons mais ne peuvent annuler une création externe. Deux témoins évitent une conclusion excessive : une insertion effectivement commise dont le reçu est perdu, et un échec de création de session, permettent de retrouver la liaison sans recréer le compte.

Le handler initial reflète également le message d’une exception et accepte un GET authentifié avec effets de création. Le candidat ferme ces deux chemins.

## Protocole proposé

Une seule RPC canonique résout la liaison et le journal privé avant chaque nouvelle AccountSession. Une liaison historique sans journal reste utilisable lorsqu’elle est confirmée. Une opération en quarantaine bloque aussi les sessions, même si une ancienne liaison demeure présente.

Avant Stripe, une opération unique par utilisateur est persistée avec un UUID opaque, les paramètres de création figés, la version d’API, l’empreinte privée du contexte de clé et l’échéance. La clé d’idempotence et la métadonnée de corrélation utilisent uniquement cet UUID. Une rotation de clé bloque la reprise d’une création indéterminée sous un autre contexte ; elle ne recrée pas un compte déjà lié et confirmé.

Le bail d’essai dure 60 secondes. Toute reprise applicative conserve l’opération, les paramètres et la clé. Le délai est de **23 heures**, avec une marge minimale de 15 secondes vérifiée sur les horaires émis par PostgreSQL et le temps monotone écoulé depuis la demande de réservation. La vérification précède immédiatement l’appel au SDK. La configuration fixe `timeout: 10000` et `maxNetworkRetries: 0` ; elle ne démontre pas l’absence de toute reprise interne ni une borne absolue de lecture du corps de réponse. Le code officiel du SDK 15.12.0 conserve une exception pour la première fermeture de connexion, et son client Fetch efface le timer après réception des en-têtes. Le comportement réel de ce transport et de ses délais/reprises reste **NON TESTÉ** ; les doubles qualifient le protocole applicatif.

La finalisation verrouille l’opération et l’utilisateur, puis confirme la liaison et l’état final dans une transaction. Elle est idempotente et n’écrase aucune liaison historique. Les identifiants fournisseur reçus sont conservés même en cas de contradiction. Un reçu non vérifié, plusieurs identifiants ou un conflit de liaison imposent un rapprochement explicite ; une nouvelle requête ne les transforme pas automatiquement en succès. Un reçu vérifié tardif de la même opération expirée peut finaliser un succès connu, sans nouvelle création fournisseur.

Après expiration, aucune nouvelle opération et aucune nouvelle création Stripe ne sont lancées automatiquement. Aucun compte Stripe n’est supprimé en compensation. La disparition d’un utilisateur ne détruit pas le journal de l’opération : si elle gagne la course, le reçu reste privé et aucune liaison n’est recréée.

La table n’est accessible directement ni à `anon`, ni à `authenticated`, ni à `service_role`. Seules les deux RPC explicitement accordées à `service_role` utilisent leurs privilèges de définition. Leurs objets sont qualifiés, leur `search_path` est borné et les identités/paramètres/échéances sont protégés contre les mises à jour. Le délai d’attente des verrous est borné. Les réponses et journaux du handler ne contiennent pas l’objet d’exception ni son message interne.

## Vérifications et limites

- **PASS local : 25 tests Node/VM**, soit les neuf gardes Connect conservées et seize nouvelles régressions. Les assertions restent strictes ; le harnais local adapte seulement les objets de plateforme aux domaines d’exécution Node/VM. Ce résultat n’est pas une exécution Deno.
- **Préparé : tests Deno natifs**, dans `tests/commerce/connect-handler.test.ts` et `tests/commerce/connect-provisioning.test.ts`, avec l’import map existante et interdiction du réseau et des sous-processus. La CI doit produire la preuve native ; ne pas lui transférer le succès Node/VM.
- **Préparé : 20 scénarios PostgreSQL natifs**, dont six courses avec attente de verrou réellement observée par `pg_stat_activity`. Le harnais teste les rôles, les champs immuables, les fenêtres après attente, les collisions, la finalisation, les reçus perdus et la suppression concurrente d’un utilisateur. Un binaire absent ou un contrôle/arrêt incomplet produit un échec, jamais un skip réussi.
- **PASS de préparation :** syntaxe Python, empreintes des sources et refus explicite sans PostgreSQL installé. L’exécution PostgreSQL native reste à obtenir en CI.

Commande du harnais natif, exclusivement dans un environnement de qualification avec binaires déjà installés :

```sh
python3 tests/commerce/connect-provisioning-postgres.py \
  --pg-bin /usr/lib/postgresql/16/bin \
  --report /tmp/connect-provisioning-result.json
```

Il crée son propre répertoire et cluster, utilise un socket privé, désactive TCP, vérifie l’identité du serveur, puis arrête uniquement ses processus. Il n’efface son répertoire qu’après preuve d’arrêt. Il charge les deux migrations historiques Connect identifiées par leur blob et la migration candidate détectée relativement au script ; son reçu consigne les empreintes.

**NON TESTÉ à ce stade :** PostgREST/Supabase déployé, création Stripe réelle, acceptation du mélange historique `type: express` / contrôleur sans Dashboard, KYC, responsabilités et frais fournisseur. Le SDK `15.12.0`, l’API `2025-09-30.clover`, les choix financiers et les composants restent ceux du code existant. Aucun paiement, transfert, déploiement de fonction ou migration de production n’a été réalisé par cette préparation.

Avant une mise en production, appliquer le protocole et sa migration dans un environnement qualifié, fermer la coexistence avec les anciennes créations non protégées et vérifier le transport fournisseur. Le journal contient notamment l’adresse email figée nécessaire à la requête initiale : sa rétention et sa purge après rapprochement/suppression d’utilisateur doivent être définies avec les responsables des données. Cette modification n’invente aucune durée légale ni procédure de conservation indéfinie. Les sessions déjà émises et leur expiration restent une responsabilité de l’intégration fournisseur.

## Références primaires

[Stripe, idempotence API v1](https://docs.stripe.com/api/idempotent_requests) précise la réutilisation de la même clé avec les mêmes paramètres, la conservation de la réponse initiale y compris certains échecs, et l’élagage possible après au moins 24 heures. Une clé statique par utilisateur ne suffit donc pas à garantir une reprise durable.

[Stripe, erreurs de bas niveau](https://docs.stripe.com/error-low-level) distingue les résultats indéterminés après incident réseau ou erreur serveur et recommande de persister la clé d’opération, de conserver les paramètres et de rapprocher les résultats inconnus avant de recommencer. La métadonnée opaque permet de rattacher un reçu au journal local ; elle ne remplace pas la vérification de l’identité du fournisseur ou d’une signature webhook.

Sources exactes du transport conservé : [RequestSender.ts, stripe-node v15.12.0](https://github.com/stripe/stripe-node/blob/v15.12.0/src/RequestSender.ts), blob `d69c3c0b87d959efbbeef7ac8c0f7e1354d8d8a2`, et [FetchHttpClient.ts](https://github.com/stripe/stripe-node/blob/v15.12.0/src/net/FetchHttpClient.ts), blob `bea479b463de1e985ff09c0fbd746ecb39d0adf0`. Leur lecture est une preuve de configuration et de portée, pas une qualification fournisseur en fonctionnement.
