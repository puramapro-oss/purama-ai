# Réconciliation facturation et revenus — étape B, 11 novembre 2026

Ce reçu décrit l'état historique **B**, figé dans l'arbre `c89af83e1215a7a7a60261a505f514830d5991ec`. Les suites ci-dessous ont passé sur cet état, mais la contre-revue suivante a reproduit des courses d'écriture. La publication a été suspendue. Le correctif, ses nouvelles contre-épreuves et ses limites figurent dans [le reçu de l'étape C](./billing-concurrency-reconciliation-20261111.md). Les fonctions déclarées identiques ci-dessous le sont à l'étape B ; C renforce leur ordre de lecture et leurs écritures conditionnelles.

## Résultat

**PARTIEL pour la qualification globale ; correction locale vérifiée des effets financiers spéculatifs.** Le webhook conserve désormais les observations Stripe avant tout effet applicatif, ne crée plus de commission annuelle anticipée, n'augmente plus les ventes ou revenus sur cette estimation et n'annonce plus de nouveau gain non rapproché. Les droits d'abonnement et crédits de packs restent contrôlés séparément.

Le journal garde `reconciliation=required`. Il ne calcule pas les commissions contractuelles, ne rapproche pas les frais et règlements, et n'autorise aucun versement. Aucune ancienne commission, statistique ou politique commerciale n'est recalculée par cette reprise.

## Sources et composition

