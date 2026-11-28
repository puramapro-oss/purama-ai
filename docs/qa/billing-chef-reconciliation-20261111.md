# Réconciliation locale facturation et CHEF — 11 novembre 2026

Ce reçu décrit **l'étape A**, figée dans l'arbre `8cb96bf6c9bdb76f1207049756801b9845ce5a72`. La correction financière réalisée ensuite est décrite dans [le reçu de l'étape B](./billing-finance-reconciliation-20261111.md). Les défauts financiers et limites de graphe ci-dessous sont l'état historique de cette étape, pas une description du webhook après l'étape B.

## Périmètre et identité des sources

Ce reçu porte sur un candidat local construit depuis `ab6a6d8cf38aa7a5d3c7d5efc2a67a3d26a98a31`, avec les apports de [PR28](https://github.com/puramapro-oss/purama-ai/pull/28) à `e6a58261b0f3e18740e10b06d1b74d6088c06830`. Les 35 blobs donneurs ont été vérifiés avant réconciliation. La tête Git reste celle de la base : aucun commit, aucune publication, aucune fusion distante ni aucun déploiement n'est attesté ici.

Le correctif CHEF reprend les cinq gardes d'annulation et leur test depuis [PR18](https://github.com/puramapro-oss/purama-ai/pull/18), source `542e9b03e080b764cc85b98cc33a5ba4326a9e10`. Son patch initial est identifié par SHA-256 `f8003fa010dd6572afc25d102a09a9e06a41229561fae837ab77b74e224ef4eb`.

La consolidation concurrente PR45 doit être comparée par son propriétaire avant toute publication d'un delta. Ce document ne désigne pas une nouvelle branche canonique.

## Résolution des trois conflits

- `package.json` conserve à l'identique les 42 commandes de la base et ajoute `test:billing`. Cette commande borne chaque test Node à 3 secondes ; les limites fonctionnelles des requêtes ne sont pas réduites.
- Le workflow CHEF conserve le job KARTA, les contrôles OAuth et distribution, tous les contrôles site précédents et leurs paramètres. Il ajoute le contrôle billing, les endpoints `create-checkout` et `customer-portal` à Deno, ainsi que le job PostgreSQL de concurrence du donneur. Aucun contrôle n'est rendu facultatif et aucun audit fournisseur n'a été exécuté pendant cette qualification locale.
- Le webhook conserve les helpers de statut, preuve de facture et confirmation d'écriture de PR40. La nouvelle voie de checkout PR28 appelle `confirmedSubscriptionState` avant tout droit ou effet de commission. Une souscription `active` doit avoir une facture actuelle relue `paid`, rattachée au bon client, y compris en cas de remise intégrale. Les essais conservent la validation de leur date de fin et le marqueur d'essai consommé.

Les deux variantes de `stripeObjectId` sont composées par surcharges : le contrat historique à un argument reste optionnel ; le checkout exige en plus le préfixe de l'objet Stripe. La contre-revue a comparé 27 valeurs pour le contrat historique et 108 combinaisons pour le contrat strict, sans différence avec leurs sources respectives.

La comparaison AST confirme l'identité exacte avec ab6a des cinq fonctions `subscriptionPlan`, `confirmedSubscriptionState`, `createSubscriptionClient`, `storedSubscription`, `persistSubscription`, et des quatre branches `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`, `invoice.payment_succeeded`.

## Changements justifiés dans les fixtures

Les fixtures Node disposent désormais d'une facture et d'une réponse inerte `invoices.retrieve`. Douze nouveaux cas couvrent, pour `paid` et `no_payment_required`, l'absence de facture, une facture ouverte, une autre identité de facture, un autre client, un client développé supprimé et une erreur du fournisseur. Tous refusent l'activation et les commissions.

Les fixtures natives Deno représentent aussi `customers.retrieve`, `subscriptions.list`, `auth.admin.getUserById`, les colonnes conditionnelles et les reçus de sélection après écriture. Ces frontières restent inertes ; la commande interdit le réseau et l'exécution de processus.

Les attentes historiques changent explicitement sur trois contrats :

1. Une session sans preuve de paiement ou avec un statut provider non admissible est refusée ou reste en attente, sans droit accordé.
2. `no_payment_required` avec facture ouverte est refusé ; avec facture `paid` le parcours est accepté.
3. L'identité est prouvée par des métadonnées serveur cohérentes ou une liaison unique déjà enregistrée. Un email, même trouvé dans 20 000 comptes, n'est plus une preuve de propriété. Les métadonnées contradictoires sont refusées. La recherche Auth se fait par identifiant et les catalogues email ne sont pas énumérés.

Les assertions de non-activation, d'absence d'effets après erreur, de reçu d'écriture, d'essai consommé, de liaison ambiguë et de client modifié pendant l'écriture sont conservées. Le helper historique de recherche par email demeure défini mais n'a aucun appel dans le webhook final de cette phase.

## Contrôles exécutés sur le candidat

| Contrôle | Statut | Résultat et portée |
|---|---|---|
| Billing Node, commande finale bornée à 3 s par test | PASS | 120/120, 0 échec, 0 annulation, sortie 0 ; 4,962 s pour le processus complet. |
| Commerce Deno natif avec types et fixtures inertes | PASS | 83/83, sortie 0 ; 2,026 s. |
| SQL d'admission d'essai sur PGlite 0.5.8 | PASS | 28/28 sur les vraies migrations historique et atomique ; rôles, privilèges, rejouabilité, recherche de schéma et essai consommé. |
| CHEF après application dans la composition | PASS | 5/5 annulations Git. La qualification directe antérieure, sur les mêmes blobs, compte 52/52 tests. |
| Navigateur Chromium local, Pricing et DashboardBilling | PASS | 35/35, un worker, aucune reprise, sortie 0 ; 28,278 s. Comptes A→B→A, déconnexion, démontage, double clic, intention stable, URL et réponse tardive. |
| TypeScript site et KARTA | PASS | Les deux commandes terminent à 0. |
| Build site et KARTA | PASS | Les deux commandes terminent à 0 ; sorties isolées de qualification. |
| ESLint | PASS avec avertissements | 0 erreur et 21 avertissements Fast Refresh, dont deux dans les nouveaux harnesses de navigateur. Ce n'est pas une preuve « zéro avertissement ». |
| Revue React Best Practices | PASS, portée ciblée | Hooks, durée de vie de compte, dépendances, état dérivé et anti-double clic. Aucun benchmark de performance réel. |
| Types des endpoints avec les modules distants réels | BLOQUÉ | La commande Deno se termine à 1 sur une connexion refusée à `deno.land`, avant la vérification des types. Les contrôles Deno avec fixtures ne remplacent pas ce contrôle. |
| Concurrence PostgreSQL native | BLOQUÉ avant test | Le propriétaire global a préparé PostgreSQL 18.6 et réussi initdb, mais l'OS refuse la création d'un socket Unix (EPERM), y compris dans `/tmp`. Aucun serveur n'a démarré. La concurrence reste NON TESTÉE ; PGlite ne la démontre pas. |
| Fournisseurs, base distante et production | NON TESTÉ | Aucun accès métier réel, aucun paiement ni déploiement. |

Le premier essai Deno avait échoué sur deux incompatibilités de typage des frontières de fixtures ; elles ont été corrigées sans utiliser `--no-check`. L'essai initial Node après réconciliation était déjà à 120/120 avec limite runner de 5 secondes. La commande finale à 3 secondes confirme le résultat sans délai de runner dépassé. Un refus HTTP attendu du handler est distingué d'un timeout ou d'une annulation du runner.

Les suites navigateur bloquent les services externes et utilisent des réponses contrôlées. Elles ne prouvent pas l'annulation serveur d'une opération déjà soumise. Dans Pricing, une réponse d'un compte obsolète est ignorée mais son attente locale peut vivre jusqu'à la limite de 20 secondes ; DashboardBilling ferme son délai au nettoyage.

## Défaut financier reproduit, phase suivante obligatoire

**BLOQUÉ : cette phase ne valide pas les commissions.** Après `completeSubscriptionCheckout`, la valeur `applied` est seulement journalisée. Les effets de parrainage se déclenchent encore lors d'une redélivrance. Le code calcule `annualValue = monthlyPrice * 12`, insère une commission, augmente les compteurs et annonce un gain. Il n'appelle pas encore le journal durable `record_stripe_reconciliation_event` de PR22.

Un diagnostic local inerte a livré deux fois le même événement dans trois situations : mensuel à 99 €, remise intégrale à 0 € et essai provider à 0 €. Chaque situation renvoie 200/200 avec une seule écriture de droits mais deux commissions de 118,80 €, deux ventes comptées et deux notifications. Ce résultat reproduit un défaut ; son processus terminé à 0 n'est pas un test d'acceptation financière réussi. Aucun email ou paiement réel n'a été envoyé.

La suite coordonnée doit reprendre la seule tranche finance de [PR22](https://github.com/puramapro-oss/purama-ai/pull/22), source `fb2e7ea6aa1b8d35d54702927112f40e8ae82ac9` : normalisation, journal SQL append-only avant effets, tests de revenus, suppression des anticipations annuelles et des gains non prouvés, chemin canonique du pack. Les protections PR28 et PR40 doivent rester intactes. Aucun apport social n'est inclus par ce reçu.

## Preuves et limites de reprise

Les reçus JSON horodatés, logs, empreintes avant/après et diagnostic causal sont regroupés dans `iao-review/billing` dans l'espace de qualification. Les fichiers clés sont `billing-final.json`, `commerce-final.json`, `trial-chef-targeted.json`, `billing-browser.json`, `reviewer.json`, `workflow-script-preservation.json` et `commission-diagnostic.json`. Le propriétaire global assure leur archivage avec le delta final.

Les analyses d'impact préalables ont signalé les risques HIGH/CRITICAL avant édition. La reconstruction fraîche du graphe GitNexus n'a pas abouti dans cet environnement. Le graphe existant est en retard et ne qualifie pas tous les ajouts du webhook PR40. `detect_changes --scope staged --repo <clone billing>` a été exécuté : sortie 1, dépôt non enregistré dans les index disponibles. Son reçu est `detect-changes-final.json`. Ce contrôle est BLOQUÉ et ne constitue pas une preuve de portée exhaustive. Aucun commit n'est effectué dans cette phase.
