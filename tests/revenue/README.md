# Ingestion Stripe et rapprochement des revenus

## Reprise locale PR22 + PR28 + PR40 — 11 novembre 2026

**Statut du gate revenus avec le SDK Stripe réel : BLOQUÉ avant les tests.**
La tentative locale bornée à 60 secondes a terminé avec la sortie 1 en 0,06 seconde :
`npm package not found in cache: "stripe", --cached-only is specified`.
Aucun test métier ni contrôle de types Deno de cette suite n’a démarré. Il ne
s’agit ni d’un délai dépassé ni d’un rejet métier du handler. Le SDK requis reste
exactement `stripe@18.5.0` ; les versions 17.7.0 et 21.0.1 disponibles ailleurs ne
l’ont pas remplacé. La vérification de signature par le SDK réel est conservée.

Les fixtures sont adaptées au contrat composé : UUID d’utilisateur, ligne locale
complète, lecture Auth par identifiant, client Stripe avec propriétaire et mode,
liste des abonnements, essai au terme futur et facture actuelle payée. Elles
remplacent seulement les transports et le stockage dans un environnement qui
interdit réseau et sous-processus.

Tous les scénarios de sécurité du donneur restent présents. Deux attentes
métier évoluent explicitement : le checkout utilise le catalogue connu et
n’accorde plus un second essai Stripe ; un auto-parrainage renvoie 400 avant toute
création de session, conformément au refus explicite des réductions invalides de
PR28. Les métadonnées d’attribution proviennent uniquement du serveur et sont
copiées à l’abonnement sans définir un droit à commission.

La reprise ajoute les cas suivants : facture courante absente, ouverte,
incohérente ou inaccessible sur les trois chemins de synchronisation ; ancien
abonnement annulé coexistant avec un autre abonnement ouvert ; listes fournisseur
incomplètes ou ambiguës ; facture d’un autre client ; références anciennes et
Basil contradictoires ; panne ou reçu manquant du journal avant tout effet ;
replay d’un checkout parrainé sans commission annuelle ni seconde activation.
L’ancien abonnement annulé avec un successeur ouvert renvoie 503, conserve le
journal et laisse les droits existants intacts. Aucun choix de propriétaire ou
recalcul historique n’est effectué par ces fixtures.

L'étape C ajoute l'identité `stripe_subscription_id` nullable et une révision
locale atomique. Les fixtures émulent le trigger d'incrément ; sa migration est
testée séparément sur le moteur SQL. Une répétition valide peut confirmer sa
version par une mise à jour de `updated_at` seulement : elle ne réattribue aucun
droit ni gain. L'assertion du replay distingue explicitement cette confirmation
de l'écriture des droits. Les cas Node avec barrières sont décrits dans le
[reçu C](../../docs/qa/billing-concurrency-reconciliation-20261111.md).

Les compteurs et références CI de la section historique ci-dessous appartiennent
au donneur. Ils ne qualifient pas cette composition. Les suites Node, commerce
natif et SQL disposent de reçus séparés ; elles ne remplacent pas ce gate de
signature réelle. Toute mise en production demeure hors du présent contrôle.

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
L'identifiant de coupon historique reste inchangé ; le checkout est désormais
une conversion payante explicite. L'essai sans carte est admis séparément par la
RPC atomique start_trial de PR28. Les caractéristiques actuelles du coupon chez
Stripe n'ont pas été relues ni approuvées par ce lot.

Ce journal n'est pas encore raccordé au calcul contractuel des commissions. Le
calcul de l'assiette, le rapprochement des frais, les reprises sur remboursement,
la disponibilité des fonds et le versement doivent disposer d'une source
commerciale explicite avant d'annoncer un système de commissions actif.
Tous les événements de ce journal restent explicitement `reconciliation=required`.

## Garde administrative et surfaces financières héritées

Ce lot reprend seulement la tranche finance de PR22. Les interfaces
d'administration, de portefeuille et de retrait ne sont pas qualifiées par les
tests de webhook. La migration canonique déjà présente
`20261110000100_commerce_privileges.sql` retire les
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
- Le téléchargement PDF est désormais un récapitulatif actuel non signé, sans
  assiette annuelle ni durée promotionnelle établie. Le tableau de bord affilié
  renvoie aux prix et conditions applicables. Le contrat original et sa preuve
  de signature restent à récupérer pour établir les conditions historiquement
  acceptées ; ce lot ne les réécrit pas et ne valide aucune nouvelle durée
  promotionnelle.
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
`trialing`, une annulation de l'identité actuellement liée rétablit le plan gratuit, et un produit inconnu
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
3. `20261111100000_subscription_projection_revision.sql`, après la migration
   d'essai atomique PR28 : identité Stripe nullable sans backfill, révision
   atomique de toute écriture et détachement de l'ancienne identité lors d'un
   essai local. Le client, l'éligibilité et la durée de l'essai restent conservés.
4. Déploiement de cette version du webhook après application réussie des migrations.

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

Le snapshot local (identifiant de ligne, utilisateur, client, abonnement Stripe,
révision) précède toute lecture fournisseur. La mise à jour conditionnelle et
son reçu doivent confirmer la révision suivante, produite par un trigger pour
tous les writers. `updated_at=now()` n'est pas traité comme une version. Même
une confirmation à droits inchangés avance la révision afin de bloquer une
observation concurrente devenue ancienne. Le CAS ne réessaie jamais une ancienne
observation en lui donnant simplement une version plus récente.

Les anciennes lignes conservent un identifiant Stripe NULL tant qu'une liaison
n'a pas été confirmée. Un état sans droits (annulé, expiré, impayé, suspendu ou incomplet) sans identité
correspondante demande un rapprochement et ne supprime pas un essai local. Seul
un état actif payé ou un essai fournisseur confirmé peut adopter une identité
différente. Une liste incomplète
ou plusieurs abonnements ouverts font échouer l'application sans modifier les
droits. Cette protection locale ne crée pas une transaction distribuée Stripe/DB :
un changement externe non encore observé reste à reprendre par livraison ou
réconciliation. Les API Stripe, la livraison effective des événements et les
politiques du Supabase réel restent à vérifier dans l'environnement de déploiement.

## Commandes reproductibles et historique du donneur

Les tests Deno importent les vrais handlers et le normaliseur, utilisent le SDK
Stripe 18.5.0 pour signer et vérifier les corps, et remplacent seulement le
transport HTTP et le client de stockage par des fixtures contrôlées. Le typecheck
reste actif. Aucun accès réseau ni sous-processus n'est autorisé pendant les tests.

La commande du workflow CI résout le SDK dans le cache npm de Deno, sans ajouter
Stripe au manifeste applicatif :

```sh
deno test --config tests/revenue/deno.json --node-modules-dir=none \
  --no-lock --no-prompt --deny-net --deny-run \
  --allow-env=STRIPE_SECRET_KEY,STRIPE_WEBHOOK_SECRET,SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,SUPABASE_ANON_KEY,PURAMA_BILLING_ORIGIN \
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
  --allow-env=STRIPE_SECRET_KEY,STRIPE_WEBHOOK_SECRET,SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,SUPABASE_ANON_KEY,PURAMA_BILLING_ORIGIN \
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