La base locale reste `ab6a6d8cf38aa7a5d3c7d5efc2a67a3d26a98a31`. [L'étape A](./billing-chef-reconciliation-20261111.md) a été figée dans l'arbre `8cb96bf6c9bdb76f1207049756801b9845ce5a72` avant cette correction. Son patch et son contre-exemple sont conservés séparément.

Cette étape reprend uniquement la tranche finance de [PR22](https://github.com/puramapro-oss/purama-ai/pull/22), source `fb2e7ea6aa1b8d35d54702927112f40e8ae82ac9`, composée avec PR28 et PR40. Les 12 fichiers d'entrée ont été vérifiés par empreinte Git avant utilisation. Aucun apport social de PR22 n'est intégré par cette étape.

Le normaliseur `supabase/functions/_shared/stripe-reconciliation.ts` et la migration `20261110100000_stripe_reconciliation_events.sql` sont strictement identiques au donneur. Le test KARTA `overageCredit.test.ts` reprend sa version intégrant le journal et les deux RPC. Le webhook, le checkout et les fixtures sont composés avec les contrôles plus récents, sans remplacement global par l'ancien handler.

## Comportement corrigé

La signature est vérifiée sur le corps original avant normalisation. Pour un événement financier couvert, la RPC `record_stripe_reconciliation_event` doit confirmer la persistance avant une lecture de fournisseur ou une écriture de droits. Une panne, une observation contradictoire ou un reçu absent ne sont pas acquittés comme un succès. Une reprise conserve l'observation initiale et peut terminer l'application encore en attente.

Les événements d'un compte Connect non mappé ou d'un mode différent de la clé configurée sont enregistrés, puis rendus avec `application=deferred`. Ils ne consultent ni ne modifient les abonnements de la plateforme. Une incohérence interne entre session et événement du bon mode reste refusée.

Les erreurs contrôlées du webhook renvoient maintenant **503 avec un message générique**, au lieu du 500 historique contenant le message interne. Les signatures invalides restent refusées par 400 et les méthodes non prises en charge par 405. L'absence d'une configuration Stripe ou Supabase indispensable empêche le traitement.

Pour les mises à jour, suppressions et échecs de facture liés à un abonnement, le handler relit l'état courant du fournisseur. Il vérifie l'identité, le mode, le statut et la liste actuelle des abonnements avant la persistance. Une ancienne annulation coexistante avec un autre abonnement ouvert renvoie 503, conserve son observation et ne dégrade pas les droits existants. Les listes incomplètes ou ambiguës ne permettent pas de choisir un abonnement.

Une facture échouée sans référence d'abonnement est seulement journalisée. Avec une référence, son client doit correspondre à l'abonnement relu. Un échec retardé ne remplace pas un état actuellement payé par `past_due`. Les références de facture anciennes et Basil contradictoires restent des observations à rapprocher, sans choix arbitraire.

Les cinq helpers PR40 de produit, preuve de facture, client et persistance, le checkout strict PR28 et les surcharges d'identifiants sont identiques à l'étape A. Un état `active` exige toujours sa facture actuelle `paid`. Un essai conserve son terme fournisseur et son marqueur consommé. Les écritures restent conditionnelles et leur reçu est vérifié.

Le checkout sélectionne à nouveau le propriétaire du code influenceur pour refuser l'auto-parrainage. Il copie uniquement les métadonnées d'attribution résolues côté serveur dans `subscription_data.metadata`. Il conserve le catalogue et le coupon historiques, sans réintroduire de second essai Stripe.

Le helper et la migration canoniques des crédits overage restent inchangés. Le journal ne crée pas un second writer de crédits. Le helper de recherche de propriétaire par email, devenu sans appel à l'étape A, et le générateur d'emails de gains sont retirés du webhook.

## Contre-exemple avant/après

Le diagnostic inerte livre deux fois le même checkout parrainé dans trois situations : paiement mensuel à 99 €, remise intégrale à 0 €, essai fournisseur à 0 €.

| Effet par situation | Étape A | Étape B |
|---|---:|---:|
| Réponses HTTP | 200, 200 | 200, 200 |
| Écritures de droits | 1 | 1 |
| Commissions anticipées | 2 × 118,80 € | 0 |
| Incrément de ventes | 2 | 0 |
| Notifications de gains | 2 | 0 |

Les deux observations de diagnostic restent séparées : `commission-diagnostic.json` et `commission-diagnostic-after.json`. Le second contient des assertions exécutées sur l'absence des effets fautifs ; le premier reste la preuve de reproduction du défaut. Aucun fournisseur, paiement ou email réel n'a été utilisé.

## Vérifications exécutées

| Contrôle | Statut | Preuve locale |
|---|---|---|
| Billing Node | PASS | 133/133, sortie 0, aucun test annulé ou ignoré, 3,799 s ; limite de 3 s par test. |
| Commerce Deno avec types et frontières inertes | PASS | 86/86, sortie 0, 1,636 s ; réseau et sous-processus interdits. |
| Webhook complet, journal SQL et crédit overage | PASS | 40/40, Vitest 5.0.3, PGlite 0.5.8, un worker threads, 5,549 s. |
| SQL journal, privilèges, reprises et préservation historique | PASS | 24/24, PGlite 0.5.8, 7,130 s. Inclut la composition réelle des migrations d'essai atomique et de journal, avec préservation de l'essai consommé et de l'unicité du client. |
| ESLint | PASS avec avertissements | 0 erreur, 21 avertissements Fast Refresh ; 9,145 s. |
| TypeScript KARTA, y compris le test modifié | PASS | Sortie 0, 5,553 s. |
| Conservation des contrôles PR28/PR40 | PASS, statique | Sept groupes de fonctions identiques à l'étape A, douze fichiers protégés identiques, aucun doublon d'implémentation et deux sources finance identiques au donneur. |
| Conservation du workflow | PASS, statique | Toutes les étapes et configurations de l'étape A sont conservées ; deux gates revenus sont ajoutés. |
| SDK Stripe réel 18.5.0 | BLOQUÉ avant test | Dépendance absente du cache ; sortie 1 en 0,058 s, sans timeout. Aucun typecheck ni scénario de cette suite n'a démarré. La version et la signature réelle sont conservées. |
| Concurrence PostgreSQL native | NON TESTÉ | Le propriétaire global a constaté EPERM à la création du socket Unix avant tout démarrage du serveur. PGlite ne remplace pas cette preuve. |
| Production, réception Stripe et règlement financier | NON TESTÉ | Aucune migration, livraison, configuration fournisseur ou opération financière réelle. |

La première exécution billing donnait 132/133 : le cas de mode représentait désormais un événement différé avant application. La fixture a été reciblée sur une contradiction session/événement du bon mode ; un cas distinct conserve la preuve du report sans effet. Les assertions de refus et de non-activation restent présentes.

La première exécution du fichier SQL dans le processus isolé du runner Node s'est arrêtée à 1 avant résultat métier détaillé. La reprise avec `--test-isolation=none`, déjà prescrite par le README du donneur, a exécuté les 24 assertions. Cette variante est inscrite dans le nouveau gate CI. Aucun dépassement de délai de runner n'a été assimilé à un refus métier réussi.

Les 35 tests navigateur, les builds site/KARTA et les contrôles d'essai/CHEF de l'étape A ne sont pas additionnés aux compteurs ci-dessus. Les pages, hooks concernés, sources CHEF, migration d'essai et helper overage sont vérifiés identiques ; la phase B ne modifie pas l'interface. L'exécution CI sur la tête publiée reste à obtenir.

## Conditions de reprise et limites

Les migrations doivent précéder le déploiement du webhook : crédits canoniques, essai atomique, puis journal de rapprochement. La migration de journal refuse les doublons historiques de liaison client et annule sa transaction sans supprimer de données. Une copie de production et ses éventuelles données ambiguës n'ont pas été inspectées ici.

L'index GitNexus existant a été adopté dans un registre privé sans changer ses dates ni sa référence `0d38a925`. Il reste ancien ; ses nouveaux symboles absents sont complétés par comparaisons Git/AST et contrôles ciblés. Le reçu `detect_changes` final accompagne le lot et sa portée doit rester **PARTIELLE**, même si la commande termine normalement. Aucun résultat de graphe ancien ne prouve l'exhaustivité du périmètre courant.

L'absence du moteur contractuel de commission, du rapprochement des frais et de la disponibilité des fonds reste à traiter dans le projet canonique. Les observations conservées ne sont pas présentées comme des revenus acquis. Les anciennes surfaces de portefeuille, contrat et demandes de retrait doivent être examinées par leur propriétaire avant de qualifier toute la chaîne financière.

Les commandes, logs, empreintes et patches sont regroupés dans `iao-review/billing` par le propriétaire de qualification. Le reçu d'étape B référence les deux diagnostics, les tests exécutés, le blocage SDK exact, les comparaisons de préservation et le contrôle de portée. Aucun commit, push, déploiement ou versement n'est effectué par cette étape.
