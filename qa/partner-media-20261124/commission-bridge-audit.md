# Réception — contrat médias à 30 % et raccord commercial

## Verdict

**PARTIEL : le taux de 30 % est figé dans la proposition et le contrat médias ; il n’existe pas de chaîne de commission et de virement automatique raccordée à ce contrat dans ce checkout.** Aucun paiement, rattachement de bénéficiaire ou modification de mécanique financière n’a été effectué pendant cette revue.

L’absence de raccord n’entraîne pas un retour silencieux au barème historique de 50 % / 10 %. Les composants de paiement actuellement versionnés ne consomment pas le snapshot de ce contrat. Ils ne produisent donc pas de commission médias à partir de celui-ci.

Périmètre initial : code local de la branche `fix/partner-media-readiness-20261124`, base `18c40d0eb59b48636dd8d8fb54c0516b700ed746` et changements présents le 24 novembre 2026. La lecture complémentaire de ONE ci-dessous étend ce périmètre à des sources immuables identifiées. Aucun état de production ou workflow n8n non versionné n’est supposé connu.

### Rapprochement avec PURAMA ONE

**Le moteur d'affiliation existe déjà dans ONE et doit être réutilisé.** La limite constatée ici concerne son raccordement au parcours médias de PURAMA AI, pas l'absence d'un moteur dans l'écosystème.

Lecture directe complémentaire du 24 novembre 2026 à la révision `a5fed2edaaa2332c0e9aba3321d9ee32cf89a17e` :

