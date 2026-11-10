# Ingestion Stripe et rapprochement des revenus

## Périmètre de ce lot

Le webhook vérifie la signature sur le corps original avant de conserver une
observation Stripe. Le journal `purama_ai.stripe_reconciliation_events` est
append-only : il ne constitue ni un portefeuille, ni un droit à commission, ni une
autorisation de versement. Sa clé comprend le compte émetteur, le mode test/live et
l'identifiant d'événement. Deux événements concernant la même facture restent deux
observations, jamais deux droits financiers.

Les montants observés restent dans l'unité monétaire minimale de leur devise. Le
normaliseur conserve les références anciennes et Basil, remises et taxes
disponibles, paiements, retours et signes d'incomplétude. Il ne déduit aucun montant
HT à partir d'un TTC, aucun taux de TVA, aucun taux de commission et aucune durée
promotionnelle. Les listes tronquées demandent un rapprochement avec la source.

La création anticipée d'une commission annuelle au checkout et sa validation
globale au premier paiement sont supprimées. Les anciennes commissions, statuts,
taux et statistiques ne sont pas recalculés. Les notifications de nouveaux gains
non prouvés sont retirées du webhook. Les métadonnées d'attribution résolues côté
serveur sont copiées vers l'abonnement, sans y ajouter de politique commerciale.
L'identifiant de coupon historique et l'essai de 14 jours du checkout restent
inchangés ; les caractéristiques actuelles du coupon chez Stripe n'ont pas été
relues ni approuvées par ce lot.

Le schéma commercial canonique ONE n'est pas présent dans ce dépôt. Le calcul
contractuel, l'assiette retenue, le rapprochement des frais, les reprises de
commission sur remboursement, la disponibilité des fonds et le versement doivent
être raccordés à cette source avant d'annoncer un système de commissions actif.
Tous les événements de ce journal restent explicitement `reconciliation=required`.

## Garde administrative et surfaces financières héritées

Le hook `useInfluencerAdmin().markCommissionPaid` refuse désormais toute tentative
de changement de statut : il ne contacte ni la base ni un prestataire et affiche
« Paiement non confirmé ». La page d'administration retire le dialogue de
confirmation, désactive le bouton et explique le raccordement manquant. Son
agrégat issu de `influencers.total_revenue` est nommé « Revenus enregistrés », car
cette valeur ne fournit aucune preuve de virement. Les lignes historiques restent
consultables. La signature du hook est conservée pour un futur endpoint de
règlement confirmé côté serveur.

Cette garde applicative ne révoque pas la policy SQL historique autorisant les
administrateurs à modifier directement les commissions. Un durcissement des
privilèges ou un règlement manuel audité exige un lot coordonné ; il ne faut pas
présenter cette interface comme une garantie d'immutabilité de toute la base.

Les autres limites observables dans le dépôt restent explicites :

- `Wallet.tsx` nomme `wallets.balance` « Solde disponible » et
  `useRequestWithdrawal` insère une demande dans `withdrawals`, puis annonce un
  traitement sous 3 à 5 jours. Ce chemin ne rapproche pas le solde Stripe et
  n'ordonne aucun transfert ou virement dans le code examiné.
- Le contrat PDF contient encore une assiette annuelle, et le tableau de bord
  affilié décrit encore une remise sur la première année. Ce lot ne réécrit pas
  ces engagements historiques et ne valide aucune nouvelle durée promotionnelle.
- Le journal Stripe n'a pas de consommateur vers les commissions ONE dans ce
  dépôt. Les remboursements et litiges sont conservés pour rapprochement, sans
  annuler automatiquement un droit historique.
- L'ancien endpoint `connect-account-session` crée une session d'interface Stripe
  Connect ; ce n'est pas un calcul de commission ni un financement du compte. Il
  ignore encore certaines erreurs de liaison en base et ne rend pas la création
  de compte Stripe idempotente. La policy fournie pour `connect_accounts` ne
  réserve pas l'identifiant Stripe au serveur. Ce parcours n'est pas qualifié par
  les tests du présent lot et nécessite une revue avant activation financière.

## Abonnements et packs existants

La synchronisation d'abonnement utilise les métadonnées serveur et un lien client
Stripe cohérent, sans rechercher un utilisateur par email. En l'absence de
métadonnées, seul un lien client existant et unique permet de retrouver le compte.
Le webhook relit l'état actuel de l'abonnement chez Stripe : un essai reste
`trialing`, une annulation confirmée rétablit le plan gratuit, et un produit inconnu
ou ambigu ne devient jamais implicitement `pro`. Les erreurs de lecture/écriture
SQL et les mises à jour ne confirmant aucune ligne renvoient 503.

