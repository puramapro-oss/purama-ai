# Audit du commerce PURAMA — 10 novembre 2026

## Résultat et périmètre

**PARTIEL pour la mise en service. PASS pour les vérifications décrites ci-dessous.**

L'audit porte sur les sources accessibles du parcours commercial : abonnement,
promotion, attribution, commissions, prime, droits financiers et présentation du
résultat d'un paiement. Il ne certifie pas tous les services PURAMA, tous les
appareils, ni une configuration de production non inspectée.

Deux produits différents ont été retrouvés et doivent rester séparés :

| Candidat | Source vérifiée | Nature du travail |
| --- | --- | --- |
| PURAMA AI historique | `puramapro-oss/purama-ai`, base `d003159bdf3216b155f747b0f8fa93b3a92e5b3a`, branche `repair/iao-quality-20261109` (PR14) | Correctifs isolés de sécurité et de cohérence, objet de cette branche |
| PURAMA ONE | Bundle `one-subscription-6db9b12.bundle`, commit `6db9b12533e935639dadc05fa0c17211ddca96d0` | Récupération exacte, audit et tests ; sources produit inchangées |

Le bundle ONE contient 104 fichiers suivis et 13 commits. Son SHA-256 est
`5f7cc11b0fd220439ef2490c7863825c3c261ac7b1d60653dbf815efc1c21770`.
Le transfert, `git bundle verify` et `git fsck --full` ont été vérifiés.

Cette branche ne remplace pas le travail réservé sur le Mac. La protection du
versement reprend exactement le fichier déjà préparé dans le worktree
`partner-qr-20261103`, snapshot de HEAD `108291708a3d6858d26519704eb793d29b67cee6`
avec changements locaux non commités. Le reste du moteur QR n'a pas été importé :
ses règles financières et sa prime unique ne correspondent pas à la nouvelle
proposition ONE.

## Corrections de cette branche historique

### Versements : supprimer les faux états payés

Le handler précédent modifiait une commission en `paid`, écrivait une notification
et préparait un courriel de confirmation sans appeler un prestataire de virement.
Un test du vrai handler, avec services remplacés par des fixtures sans réseau, a
reproduit une commission fictive de 75 EUR déclarée payée.

Le handler repris du travail Mac retourne maintenant 503 tant qu'aucun prestataire
n'est intégré. Il ne crée aucun client de base, ne modifie aucune commission et
n'envoie aucun courriel. Les appels autres que POST sont refusés ; absence de
secret serveur et identifiants incorrects sont contrôlés séparément. Le bouton
administratif « Payer » et la mutation cliente `markCommissionPaid` sont supprimés.

**Cette protection ne réalise pas un virement.** Les anciens enregistrements `paid`
ne sont pas réécrits : leur rapprochement avec des preuves de transfert reste à faire.

### Droits SQL : montants et statuts financiers réservés au serveur

La migration `20261110000100_commerce_privileges.sql` traite les tables réellement
présentes parmi `public` et `purama_ai`, sans en créer ni en déplacer. Elle protège
les taux, montants, statuts, soldes, transactions de portefeuille et retraits.

Les tests utilisent les migrations historiques réelles dans PGlite avec des rôles
PostgreSQL distincts. Avant correction, ils reproduisent notamment un portefeuille
auto-crédité de 100000 EUR, un retrait de 99999 EUR déjà `completed`, un taux
d'influenceur à 99,99 % et une commission `paid` créée par un administrateur client.

La lecture autorisée, la création du profil avec les seuls champs permis, les
coordonnées bancaires et la demande de retrait `pending` restent possibles. Les
droits par colonne sont aussi révoqués, y compris ceux hérités de PUBLIC. La
migration est transactionnelle et refuse les politiques inconnues. Le ledger
`public.wallet_transactions` V4.1, distinct du portefeuille P3, est laissé intact.

**Limite de déploiement :** les anciens hooks `signContract` et `regenerateLink`
écrivent directement dans des champs désormais réservés au serveur. Les opérations
serveur de signature/renouvellement doivent être intégrées avant une mise en service
complète de ces parcours. Cette migration ne réserve pas le solde d'un retrait et
n'exécute aucun transfert. Elle ne prouve pas la provenance des données antérieures.

### Abonnement : normalisation et lecture Stripe

`getPlan` accepte seulement les propriétés propres du catalogue. Les valeurs
`__proto__`, `constructor`, non textuelles et inconnues retournent un plan gratuit
canonique. L'alias existant `enterprise` reste pris en charge. Le hook dérive les
indicateurs de niveau et l'objet plan de cette même résolution ; un plan inconnu
n'est plus présenté comme un abonnement ou un essai valide.

La lecture Stripe utilise les dates de période de `SubscriptionItem` avec la
version Basil et garde un repli compatible avec les anciens objets. Elle accepte
les produits développés, refuse les produits inconnus et les dates invalides.

