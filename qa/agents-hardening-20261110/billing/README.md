# Correctif des crédits de dépassement historiques — 10 novembre 2026

## Résultat

**PASS : 38/38 tests ciblés et rejeu d'intégration PostgreSQL 18 à 7/7 scénarios, rapporté par le responsable de l'intégration. PARTIEL pour une mise en service : aucune migration ni fonction distante n'a été déployée.**

Base examinée et reproduite : `1daf6314d60f6dd336c3a3601ddf73cf432ef4b3`, branche de travail `fix/agents-budget-outreach-20261110`.

Le lot concerne uniquement les packs de dépassement historiques de PURAMA AI. Il ne définit pas les offres 199/499 de PURAMA ONE, leur quota ou leurs périodes. Le nombre d'actions du pack, les prix et identifiants Stripe existants restent inchangés. L'ancien mois calendaire est conservé, mais il est désormais déterminé par l'événement de paiement signé et non par sa date de livraison.

## Défauts reproduits avant correction

Le vrai handler de la base Git a été compilé et exécuté avec des adaptateurs fournisseur simulés et la migration historique dans une base PGlite privée. Aucun service externe n'a été appelé.

| Cas | Résultat de la base |
| --- | --- |
| Même session reçue deux fois | Deux réponses HTTP 200, deux crédits, 4 000 actions |
| Session `payment_status=unpaid` | HTTP 200 et 2 000 actions créditées |
| Erreur de persistance | HTTP 200 malgré l'absence de crédit |
| Paiement signé le 31 octobre, livraison le 10 novembre | Crédit attribué à novembre |

Les observations exactes, le commit et le SHA-256 du handler sont dans `baseline-reproduction.json`.

## Modification

`stripe-webhook/overage.ts` vérifie la confirmation de paiement et les faits nécessaires : session terminée, utilisateur, identifiants de session/événement/paiement, montant positif, devise, mode test/réel et dates cohérentes. Il ne déduit aucun crédit gratuit de `no_payment_required`. Le succès différé `checkout.session.async_payment_succeeded` utilise la même opération que le succès immédiat. Un événement `completed` encore impayé attend le succès différé.

Le crédit passe par `purama_ai.credit_overage_pack`, fonction SQL atomique autorisée uniquement au rôle serveur. Les contraintes uniques portent sur la session et l'événement initial. Une session déjà créditée n'est acceptée comme répétition que si son utilisateur, son quota et ses preuves de paiement correspondent. Un conflit ou une erreur de base remonte au handler, qui retourne 500 et permet une reprise. Un reçu absent après une écriture n'est pas traité comme un succès ; la reprise reste idempotente.

Le timestamp est celui de l'événement Stripe signé confirmant le succès. Sa répétition ne déplace pas la période. Une réutilisation de session avec une autre date de paiement est un conflit à rapprocher, même si les autres champs ressemblent à un doublon.

## Migration et crédits historiques

La migration `20261110000200_overage_credit_idempotency.sql` est transactionnelle. Elle verrouille les écritures pendant la vérification et l'ajout des contraintes. Si des sessions historiques sont déjà dupliquées, elle échoue avec `overage_duplicate_sessions_require_reconciliation` et ne supprime ni ne réécrit aucun crédit.

Les nouvelles colonnes de preuve restent nulles pour les anciens crédits. Une ancienne session redélivrée sans preuve enregistrée est refusée avec `overage_session_conflict_requires_reconciliation` ; le système ne fabrique pas rétroactivement de preuve et n'accorde pas un second crédit. Les lignes historiques sans identifiant de session sont conservées.

Pour une future mise en service, l'inventaire des doublons et le rapprochement des crédits concernés doivent précéder l'application. La migration doit être disponible avant le nouveau handler. Si la fonction SQL manque ou renvoie une erreur, le handler échoue sans acquitter le crédit. Cette notice n'est pas une preuve que la base de production correspond au schéma versionné.

## Vérifications exécutées

| Contrôle | Résultat | Limite |
| --- | --- | --- |
| `npm test -- test/overageCredit.test.ts --reporter=verbose` dans `karta/` | **38/38 PASS**, exit 0 | Handler réel, signature et fournisseur simulés, PostgreSQL via PGlite |
| `npm run typecheck` dans `karta/` | **PASS**, exit 0 | Contrats TypeScript du projet KARTA et du test |
| TypeScript strict du helper overage | **PASS**, exit 0 | Helper autonome ; pas de compilation Deno distante |
| `git diff --check` | **PASS**, exit 0 | Vérification de whitespace du checkout au moment du contrôle |
| Reproduction de la base Git | **BUG REPRODUIT**, exit 0 | Aucune donnée ou opération de production |
| Rejeu d'intégration PostgreSQL 18 après correction | **7/7 PASS**, rapporté par le responsable de l'intégration | Vraies connexions natives au cluster privé ; aucun appel fournisseur ni paiement réel |