Les événements d'un compte Connect non mappé et les événements dont le mode
diffère de celui de la clé configurée sont conservés sans modifier les abonnements
de la plateforme ; la réponse indique `application=deferred` et sa raison.

Un pack de dépassement n'est crédité qu'après un checkout effectivement `paid`.
La RPC `apply_stripe_overage_credit` vérifie l'observation déjà enregistrée et
accorde les 2 000 actions existantes une seule fois par session de checkout, même
si `completed` et `async_payment_succeeded` arrivent tous deux. Elle conserve le
mois d'un ancien crédit lors d'un replay. Une preuve manquante ou un bénéficiaire
historique différent provoque un échec explicite.

## Migration et exploitation

La migration `20261110000200_stripe_reconciliation_events.sql` doit être appliquée
avant de déployer cette version du webhook. Elle crée le journal, ses RPC limitées
au rôle serveur et deux index uniques : session de checkout pour les packs, client
Stripe non vide pour le rattachement d'abonnement. Les clients anonymes et
authentifiés ne peuvent ni lire le journal ni appeler ses fonctions d'écriture.
Le rôle serveur lit le journal, mais n'a aucun droit direct d'insertion,
modification ou suppression de ses observations ; l'ajout passe par sa RPC.

Si des doublons historiques existent, la migration entière échoue et se retire
sans supprimer de ligne ni choisir arbitrairement un propriétaire. Ces doublons
doivent être rapprochés avant un déploiement. Aucune migration, configuration
Stripe ou opération bancaire n'a été exécutée en production dans cette validation.

Un échec de persistance ou d'application contrôlée renvoie un statut non 2xx pour
permettre le réessai. L'observation financière peut donc être enregistrée alors
qu'une synchronisation d'abonnement attend encore sa réussite. La réponse HTTP ne
doit pas être interprétée comme une commission validée ou un paiement effectué.

La relecture de l'état actuel réduit le risque des événements retardés ; elle ne
crée pas une garantie d'ordre strict entre appels concurrents. La table historique
d'abonnements ne porte ni identifiant d'abonnement Stripe ni version d'événement.
La coexistence de plusieurs abonnements pour un même client et leur orchestration
complète restent à traiter dans le moteur canonique. Les API Stripe, les secrets,
la livraison effective des événements et les politiques du Supabase réel restent
à vérifier dans l'environnement de déploiement.

## Tests reproductibles

Les tests Deno importent les vrais handlers et le normaliseur, utilisent le SDK
Stripe 18.5.0 pour signer et vérifier les corps, et remplacent seulement le
transport HTTP et le client de stockage par des fixtures contrôlées. Aucun accès
réseau n'est permis pendant l'exécution des tests. Une connexion au registre peut
être nécessaire lors de la résolution initiale du SDK :

```sh
deno test --config tests/revenue/deno.json \
  --allow-env=STRIPE_SECRET_KEY,STRIPE_WEBHOOK_SECRET,SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,SUPABASE_ANON_KEY \
  tests/revenue/webhook.test.ts
```

La validation locale du 10 novembre 2026 a utilisé Deno 2.9.6, un SDK installé dans
un runtime de test séparé et un import map local équivalent avec
`nodeModulesDir=manual`, ainsi que `--cached-only --no-remote`. Le typecheck était
actif : **30 tests réussis, aucun échec**. Cela vérifie les signatures réelles et
les branches applicatives contre les fixtures, sans prouver une intégration aux
services en production.

Les tests SQL exécutent la migration et ses RPC dans PGlite 0.5.16. Cette dépendance
de test peut être installée hors du manifeste applicatif, puis fournie par son
chemin de module :

```sh
PGLITE_MODULE=/chemin/runtime-test/node_modules/@electric-sql/pglite/dist/index.js \
  node --test --test-isolation=none --test-reporter=tap tests/revenue/inbox-sql.test.mjs
```

Résultat local : **23 tests réussis, aucun échec**. Les tests couvrent permissions,
unicité, erreurs, replay, rollback de transaction, migration refusée sur doublons
et préservation des anciennes valeurs. PGlite exécute le SQL PostgreSQL réel dans
WASM ; ce résultat ne remplace pas un test de concurrence entre plusieurs
connexions PostgreSQL natives. Le mode sans isolation supplémentaire évite de
dupliquer inutilement le runtime de test en mémoire.

La garde administrative dispose aussi d'un test comportemental léger. Vite charge
le vrai hook avec son environnement d'import habituel ; les dépendances React
Query, Supabase et notifications sont injectées. Deux demandes de marquage sont
refusées sans appel DB/RPC ni notification de succès : **1 test réussi**.

```sh
node --test --test-isolation=none tests/revenue/admin-payment.test.mjs
```

Ce test ne simule aucun virement et ne remplace pas une vérification des droits
réels de la base de production.