La revue indépendante a ajouté deux cas : plusieurs clients Stripe au même
courriel et pagination incomplète des lignes. Ils ont d'abord échoué dans quatre
tests, puis ont été corrigés. Clients ambigus, abonnements multiples, plusieurs
plans ou liste de lignes incomplète retournent 409 pour rapprochement, sans attribuer
arbitrairement un plan. L'association durable utilisateur/client Stripe reste à
préférer à la recherche historique par courriel.

Ce endpoint est une lecture. Il ne remplace pas le traitement de factures ni la
source de droits en base lue par l'interface.

### Interface : un retour de paiement ne prouve pas un encaissement

Les paramètres `success`/`canceled` sont comparés à la valeur exacte `true`.
Les bannières informent du retour et invitent à consulter la facturation ; elles
n'annoncent ni paiement validé, ni crédit de quota, ni absence de débit.

Les quotas affichés restent issus de la lecture des données. Les redirections de
Pricing vérifient que l'URL reçue est une chaîne HTTPS. La consultation des
commissions et coordonnées est conservée sans bouton de faux versement.
**Aucun prix, taux ou coupon historique n'a été changé dans cette branche.**

## Vérifications exécutées

| Vérification | Résultat | Portée et limites |
| --- | --- | --- |
| Tests KARTA | **563/563 PASS**, 47 fichiers | Inclut les 58 nouveaux tests ACL/RLS ; ne pas additionner ces 58 une seconde fois |
| ACL/RLS avant correction | 40 échecs attendus sur 52 cas initiaux | Reproductions des permissions historiques, pas constat d'exposition de production |
| ACL/RLS finale | **58/58 PASS** | SQL réel sous PGlite, deux placements de schéma ; migration non appliquée à distance |
| Edge functions Deno | **40/40 PASS**, vérification de types incluse | Vrais handlers, adaptateurs fournisseur simulés, aucune permission réseau |
| Versement avant correction | 5 échecs attendus sur 9 | Faux `paid`/notification/courriel reproduits avec données fictives |
| Lecture Stripe avant correction | 3 échecs attendus sur 4 | Dates Basil, produit inconnu, ambiguïté d'abonnements |
| Plans Node | **17/17 PASS** | Même suite : 5 échecs avant correction |
| Navigateur Chromium | **46/46 PASS** | 29 nouveaux scénarios commerce + 17 régressions ; routes/hooks réels, API Supabase simulée |
| TypeScript application et KARTA | **PASS** | Contrats statiques |
| Build application | **PASS** | Compilation Vite ; aucun déploiement |
| Contrats générés de base | **PASS** | Correspondance au catalogue SQL du générateur, pas reconstruction exhaustive du schéma de production |
| ESLint fichiers modifiés | **PASS**, aucun avertissement | Production et tests du lot |
| ESLint dépôt entier | **PASS**, 0 erreur, 30 avertissements | Avertissements hors fichiers modifiés ; ne pas présenter le dépôt comme sans dette |
| ONE tests existants | **244/244 PASS**, aucun ignoré | Source produit inchangée |
| ONE TypeScript, lint, build | **PASS** | Next.js 16.4.5 ; routes produites statiques/SSG, pas un checkout intégré |
| ONE PostgreSQL privé réel | **23 contrôles PASS** | 13 livraison outbox + 10 inbox, PostgreSQL 18.4 sur Mac, deux clusters privés arrêtés après test |
| ONE observations promotion | **15/15 reproduites** | Inclut des tests démontrant l'absence de fonctionnalités ; ne compte pas comme promotion opérationnelle |

Les contrôles PostgreSQL ONE utilisent une copie temporaire neuve au même commit,
des sockets Unix propres et aucun port TCP. Ils couvrent concurrence, déduplication,
rollback, reprises, quarantaine, remboursements, bail de worker et acquittement
durable. Les deux serveurs ont été vérifiés arrêtés ; les journaux sont conservés.
Aucun cluster partagé n'a été utilisé. Le harness historique ciblant le cluster
partagé n'a pas été exécuté.

Les tests de production Docuseal/KARTA et les parcours vers des comptes réels ne
sont pas couverts par ces résultats. Chromium avec API simulée ne qualifie ni Safari
sur appareil réel, ni l'App Store, ni une transaction de production.

## Écarts confirmés dans le vrai ONE

1. **Promotion non implémentée.** `billing.ts` et `jobs.ts` exigent encore
   `paidCents === nominalCents` : 9950/24950 centimes sont refusés pour les offres
   19900/49900. Le composeur ne porte pas de politique promotionnelle et la requête
   Checkout ne contient pas de remise serveur. `allow_promotion_codes: false`
   interdit la saisie libre ; ce drapeau ne prouve pas à lui seul l'impossibilité
   d'appliquer un coupon serveur.
2. **Bienvenue unique.** `welcomeClaims` autorise une prime par client/programme,
   pas trois. Les tests avec trois paiements distincts produisent 9,95/0/0 EUR ou
   24,95/0/0 EUR sur les bases synthétiques remisées.
3. **Base de commission encore à rapprocher.** Le moteur calcule correctement 30 %
   d'une assiette fournie, mais le normaliseur fournisseur doit la justifier par le
   règlement correspondant. `validateCommerceJobs` vérifie les contextes communs,
   pas l'égalité économique entre une facture et un montant d'affiliation fourni
   séparément. Ce constat ne démontre pas une route publique exploitable.
