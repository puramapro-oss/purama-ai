# Vérification du webhook Stripe — 11 novembre 2026

## Périmètre et commande

Le banc exécute les véritables `stripe-webhook/index.ts`, `overage.ts` et le normaliseur `stripe-reconciliation.ts` dans une VM Node. Les frontières Stripe, Supabase Auth/DB et signature sont inertes ; serveur, imports et réseau sont contrôlés. Ce banc ne prouve pas la cryptographie Stripe ni le schéma déployé. Les migrations SQL ont des tests séparés sur PGlite et un gate PostgreSQL natif en CI.

```sh
npm run test:billing
node --test --test-concurrency=1 --test-timeout=3000 tests/billing-webhook/concurrency.test.mjs
```

La commande complète compte **156 tests PASS**, incluant les endpoints checkout/portail, le webhook, les frontières de modules et **18 cas de concurrence/contrat**. Aucun test n'est ignoré ou annulé. Chaque test a une limite de 3 secondes ; les barrières de concurrence ont leur propre limite de 1 seconde. Un timeout de fixture/runner est un échec, pas un rejet réussi du handler.

Les reçus historiques A et B et le reçu de [l'étape C](../../docs/qa/billing-concurrency-reconciliation-20261111.md) distinguent les sources et résultats. Les 65 tests du donneur initial ne sont plus le compteur de cette composition.

## Contrats conservés

- Configuration Stripe au préfixe `sk_test_`, `rk_test_`, `sk_live_` ou `rk_live_` connu avant tout effet ; un préfixe inconnu renvoie 503 sans journal, fournisseur, droit ou crédit. Les modes opposés des quatre variantes restent différés explicitement.
- Identité signée résolue par `auth.admin.getUserById`, avec métadonnées serveur concordantes ou liaison client existante unique. Aucun email ni catalogue Auth paginé ne prouve la propriété.
- Client, mode, produit, nombre d'abonnements ouverts et pagination vérifiés. Les mappings Starter/Pro/Ultime et le coupon historique restent inchangés.
- Aucun droit actif pour un checkout impayé. Un paiement différé attend son événement de réussite ; `active` exige toujours la facture actuelle relue `paid` pour le bon client, y compris une remise intégrale.
- Essai fournisseur au terme fixe vérifié ; le marqueur consommé n'est jamais remis à faux. Une activation payante conserve l'historique d'essai local.
- Signature avant observation durable, puis seulement effets applicatifs. Panne de journal, preuve contradictoire, perte de reçu ou écriture sans confirmation : HTTP 503 avec message public générique.
- Pas de commission annuelle anticipée, d'incrément de ventes spéculatif ni de notification de gain. Le journal garde `reconciliation=required` ; il n'est pas un moteur de versement.
- Les packs utilisent toujours le helper et la RPC canoniques, sans second writer.

## Concurrence et répétitions

La ligne locale est lue **avant toute observation fournisseur**. L'écriture compare son identifiant de ligne, utilisateur, client, identifiant d'abonnement Stripe et `revision`. Un trigger SQL avance cette révision pour toute mise à jour, indépendamment de `updated_at` et des autres writers. Le reçu doit confirmer la révision suivante ; une collision exige une nouvelle livraison avec nouvelles lectures fournisseur.

Un nouvel abonnement aux mêmes plan et statut possède une identité différente et doit être enregistré. Une répétition du même abonnement ne réattribue pas les droits, mais confirme leur version par une mise à jour de `updated_at` seulement. Ce CAS empêche une observation `past_due` plus ancienne d'écraser une confirmation payée récente. Le marqueur `applied:false` désigne l'absence de nouvelle attribution, pas l'absence de toute écriture de version.

Les assertions de refus exigent toujours **zéro écriture**, y compris de version. Les assertions de répétition valide distinguent les écritures de droits des confirmations ne portant que `updated_at`, et vérifient explicitement les deux catégories. Une perte du reçu de confirmation reste réessayable.

Les quatre contre-exemples causaux sont conservés : annulation ancienne puis nouveau checkout avec plan changé ; même scénario avec plan/statut identiques ; checkout ancien puis résiliation récente ; `past_due` ancien puis confirmation payée à droits inchangés. Les trois premiers échouaient réellement sur B, le quatrième sur le premier candidat C limité au changement d'identité. Les corrections ne suppriment pas la résiliation d'un abonnement actuellement lié.

## Migration et limites

Appliquer la migration `20261111100000_subscription_projection_revision.sql` avant le nouveau handler, après les migrations canoniques d'essai et de journal. `stripe_subscription_id` reste NULL sur les lignes historiques ; aucun identifiant Stripe n'est inventé. `revision` démarre à zéro. La migration ne déplace pas les tables historiques du schéma public vers purama_ai.

Un état qui n'accorde pas de droits (`past_due`, `unpaid`, `paused`, `incomplete`, `incomplete_expired` ou `canceled`) exige l'identité Stripe déjà confirmée sur la ligne. Seul un état actif payé ou un essai fournisseur au terme vérifié peut adopter une identité différente. Une ligne historique sans identité demande un rapprochement ; elle n'est pas révoquée sur la seule présence d'un client commun. L'admission d'un essai local détache une ancienne identité d'abonnement, conserve le client et garde la même politique d'éligibilité et le même essai unique.

**PARTIEL :** le CAS protège la projection locale contre les écrivains concurrents. Stripe et Supabase ne participent pas à une transaction distribuée ; une modification distante non encore observée exige une prochaine livraison/réconciliation. Les listes ambiguës ou incomplètes restent refusées.

**BLOQUÉ :** le gate de signature/typecheck avec le véritable SDK Stripe 18.5.0 n'a pas pu commencer dans cet environnement, car cette version n'est pas en cache. Les autres versions installées n'ont pas été substituées. Le gate CI conserve la version exacte et le contrôle de types.

**NON TESTÉ localement :** assertions PostgreSQL natives nouvelles (création de socket refusée par l'OS avant serveur), fournisseurs réels, schéma de production, réception réelle de webhook et paiements. Le SDK garde son délai de 10 secondes par requête ; le webhook entier n'a pas de nouvelle échéance globale dans ce lot.

`PURAMA_WEBHOOK_TEST_SOURCE=/chemin/vers/index.ts` permet de rejouer une source de référence locale contre les mêmes fixtures sans ouvrir le réseau. Les diagnostics et empreintes A/B restent immuables ; les résultats C sont enregistrés séparément.
