# Vérification du webhook Stripe — 2026-11-10

## Périmètre

Le banc exécute le véritable `supabase/functions/stripe-webhook/index.ts` et le véritable helper `overage.ts` dans une VM Node. La transpilation utilise le TypeScript déjà installé dans le dépôt. Stripe, Supabase Auth/DB et Resend sont remplacés par des dépendances inertes. Le serveur est capturé ; les imports inconnus, les appels réseau et les envois d'email sont interdits.

```sh
node --test --test-concurrency=1 tests/billing-webhook/handler.test.mjs
```

**PASS : 65 tests, 0 échec, code de sortie 0**, Node 24.22.1 ; dernier passage environ 0,8 s. `git diff --check` : code de sortie 0.

Les fixtures vérifient le comportement applicatif après la frontière de vérification de signature. Elles ne vérifient ni la cryptographie du SDK Stripe, ni une connexion réseau réelle, ni le schéma déployé.

## Garanties vérifiées dans ce périmètre

- Identité issue du `user_id` serveur signé et obtenue par `auth.admin.getUserById`, sans recherche dans une page d'utilisateurs par email.
- Nouvelle liaison customer acceptée seulement avec `customer.metadata.user_id` concordant ; compatibilité sans métadonnées de session limitée à une liaison DB existante et unique. Contradictions session/customer/subscription/utilisateur, customer supprimé et mode test/live refusés.
- Un seul abonnement ouvert, un seul produit connu, absence de pagination incomplète. Les trois mappings Starter/Pro/Ultime sont préservés.
- Aucun droit actif pour un checkout `unpaid`, ni conversion d'un état `incomplete`, `unpaid`, `past_due`, `paused` ou annulé en `active`.
- Un checkout terminé mais impayé est acquitté comme réception en attente, sans écriture. L'événement de réussite différée reprend le chemin validé. Les coupons à montant final nul restent compatibles avec `no_payment_required`.
- Essai Stripe existant conservé comme `trialing` avec échéance future vérifiée. `has_used_trial` n'est jamais réinitialisé à `false`, y compris lors d'une mise à jour concurrente.
- Création d'une ligne absente et mise à jour conditionnelle avec retour DB vérifié. Erreur, absence de ligne écrite ou reçu contradictoire : HTTP 500 pour réessai. Un état déjà identique est vérifié puis acquitté sans nouvelle écriture de droits.
- Rejeu séquentiel et concurrent, perte du reçu DB, échec puis reprise, et sérialisation PostgreSQL de dates `+00:00` versus `.000Z`.
- Les packs utilisent toujours le helper réel et le reçu RPC existant, pour paiement immédiat et différé.
- Première commission conservée quand `customer.subscription.updated` a déjà appliqué les droits avant la première réception du checkout avec parrainage.

## Limites explicites

**PARTIEL — commissions :** le sous-flux historique est conservé ; il reste non idempotent et non transactionnel. La vérification exécutée avec deux livraisons du même checkout parrainé observe **une écriture de droits, deux commissions et deux incréments de ventes**. Les erreurs de ce sous-flux peuvent toujours être seulement journalisées. Une migration séparée, avec contrainte d'unicité, reçu durable et transaction/outbox, est nécessaire avant toute promesse de livraison exactement une fois. Les formules, prix et taux ne sont pas modifiés.

**PARTIEL — cycle de vie :** les branches `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed` et `invoice.payment_succeeded` sont textuellement identiques au commit `90d8f303`. Leurs anciens risques d'ordre des événements, d'erreurs DB acquittées et de produit par défaut ne sont pas corrigés par ce changement. Il n'existe pas de `stripe_subscription_id` ou de version d'événement stockée sur la ligne d'abonnement ; l'idempotence vérifiée ici concerne l'application d'un état identique aux droits, pas tous les événements Stripe.

**PARTIEL — concurrence et données :** la création concurrente repose sur `UNIQUE(user_id)`, déclaré dans la migration existante. Le banc reproduit cette contrainte sans prouver qu'elle est déployée. Une liste Stripe paginée ou plusieurs abonnements ouverts exigent une réconciliation ; aucun élément arbitraire n'est choisi.

**PARTIEL — délais :** le SDK Stripe conserve un délai de 10 s par requête et ses réessais internes sont désactivés pour laisser Stripe relivrer l'événement. Ce correctif ne borne pas toute la lecture du corps ni toute l'attente Supabase du webhook.

**BLOQUÉ dans ce banc — contrôle de types SDK natif :** `deno check --no-config --no-lock --no-remote --no-npm supabase/functions/stripe-webhook/index.ts` refuse le module distant `std@0.190.0/http/server.ts`. Une tentative `--cached-only` a été interrompue après des messages de résolution. La VM valide la transpilation/syntaxe et l'exécution ; elle ne remplace pas le contrôle des types SDK. Ce contrôle est confié à l'intégration principale.

**NON TESTÉ :** Stripe/Supabase/Resend réels, signature cryptographique réelle, déploiement, paiements ou emails réels. Aucune installation, migration, publication ou action fournisseur n'est effectuée par ce banc.

## Analyse préalable et contre-épreuve

Avant édition, GitNexus 1.6.12 `impact` upstream a été exécuté sur le fichier et sur le callback `serve`, avec le chemin absolu du dépôt. Le fichier retourne zéro appelant résolu et un risque **UNKNOWN**, avec avertissement de couverture ; le callback n'est pas indexé. Ce résultat ne signifie pas absence de risque. La revue manuelle considère ce chemin d'attribution de droits comme critique.

Le code du commit `90d8f303` exécuté dans la même fixture échoue au cas valide de création, car il tente la pagination Auth par email au lieu de `getUserById`. Le cas correspondant passe sur le code corrigé. Les contre-exemples précédents du traitement initial — activation `unpaid/incomplete`, mauvaise identité par email et erreurs DB acquittées — ont motivé les régressions couvertes ici.

Le fichier de tests accepte facultativement `PURAMA_WEBHOOK_TEST_SOURCE=/chemin/vers/index.ts` pour exécuter une source de référence locale. Aucun appel fournisseur ne devient disponible avec cette option.
