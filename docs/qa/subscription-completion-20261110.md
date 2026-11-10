# Abonnements PURAMA/IAO — intégration et frontières de paiement

## Résultat et périmètre

Ce correctif réunit la consolidation PR33 (`90d8f30322e864ccfd186e97cbfe7edf3afec9a9`) et les essais atomiques PR28 (`456fa6ca75ebb69650e7425bdaafa3f8486f88ad`). Il prépare une mise à jour de la PR28 existante, sans déploiement ni changement de prix, de taux ou de commissions. Les modifications concurrentes OTS/planificateur des autres PR ne sont pas reprises.

Les garde-fous testés concernent les essais, la création du checkout, le portail et l'activation issue d'un checkout signé. Ils ne prouvent pas que tout PURAMA est prêt à être commercialisé.

## Registre de vérification

| Critère | État à la préparation de la PR | Preuve / limite |
|---|---|---|
| Réutiliser les travaux existants sans écraser PR33 | PASS | Fusion à deux parents ; résolution ciblée du workflow, verrou KARTA et hook abonnement ; normalisation des plans conservée |
| Frontières checkout/portail | PASS | 40 tests sur les vrais fichiers et leurs imports, exécutés avec fournisseurs inertes |
| Activation des droits après checkout | PASS | 65 tests du vrai handler et du helper overage ; CAS, reçu d'écriture, identité, rejeu, paiement différé |
| Suite billing combinée | PASS | 105/105, zéro échec, Node 22.23.4 ; `npm run test:billing` |
| Types SDK natifs, frontend, compilation | PASS CI sur 94e5987 | Run 42910859958, contrôle Deno avec modules réels, types et build. Les 10 incompatibilités détectées au premier run ont été corrigées avec des fabriques Supabase concrètes |
| Parcours navigateur et contrôles préexistants | PASS CI sur 94e5987 | Run 42910859958 complet : site, KARTA et PostgreSQL réussis. 92 cas qualité, 156 parcours publics sur trois tailles Chromium, autres suites conservées. Les interruptions locales ne sont pas comptées comme réussites |
| Complément DashboardBilling | PARTIEL lors de la préparation | Types de 271 fichiers et découverte de 29 cas PASS ; exécution navigateur à confirmer sur le commit suivant. Le résultat courant est dans les checks de la PR28 |
| Essai atomique SQL | PASS CI sur bce8742 | Job subscription-concurrency du run 42910128642 : 6/6 tests, PostgreSQL 18.6 ; KARTA réussi. Le checkout CI aea87cbb possède exactement le même arbre f7890339 que bce8742 |
| CI complète de la consolidation avant modification | PASS historique | PR33, run 42881227306 ; ce résultat n'est pas attribué au nouveau correctif |
| Production et fournisseurs réels | NON TESTÉ | Aucune migration, aucun paiement, aucun email et aucun déploiement réalisés |