4. **Clients directs et App Store.** L'affiliation exige actuellement un véritable
   affilié. Un avantage universel doit fonctionner sans inventer de faux parrain.
   Aucun adaptateur App Store n'a été qualifié ; la préparation actuelle est Stripe
   uniquement et garde `activationAllowed: false`.
5. **Intégration applicative absente du candidat.** Les ports de confiance,
   paramètres fournisseur, ingress authentifié, décisions fiscales/quota et
   persistance checkout doivent être raccordés. Les calculs et transactions testés
   ne constituent pas encore un achat complet depuis l'interface.

## Contrat de la prochaine extension ONE

Réutiliser le moteur ONE existant, ses transactions et son ledger. Conserver le
nominal 199/499 et ajouter une politique fermée et versionnée : remise 5000 points
de base, durée explicite 1 ou 3, règles d'éligibilité, référence de décision et
remise fournisseur vérifiée. Distinguer la période de promotion des encaissements
ouvrant droit à prime. Ne pas remplacer les contrôles actuels par une acceptation
générale de tout paiement inférieur au nominal.

Produire depuis un même règlement vérifié la période d'abonnement, l'assiette de
commission et le bénéfice client. Conserver montants et taxes en centimes, ainsi
que les identifiants stables fournisseur/compte/client/facture/ligne/période.
L'assiette HT/TTC/après frais et la référence de prix doivent être explicites.

Pour les trois primes, utiliser trois droits distincts et bornés, indépendants de
l'affiliation, partagés entre canaux. Rejeux, réinstallation, changement d'offre,
de politique ou de boutique ne recréent pas de droits. Conserver les réversions
compensatoires lors des remboursements et les preuves initiales.

À titre de calcul sur une assiette explicitement fournie, le moteur vérifié donne :

| Assiette | Commission 30 % | Bienvenue 10 % si échéance éligible |
| --- | ---: | ---: |
| 99,50 EUR | 29,85 EUR | 9,95 EUR |
| 199 EUR | 59,70 EUR | 19,90 EUR |
| 249,50 EUR | 74,85 EUR | 24,95 EUR |
| 499 EUR | 149,70 EUR | 49,90 EUR |

Ces exemples ne choisissent pas l'assiette fiscale ni le financement de production.

## Blocages de mise en service et responsabilités

| Blocage | Travail nécessaire | Responsable fonctionnel |
| --- | --- | --- |
| Politique promotionnelle ONE | Contrat versionné et validations partagées checkout/facture | Équipe produit et backend ; arbitrage financier propriétaire |
| Prime trois échéances et acquisition directe | Registre de bénéfices universel, migration explicite des anciens claims si nécessaire | Backend commerce |
| Fournisseur et attribution | Faits vérifiés communs, identité client, prix et comptes TEST, parcours de bout en bout | Backend et intégration paiement |
| App Store | Produits/offres, reçu/notification vérifiés, liaison de compte et tests sandbox | Équipe mobile |
| Versement | Prestataire réel, identifiant durable, rapprochement et reprises | Backend paiement et opérations |
| Schéma historique réel | Inventaire des politiques/colonnes et lecture de provenance avant migration | Responsable base de données |
| Signature/renouvellement legacy | Opérations serveur autorisées en remplacement des écritures clientes | Backend legacy |
| Webhook legacy | Encaissement réel, renouvellements, déduplication, remboursements et attribution ; ancien calcul annualisé encore présent | Backend legacy, lot distinct |

## Reproduction locale du lot

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run build
npm run lint
npm run check:database-contracts
node --test tests/quality/commerce-ui-plans.test.mjs
npm run test:quality
deno test --no-remote --allow-env=WEBHOOK_SECRET,SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,RESEND_API_KEY,STRIPE_SECRET_KEY --config tests/commerce/deno.json tests/commerce
cd karta
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
```

La suite navigateur nécessite Chromium installé par Playwright, ou
`PLAYWRIGHT_EXECUTABLE_PATH` vers un exécutable disponible. L'audit a utilisé Chromium
147.0.7727.0 ; l'archive officielle Playwright reçue était tronquée et un runtime
Chromium fourni par un paquet npm a permis d'exécuter les mêmes tests.

## Statut de publication

Correctifs proposés sur une branche distincte, PR en brouillon vers PR14. Aucune
fusion, migration de production, activation de promotion, transaction fournisseur,
campagne publicitaire ou publication App Store n'est réalisée par cet audit.
L'autodéploiement Vercel de cette branche est explicitement désactivé.

GitNexus a été utilisé avant modification. `getPlan` et `useSubscription` ont un
impact CRITICAL, signalé avant les changements. Les entrées anonymes edge et certains
objets SQL ne sont pas reliés par le graphe ; recherche d'appelants et tests réels
complètent cette limite. L'extension de recherche textuelle de GitNexus n'était pas
disponible ; aucune absence de résultat n'a été interprétée comme absence d'usage.