Les 38 tests vérifient notamment douze livraisons concurrentes, la contrainte unique SQL, les conflits d'utilisateur et de contenu, les erreurs et reprises, le reçu perdu, les paiements différés, les refus de droits client, la réapplication de la migration et l'arrêt sur doublons historiques.

**PGlite utilise un seul backend.** La rafale valide la concurrence des requêtes de handler à travers la vraie frontière SQL ; elle ne certifie pas l'ordonnancement de plusieurs connexions sur un serveur PostgreSQL natif. La signature Stripe est remplacée par un adaptateur de test ; le contrôle réel de signature préexistant n'a pas été réécrit. Les appels Stripe, les moyens de paiement réels, les remboursements et les autres branches abonnement/commissions du webhook ne sont pas qualifiés par ce lot.

### Correction révélée par le premier essai PostgreSQL natif

Le responsable de l'intégration a exécuté le banc avec douze connexions PostgreSQL 18 distinctes sur le Mac isolé. Six scénarios sur sept ont passé lors du premier essai ; le crédit concurrent a révélé une erreur `23505` sur `overage_credits_stripe_event_unique`. Un seul crédit existait, mais certaines livraisons identiques recevaient une erreur : `ON CONFLICT (stripe_session_id)` ne couvrait pas l'autre index unique lors de cette concurrence. Les preuves de cet essai avant correction sont conservées séparément par le responsable, avec arrêt du serveur et suppression du cluster confirmés.

Le RPC utilise maintenant `ON CONFLICT DO NOTHING` sans cible, puis relit et valide strictement la session. Les deux index uniques sont conservés. Un événement déjà enregistré pour une autre session reste refusé, y compris si les deux sessions existent déjà ; ce conflit produit `overage_session_conflict_requires_reconciliation` (`22023`). Aucun utilisateur, montant, nombre d'actions, période ou fait de paiement n'est réécrit pour absorber un conflit.

Le test de conflit d'événement attend désormais cette erreur de domaine et couvre le croisement de deux reçus existants. Le test d'insertion directe confirme encore les deux contraintes uniques. Les autres refus et reprises restent inchangés.

```sh
npm test -- test/overageCredit.test.ts --reporter=verbose --maxWorkers=1
```

**38/38 tests ciblés PASS**, sortie 0, 7,10 secondes ; journal [vitest-overage-native-fix.txt](vitest-overage-native-fix.txt). `git diff --check` est également PASS.

Le responsable de l'intégration a ensuite rejoué le même script natif sur la définition SQL corrigée : **7/7 scénarios PASS**. Douze appels simultanés pour la même session produisent un seul crédit de 2 000 actions et des reçus de réponse valides, avec les deux index uniques conservés. Ce rejeu couvre aussi le budget d'admission, l'outreach et les quatre scénarios de quarantaine ; il reste distinct des 38 tests ciblés du handler et du RPC.

Les preuves finales sont le [résultat JSON natif](../integration/native-postgres-results.json) et le [journal d'exécution natif](../integration/native-postgres.txt). Le nettoyage rapporté est `server_stopped=true`, `temporary_cluster_removed=true`, `client_cleanup_errors=[]`. Ces résultats concernent le cluster PostgreSQL privé ; ils ne constituent ni un déploiement ni une opération de paiement réelle.

GitNexus a été interrogé avant édition. Le symbole voisin `logStep` a un risque graphe LOW et le fichier d'entrée un risque UNKNOWN. Le callback externe n'est pas relié comme un symbole de fonction indépendant. Le risque métier **CRITICAL** a été communiqué au parent et annoncé à l'utilisateur avant l'édition. Voir `impact-summary.json`.

## Fichiers du lot

- `supabase/functions/stripe-webhook/index.ts` : branche overage et événement de succès différé.
- `supabase/functions/stripe-webhook/overage.ts` : validation des preuves et contrôle du reçu.
- `supabase/migrations/20261110000200_overage_credit_idempotency.sql` : contrainte et RPC atomique.
- `karta/test/overageCredit.test.ts` : tests du vrai handler et de la base privée.
- `qa/agents-hardening-20261110/billing/` : observations et journaux de vérification.

Ce sous-lot ne réalise aucun commit, envoi de message, débit, modification du Mac ou déploiement. La revue et le commit final appartiennent au travail d'intégration du parent.
