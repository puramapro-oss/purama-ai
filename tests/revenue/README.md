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

Ce journal n'est pas encore raccordé au calcul contractuel des commissions. Le
calcul de l'assiette, le rapprochement des frais, les reprises sur remboursement,
la disponibilité des fonds et le versement doivent disposer d'une source
commerciale explicite avant d'annoncer un système de commissions actif.
Tous les événements de ce journal restent explicitement `reconciliation=required`.

## Garde administrative et surfaces financières héritées

Le hook `useInfluencerAdmin` n'expose plus de mutation `markCommissionPaid`.
L'administration explique le raccordement manquant et n'annonce pas de versement.
La migration canonique `20261110000100_commerce_privileges.sql` retire aussi les
écritures financières des rôles clients, y compris des administrateurs
applicatifs : un clic ou une écriture directe authentifiée ne peut marquer une
commission payée. Les lectures historiques autorisées restent disponibles.
Les tests de ces privilèges sont dans `karta/test/commercePrivileges.test.ts` ;
aucun test de mutation administrative supprimée n'est conservé en parallèle.

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
  de compte Stripe idempotente. La migration canonique
  `20260919160000_connect_accounts_server_writes.sql` réserve désormais les
  écritures de rattachement au serveur ; elle ne confirme pas la provenance des
  liaisons historiques. Le parcours de création de compte reste à qualifier.

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
Après l'accusé de persistance du journal, le helper canonique `applyOveragePayment`
valide l'utilisateur, la session complète, le PaymentIntent, l'événement signé,
le montant, la devise et le mode. Il appelle l'unique RPC `credit_overage_pack`,
qui conserve le quota historique de 2 000 actions et le mois UTC du paiement
confirmé. La migration et le helper canoniques sont repris sans modification.

Un replay strictement cohérent rend le reçu initial sans accorder de nouvelles
actions. Une session déjà créditée avec une preuve différente ou une ligne
historique dépourvue de preuve provoque un conflit explicite et reste intacte.
Deux événements distincts ne sont donc acceptés comme répétition économique que
si leurs preuves correspondent ; aucune preuve ni date n'est inventée pour
rendre un ancien crédit réutilisable.

## Migration et exploitation

L'ordre d'intégration est :

1. `20261110000200_overage_credit_idempotency.sql` : preuve, unicité des sessions
   et événements de paiement, RPC canonique des packs.
2. `20261110100000_stripe_reconciliation_events.sql` : journal append-only,
   RPC d'ajout et unicité des clients Stripe non vides pour les abonnements.
3. Déploiement de cette version du webhook après application réussie des migrations.

Le journal a une version de migration distincte. Il ne recrée ni l'index overage
ni un second writer de crédits. Les clients anonymes et authentifiés ne peuvent
ni lire le journal ni appeler ses fonctions d'écriture. Le rôle serveur lit le
journal, mais n'a aucun droit direct d'insertion, modification ou suppression de
ses observations ; l'ajout passe par la RPC dédiée.

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
transport HTTP et le client de stockage par des fixtures contrôlées. Le typecheck
reste actif. Aucun accès réseau ni sous-processus n'est autorisé pendant les tests.

La commande du workflow CI résout le SDK dans le cache npm de Deno, sans ajouter
Stripe au manifeste applicatif :

```sh
deno test --config tests/revenue/deno.json --node-modules-dir=none \
  --no-lock --no-prompt --deny-net --deny-run \
  --allow-env=STRIPE_SECRET_KEY,STRIPE_WEBHOOK_SECRET,SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,SUPABASE_ANON_KEY \
  tests/revenue/webhook.test.ts
```