Le premier run 42910128642 a réussi KARTA et PostgreSQL mais échoué au contrôle de types du site. Le run suivant [42910859958](https://github.com/puramapro-oss/purama-ai/actions/runs/42910859958) est entièrement réussi sur 94e5987326f3aa39eb904586a7fe74fbb3410849 : 1665 tests KARTA, 105 billing, 6 PostgreSQL natifs et toutes les suites site. Le checkout CI 088fff6f possède le même arbre a09ef86e6421a0222041a9b109ced0efc58382f4. Le complément DashboardBilling fait l’objet d’une nouvelle CI ; vérifier son SHA avant promotion. Les compteurs ci-dessus sont des preuves par version, pas une promesse pour un commit ultérieur. Le job PostgreSQL utilise son service éphémère de test ; les fixtures de paiement interdisent réseau et envois réels.

## Défauts reproduits et correction

Avant correction, le checkout et le portail choisissaient le premier customer Stripe par email, même associé à un autre utilisateur ; `Origin` contrôlait les URLs de retour. Le checkout transmettait aussi des prix hors catalogue au fournisseur simulé et ajoutait systématiquement un essai Stripe de 14 jours. Ces contre-exemples portent sur le comportement du code, pas sur l'acceptation effective de ces requêtes par Stripe.

La frontière commune authentifie le jeton, utilise d'abord la liaison DB, vérifie les métadonnées et refuse les collisions ou listes incomplètes. L'email permet seulement de découvrir un customer portant déjà le même `user_id`. Une nouvelle identité Stripe est explicitement marquée. Le portail ne crée jamais de customer. Les anciens customers ambigus nécessitent une réconciliation par le support ; aucune association arbitraire n'est effectuée.

Le catalogue existant `src/lib/plans.ts` est importé directement : six tarifs d'abonnement et le pack existant sont admis, sans nouveau catalogue concurrent. Le checkout est une conversion payante explicite, sans nouvel essai Stripe. Un abonnement fournisseur non terminé empêche l'ouverture d'un nouvel abonnement ; l'achat d'un pack reste distinct. La réduction utilise les colonnes existantes `promo_code`, `beneficiary_name`, `expires_at`. Une réduction non vérifiable arrête le paiement au lieu de facturer silencieusement le plein tarif.

Les retours utilisent `PURAMA_BILLING_ORIGIN` validée côté serveur, ou l'origine HTTPS existante par défaut. Seules les URLs hébergées Stripe attendues sont acceptées. Les domaines Stripe personnalisés ne sont pas activés par ce correctif : il faudra un paramétrage explicite et testé avant leur utilisation.

Une intention UUID de checkout est conservée lors d'un réessai du même écran, utilisateur et tarif. La clé Stripe est dérivée par SHA-256 ; elle ne révèle pas directement l'identité. Changer d'utilisateur ou de tarif crée une nouvelle intention. Les clients historiques sans UUID restent compatibles mais ne disposent pas de cette protection entre requêtes indépendantes.

Le serveur checkout/portail borne l'ensemble auth/DB/Stripe à 15 secondes et l'entrée checkout à 4096 octets / 5 secondes. Après interruption ou expiration, les continuations vérifient leur validité avant les effets suivants. Cela ne peut pas annuler une opération déjà acceptée par Stripe ; une reprise conserve donc la même intention. L'écran Pricing borne son attente à 20 secondes et ignore les résultats d'un ancien compte, y compris A → B → A.

Le tableau de facturation applique aussi une portée de compte, un verrou synchrone entre portail et achat de pack, un délai de 20 secondes et un domaine Stripe propre à chaque action. L’intention du pack est conservée lors d’un réessai dans le même montage et compte. Une lecture d’abonnement échouée affiche un état indisponible et une reprise explicite, sans présenter un abonnement gratuit comme confirmé. Ses 29 nouveaux cas attendent la CI du complément.

Le webhook vérifie l'identité exacte via `getUserById`, l'appartenance customer/subscription, le produit et l'état fournisseur. Un formulaire terminé mais impayé n'accorde aucun droit. Le paiement différé reprend le même chemin. Les écritures sont confirmées et conditionnelles ; une erreur ou un reçu incohérent est renvoyé en erreur pour permettre un réessai. L'essai consommé n'est jamais réinitialisé.

## Blocages de mise en production conservés explicitement

1. **Commissions d'affiliation non transactionnelles.** Le rejeu parrainé reproduit une seule activation des droits mais deux commissions et deux incréments de ventes. Le sous-flux historique est conservé pour ne pas perdre une première commission si un autre événement a déjà activé les droits. Il faut un reçu durable, une contrainte d'unicité, une transaction et une outbox, après audit des données existantes. Responsable : intégration facturation.
2. **Autres événements Stripe.** `customer.subscription.updated/deleted` et `invoice.payment_failed/succeeded` restent inchangés. Ils nécessitent une gestion de l'ordre, de la version et des reçus DB. Le résultat présent ne garantit pas l'idempotence du cycle de vie complet.
3. **Schéma effectif Hostinger/Supabase.** Le transfert historique de `public.subscriptions` vers `purama_ai.subscriptions` n'est pas démontré par une migration canonique rejouée depuis zéro. Vérifier les tables, contraintes, droits et RPC sur une copie avant application du correctif d'essai. Responsable : infrastructure/intégration ; pas d'accès production utilisé dans ce passage.
4. **Unicité globale des achats.** Des intentions indépendantes peuvent ouvrir des sessions avant le paiement de la première ; l'idempotence Stripe a une durée de conservation limitée. Ni les tests ni la clé par intention ne prouvent un verrou global durable. Réconcilier les clients historiques, puis prévoir une intention persistante unique avant activation commerciale à grande échelle.
5. **End-to-end fournisseur.** Valider les webhooks signés et la réconciliation Stripe/Supabase sur un environnement dédié ; tester restauration, disponibilité, journal d'audit, langues, fiscalité et règles de distribution séparément. Le présent correctif n'est pas une preuve de déploiement mondial ni de revenus futurs.

## Analyse de dépendances

GitNexus 1.6.12 a été exécuté avant les modifications. Deux tentatives d'index ont été interrompues ; un nouvel essai avec pool natif plafonné à 256 Mio a réussi : 13 680 nœuds, 35 246 relations et 555 parcours. L'index signale lui-même une couverture incomplète et des chemins tronqués.

`useSubscription` : six appelants directs, six processus, risque **CRITICAL** annoncé avant la poursuite : AgentUsageForm, DashboardAgents, MyAgents, DashboardBilling, Pricing, DashboardOverview. La normalisation des plans de PR33 est conservée ; seul l'état d'erreur du hook est ajouté par PR28. `Pricing.handleCheckout` : deux symboles affectés, risque LOW. Les callbacks Edge non résolus et certaines requêtes interrompues sont **UNKNOWN**, jamais considérés comme sans risque. Revue manuelle financière critique appliquée.

`detect_changes --scope staged` a été exécuté : 28 fichiers, 16 symboles indexés, 10 parcours, risque HIGH. La comparaison à `main` a aussi été exécutée : 751 fichiers, 6496 symboles, 511 parcours, risque CRITICAL ; elle inclut le travail antérieur de consolidation et ne mesure pas le seul présent correctif. Les fonctions nouvellement ajoutées ne sont pas toutes couvertes par cet index préalable ; les tests et la revue de diff complètent ce contrôle.

## Reproduction

- `npm ci --no-audit` puis `npm run test:billing`
- `npm run typecheck`, `npm run build`, `npm run test:quality`
- Dans `karta` : `npm ci --no-audit`, `npm test`, `npm run typecheck`, `npm run build`
- PostgreSQL : job `subscription-concurrency` du workflow ; utiliser exclusivement une instance de test répondant aux gardes de la suite native.
- Le workflow conserve les vérifications préexistantes et ajoute les trois handlers au contrôle Deno ainsi que les tests billing.

## Références primaires consultées

- [Création d'une session Checkout](https://docs.stripe.com/api/checkout/sessions/create)
- [Idempotence Stripe et conservation des clés](https://docs.stripe.com/api/idempotent_requests)
- [Essais Checkout](https://docs.stripe.com/payments/checkout/free-trials)
- Implémentation officielle npm `stripe@18.5.0`, `FetchHttpClient` : adaptation fetch et AbortController vérifiée localement.