- [`affiliation.ts`](https://github.com/puramapro-oss/purama-one/blob/a5fed2edaaa2332c0e9aba3321d9ee32cf89a17e/src/server/commerce/affiliation.ts) fournit notamment `bindAttribution` et `allocateAffiliation` : attribution, calculs et corrections de remboursement existent.
- [`postgres-affiliation.ts`](https://github.com/puramapro-oss/purama-one/blob/a5fed2edaaa2332c0e9aba3321d9ee32cf89a17e/src/server/commerce/postgres-affiliation.ts) fournit `PostgresAffiliationStore`. Cet adaptateur se présente comme un adaptateur de test et exige un pool qualifié ; sa présence ne prouve pas une base opérationnelle raccordée.
- [`product-referral.ts`](https://github.com/puramapro-oss/purama-one/blob/a5fed2edaaa2332c0e9aba3321d9ee32cf89a17e/src/lib/rewards/product-referral.ts) appelle réellement le moteur pour la part directe de 3 000 points de base, avec `simulationOnly: true`, `paymentAllowed: false` et `referralLinkCreated: false`. Le circuit lieu possède une répartition distincte, à préserver.
- La [PR ONE 82](https://github.com/puramapro-oss/purama-one/pull/82) est ouverte, en brouillon et non fusionnée au moment de cette lecture. Les tests qu'elle rapporte n'ont pas été rejoués par ce lot.

Le futur raccord doit relier contrats signés, identités, politique structurée et événements d'encaissement au moteur et au registre existants. Il ne doit pas créer un second moteur de commissions ni transformer une simulation en ordre de paiement.

| Étape | État observé | Conséquence |
| --- | --- | --- |
| Proposition médias | Taux déterministe 30 %, offre qualifiée, circuit rédactionnel séparé | Le texte commercial ne dépend pas des taux historiques configurés |
| Préparation du contrat | Snapshot médias 30 % / 30 %, offre et dix clauses exactes ; PDF à approuver | Les conditions sont conservées dans le document et sa preuve |
| Signature | Le hub DocuSeal projette la signature sur `partner_prospects` | Le prospect peut devenir `contract_signed` |
| Activation de l’affilié | Aucun écrivain runtime de `partner_active` trouvé dans ce dépôt | Aucun code d’affiliation médias n’est créé par cette signature |
| Attribution au checkout | Seuls les codes `influencers` sont acceptés | Le code éventuel d’un partenaire médias n’est pas relié à ce checkout |
| Calcul des commissions médias | Aucun écrivain runtime de `partner_commissions` trouvé | Aucun droit financier n’est automatiquement calculé à partir du PDF |
| Versement | Aucun prestataire de transfert raccordé au processeur de commissions | Aucun virement automatique ne peut être annoncé |

## Preuves dans le code

### 1. Le contrat conserve le taux, mais ne crée pas l’affiliation

`supabase/migrations/20261124050100_partner_media_policy.sql`, fonction `partner_contract_context`, ajoute aux seuls snapshots médias : `outreach_profile`, `media_terms_version`, les deux taux à 30, `eligible_offer` et `media_contract_terms`. Le snapshot legacy conserve sa forme et ses taux historiques.

`supabase/functions/partner-generate-contract/media-contract.ts` vérifie ces deux taux et produit un texte déterministe. La suite `karta/test/partnerMediaContract.test.ts` a effectivement passé 31 tests locaux, avec le véritable handler et le véritable rendu PDF. Cette preuve ne couvre pas le calcul ni le versement d’une commission.

`supabase/migrations/20261123003000_partner_contract_dispatches.sql`, fonction `partner_contract_project_signature`, met à jour uniquement `contract_signed_at` et, selon l’état courant, `status='contract_signed'` dans `partner_prospects`. Elle n’insère aucun partenaire actif, aucun code et aucune commission.

`supabase/functions/contracts-webhook/index.ts` reçoit le cycle de signature dans le hub et n’ajoute pas de raccord d’affiliation. `AGENT-PARTENARIAT-BRIEF.md` décrit un futur workflow « Contract & Onboarding » ; cette description ne constitue pas un workflow exécutable présent dans `n8n/`.

### 2. Les tables du module Partenaires sont des structures et des vues de suivi

`supabase/migrations/20260406230000_partner_agent.sql` crée `partner_active` et `partner_commissions`. Leurs lectures sont utilisées par `src/lib/partner.ts`, `src/pages/PartnerAgentPartners.tsx` et le rapport hebdomadaire n8n.

La recherche de toutes les références à ces tables dans le dépôt n’a trouvé aucun écrivain de production après signature ou paiement. `partner_active` n’a pas de référence au contrat signé ni de snapshot des conditions financières. `partner_commissions` ne définit pas une unicité économique de la vente et ne porte pas de devise propre à chaque écriture. Les simples droits historiques d’écriture du propriétaire ne prouvent ni un paiement ni un calcul serveur fiable.

Le texte historique de l’état vide de `PartnerAgentPartners.tsx` annonçait qu’un signataire apparaîtrait avec son code. Cette promesse a été remplacée, après contrôle d’impact, par l’état réel : suivi des signatures dans Prospects, activation et attribution encore à finaliser. Les réglages médias indiquent aussi que le 30 % est contractuel et que le calcul et le versement automatiques ne sont pas encore raccordés.

### 3. L’affiliation commerciale existante est un autre circuit

`supabase/functions/create-checkout/index.ts` vérifie exclusivement une ligne `influencers` : code actif, contrat marqué signé, bénéficiaire différent de l’acheteur et date d’expiration. Le checkout transmet `referral_code` et `influencer_id`. Il ne lit ni `partner_active`, ni `partner_contract_dispatches`, ni les conditions médias.

Ce circuit applique aussi son coupon historique de réduction de 50 %. Relier simplement un nouveau média à cette table réutiliserait donc une promotion distincte, sans choix explicite dans le contrat médias.

`src/hooks/useInfluencer.ts`, `useReferralTracking`, stocke un indice navigateur avec une fenêtre historique de 30 jours. `src/pages/Pricing.tsx` transmet ce code au checkout. Cette fenêtre existante ne définit pas la fenêtre contractuelle médias : la rubrique `attribution` reste du texte fourni par l’opérateur. Un indice dans le navigateur n’est pas une preuve suffisante de droit à commission.

### 4. Les encaissements observés ne sont pas des commissions acquises

`supabase/functions/_shared/stripe-reconciliation.ts` et `supabase/migrations/20261110100000_stripe_reconciliation_events.sql` fournissent une base réutilisable d’événements Stripe authentifiés, dédupliqués par compte, environnement et événement. Ils conservent montants, devises, factures, lignes, remboursements et indices d’attribution sans inventer de droit financier.

`supabase/functions/stripe-webhook/index.ts`, cas `invoice.paid` et `invoice.payment_succeeded`, indique explicitement que cette réception ne crée pas de commissions et attend une politique commerciale et un rapprochement. Le normaliseur ne retient actuellement que les indices `user_id`, `influencer_id` et `referral_code`, sans identifiant de contrat médias.

### 5. Stripe Connect existe pour le compte bénéficiaire, sans raccord de versement médias

`public.connect_accounts`, `supabase/functions/connect-account-session/index.ts` et `src/lib/stripe-connect.ts` fournissent l’enregistrement du compte Connect et des sessions pour ses composants. Ils ne démontrent pas qu’un transfert vers ce compte a eu lieu.

`supabase/functions/process-influencer-payments/index.ts` refuse volontairement le traitement par une réponse 503 « Aucun prestataire de virement configuré », sans modifier les commissions ni annoncer un transfert. La recherche des appels `transfers.create` / `payouts.create` dans les fonctions de ce dépôt n’a trouvé aucun processeur de versement médias.

Attention à l’identité : `partner_active.user_id` est actuellement le propriétaire du module qui prospecte. `public.connect_accounts.user_id` est le titulaire du compte bénéficiaire. Les confondre paierait le mauvais compte ; une adresse email de prospect ne suffit pas à établir le rattachement.

## Un règlement manuel est-il possible ?

**Un règlement manuel externe reste possible à condition que les parties aient effectivement convenu des conditions et que l’opérateur effectue le rapprochement sur des preuves de vente. Le module ne le réalise pas actuellement.** Il ne faut ni annoncer un paiement automatique ni considérer un statut local « paid » comme une preuve bancaire.

Le parcours manuel doit conserver le contrat effectivement signé, l’identité du bénéficiaire, les ventes explicitement attribuées selon les conditions convenues, les encaissements admissibles hors taxes après remises et remboursements, la devise et la preuve du règlement. Le taux de 30 % s’applique à cette assiette établie ; la présence d’une vente ou d’un clic ne permet pas, à elle seule, de décider son admissibilité.

Une facture, un relevé et une référence de virement peuvent servir au suivi hors du logiciel. Leur conservation ou leur saisie éventuelle dans le produit doit être présentée comme une opération manuelle documentée. Aucune validation juridique, fiscale ou bancaire de ce parcours n’a été faite dans cet audit de code.

## Extension minimale réutilisant l’existant

1. **Définir une politique exécutable liée au contrat.** Il manque le rattachement réel des offres aux produits/prix du catalogue, les pays admissibles, la règle d’attribution et sa durée, les échéances récurrentes couvertes, les dates d’effet et de fin, la devise, les arrondis, les retours et le calendrier de règlement. Ces valeurs doivent être des données structurées réellement choisies. Aucun agent ne doit les déduire des dix rubriques de texte libre.
2. **Raccorder le signataire au partenaire et au bénéficiaire.** Étendre `partner_active` avec la provenance du contrat, le snapshot approuvé et une identité bénéficiaire vérifiée, en préservant les lignes historiques. Une opération serveur idempotente doit prendre les données du contrat effectivement signé, jamais les taux courants de `partner_agent_config` ou une valeur du navigateur. L’activation doit attendre les données d’attribution nécessaires.
3. **Raccorder les liens et codes au checkout existant.** Réutiliser les composants de partage et le parcours d’achat, avec un espace de codes explicite et une résolution serveur vers l’accord médias. Ne pas hériter implicitement du coupon influenceur de 50 % ni de sa fenêtre navigateur de 30 jours. Un panneau, un QR code et une publication peuvent être des supports distincts du même accord, sans créer plusieurs commissions pour une seule vente.
4. **Rapprocher les événements Stripe existants.** Réutiliser `stripe_reconciliation_events` et l’authentification du webhook. Relier les indices de paiement au contrat et à la politique, vérifier le compte Stripe, le mode test/réel, le client, l’abonnement ou le paiement, les produits et les remboursements. Les événements incomplets restent à examiner.
5. **Raccorder le moteur et le registre d'affiliation ONE existants.** Réutiliser leur politique, leur attribution immuable, leurs calculs et remboursements, avec un adaptateur de persistance qualifié. Relier la provenance, la devise, les montants dans l’unité minimale, la version de politique et l'unicité économique au suivi Partenaires. Éviter un deuxième registre financier faisant autorité. Le calcul médias doit utiliser le 30/30 figé du contrat admissible, sans écraser les conventions des circuits physiques.
6. **Raccorder un règlement prouvé.** Réutiliser le compte Connect vérifié quand ce parcours est choisi, avec réservation du règlement, clé d’idempotence, preuve durable du prestataire et rapprochement des résultats incertains. Tant que ce raccord manque, le produit doit afficher un règlement manuel documenté ou un état à configurer, jamais un versement automatique accompli.

## Critères de réception du futur raccord

- Un contrat legacy conserve son barème ; un contrat médias signé à 30/30 n’est pas modifié par un changement ultérieur de la configuration à 50/10.
- Un contrat non signé, éditorial, expiré ou sans politique structurée ne crée pas de commission.
- Deux webhooks distincts concernant le même encaissement et vingt répétitions d’un même événement ne créent qu’un droit économique.
- Un renouvellement, une remise, une taxe, un remboursement partiel, une annulation et une devise différente utilisent les règles réellement convenues et des montants vérifiés.
- Un code média ne déclenche pas de coupon historique implicite ; une attribution non prouvée reste à examiner.
- Aucun compte de prospect n’est confondu avec le compte du propriétaire du module.
- Un délai réseau après acceptation d’un transfert ne déclenche pas un second transfert ; le statut payé exige sa preuve.

## Méthode et limites de la revue

La requête GitNexus est archivée dans `query-commission-bridge.json`. L’index ciblé ne dispose pas de recherche FTS et n’a renvoyé aucun parcours pour cette requête. La conclusion repose ensuite sur la lecture des fichiers cités et la recherche de leurs usages dans le dépôt, pas sur ce résultat vide du graphe. Aucun test financier, SQL local, virement, appel Stripe ou modification de politique financière partagée n’a été réalisé pour cet audit.