Dans l'environnement local de qualification, la résolution initiale de
`https://registry.npmjs.org/stripe` a été refusée avant le démarrage des tests
(`Connection refused`). Le [run CI initial 42918981402](https://github.com/puramapro-oss/purama-ai/actions/runs/42918981402)
a ensuite téléchargé Stripe 18.5.0 depuis le registre npm avec
`node-modules-dir=none`, puis exécuté **30 tests réussis, aucun échec**. La
résolution normale sur runner est donc prouvée pour cette révision, même si le
job site a échoué plus tard au lancement de son navigateur.

Pour la qualification locale initiale, le SDK 18.5.0 avait été installé dans un
runtime de test séparé, puis lié dans `node_modules`. L'override local
effectivement exécuté emploie la même configuration versionnée, sans import map
externe :

```sh
deno test --config tests/revenue/deno.json --node-modules-dir=manual \
  --cached-only --no-remote --no-lock --no-prompt --deny-net --deny-run \
  --allow-env=STRIPE_SECRET_KEY,STRIPE_WEBHOOK_SECRET,SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,SUPABASE_ANON_KEY \
  tests/revenue/webhook.test.ts
```

La qualification locale initiale du commit
`07faa21e353df0d84bf1059a0d4d01d75cf79b73`, le 10 novembre 2026, donne **30 tests
réussis, aucun échec**. La première exécution avait détecté la perte du refus
d'auto-parrainage dans le checkout lors de la composition : **29 réussis, 1 échec**.
La condition existante a été restaurée, puis les 30 tests ont été réexécutés avec
succès. Ces résultats ne prouvent pas l'intégration aux services de production.

Les tests SQL exécutent les deux migrations et leurs RPC dans **PGlite 0.5.8**,
version du lock Karta réellement utilisée. Cette dépendance de test peut être
fournie par son chemin de module, sans modifier le manifeste applicatif :

```sh
PGLITE_MODULE=/chemin/runtime-test/node_modules/@electric-sql/pglite/dist/index.js \
  node --test --test-isolation=none --test-concurrency=1 --test-reporter=tap \
  tests/revenue/inbox-sql.test.mjs
```

Résultat local : **23 tests réussis, aucun échec**. Ils couvrent les permissions,
l'unicité, les erreurs, les répétitions, les rollbacks et la préservation des
anciennes valeurs. Ils appliquent la migration overage canonique avant celle du
journal, contrôlent l'absence du writer parallèle et vérifient qu'un échec du
journal ne retire pas une migration overage déjà appliquée. PGlite exécute le SQL
PostgreSQL dans WASM ; ce résultat ne remplace pas un test de concurrence entre
plusieurs connexions PostgreSQL natives.

La suite canonique Karta exécute aussi le handler complet, le normaliseur et les
deux RPC SQL, avec panne puis reprise du journal et perte de reçu après
persistance. Aucun socket, compte prestataire, email ou paiement réel n'est
utilisé. Depuis le répertoire `karta`, avec ses dépendances de test disponibles :

```sh
NODE_OPTIONS=--max-old-space-size=384 \
  node node_modules/vitest/vitest.mjs run test/overageCredit.test.ts \
  --pool=threads --maxWorkers=1 --no-file-parallelism
```

Résultat local avec **Vitest 5.0.3** : **40 tests réussis, aucun échec**. La première
tentative avec le pool `forks` s'était arrêtée sur un worker tué par `SIGKILL`,
sans résultat métier exploitable. Le passage à un seul worker `threads` a permis
l'exécution complète, sans modifier les assertions.

Les compteurs locaux ci-dessus appartiennent exclusivement au commit
`07faa21e353df0d84bf1059a0d4d01d75cf79b73`. La référence de fusion testée par la CI,
`a1cae9b6f93875e410e23f7011957f78c824630c`, possède le même arbre Git
`0151628a38da0b31cb06a6407e4f29b75625a068`, égalité vérifiée directement. Les
résultats CI ne sont pas additionnés aux résultats locaux ni transférés à une
correction ultérieure.

Les corrections et les gates restants de cette première CI sont détaillés dans
[le rapport promotion](../../qa/paid-promotion-20261110/REPORT.md) et son manifeste
de validation. Les compteurs financiers ci-dessus ne sont pas présentés comme
une revalidation de ces nouveaux changements.

Le déploiement, les secrets réels, la livraison Stripe et les privilèges du
Supabase de production restent à vérifier dans cet environnement.
