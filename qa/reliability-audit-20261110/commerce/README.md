# Commerce : restauration contrôlée des protections Stripe

## Résultat et périmètre

**PASS pour la qualification locale de ce lot.** Le webhook restauré passe les 82 tests commerciaux existants et réintégrés, sur Linux puis macOS. Le contrôle Deno avec les véritables types des SDK passe sur macOS. Le fichier de régression du crédit de dépassement passe ensuite ses 38 cas complets avec Node 22, après correction d'une préparation de base de test qui dépassait son délai d'assertion.

Ces résultats ne sont pas une qualification de Stripe, Supabase ou des paiements de production. Aucun paiement, email, changement de tarif ou migration distante n'a été effectué. La publication et la CI du candidat assemblé sont suivies par le rapport principal.

Le lot possède cinq fichiers de code, configuration et test :

- `supabase/functions/stripe-webhook/index.ts` ;
- `tests/commerce/deno.json` ;
- `tests/commerce/webhook-handler.test.ts` ;
- `tests/commerce/webhook-provider-fixture.ts` ;
- `karta/test/overageCredit.test.ts`.

Le raccordement du script npm et du contrôle hébergé appartient à l'assemblage principal. Le script commercial doit permettre la variable **inerte** `STRIPE_WEBHOOK_SECRET` de ses fixtures et interdire explicitement les opérations réseau et les processus externes, comme la commande de qualification ci-dessous.

## Provenance : travaux existants réutilisés

Le handler de la tête `1a49ad646b529c6fb95335105c8a4e5f28468d76` est identique à l'entrée du correctif historique `iao-webhook-qa-20261110-3e970b5859`. La sortie de ce premier correctif est elle-même identique à l'entrée de `iao-webhook-retry-20261110-64e178ce73`.

| Source du handler | SHA-256 |
| --- | --- |
| Tête initiale / entrée du lot qa | `58f19152f9c54dd0d412cf73761279d7edbe5bd56b1803b353dd09487c27109d` |
| Sortie qa / entrée retry | `eca53b25f61e9cc06873e5aac4c1348a0d1c1a4797ff4f34b73ef26e6c11697f` |
| Sortie historique retry | `799ffc83f3f1447ba9d3cd0f70891c8db7f88b2cebbf04e5766b6616f3be4cce` |
| Source finale, après correction de typage | `d7ba53453b9ad088a5cfea56f1c010e5f7ba02235403634f37a3a236850801b7` |

Les deux fichiers de tests du webhook sont repris exactement du lot retry. Seul le scope Deno du webhook est ajouté à la configuration courante. Les scopes historiques d'un autre endpoint et leurs fixtures absentes ne sont pas recopiés. Le `serve-capture.ts` courant est conservé pour maintenir aussi les tests utilisant `Deno.serve`.

Les [empreintes des sources récupérées](provenance.json) et les [reçus historiques](historical-receipts.json) restent séparés des nouvelles exécutions.

## Comportements restaurés

Le webhook refuse les produits inconnus, supprimés, ambigus ou cachés par une pagination au lieu d'écrire arbitrairement un abonnement Pro. Les produits et clients développés en objets Stripe restent pris en charge. Une session terminée sans paiement confirmé attend le résultat du paiement ; la réussite asynchrone est reçue par le même parcours. Le statut et l'échéance d'un essai existant sont conservés.

Pour une mise à jour d'abonnement, le handler relit l'abonnement chez Stripe. Une activation exige la preuve de sa facture courante payée. Le code conserve les identifiants de produits et les règles commerciales historiques du dépôt.

La liaison de client Stripe déjà enregistrée est prioritaire sur l'email d'affichage et les métadonnées. Le recours aux anciens comptes sans liaison parcourt les pages d'utilisateurs jusqu'à épuisement, avec une borne de travail et des refus en cas d'ambiguïté, d'erreur, de répétition ou de conflit. Une écriture compare ensuite la liaison précédemment lue et exige le reçu de la ligne modifiée. Un échec ou une absence de reçu interrompt le traitement avant les étapes de commission.

Le pack de dépassement conserve son helper et sa frontière SQL existants. Les tests commerciaux et les 38 cas de régression vérifient notamment les reprises, les preuves perdues, les identités contradictoires et les droits d'accès aux crédits.

## Correction additionnelle établie par les vrais SDK

Les 40 tests réintégrés passaient avec le handler historique. Le contrôle Deno sans import-map de fixture a cependant révélé **18 erreurs de typage** : `ReturnType<typeof createClient>` perdait l'inférence des paramètres génériques du client et produisait des lignes de type `never`.

Une factory `createSubscriptionClient()` contient désormais exactement l'appel au client Supabase déjà présent, avec le schéma `purama_ai` et les mêmes paramètres. Le type des helpers provient du retour concret de cette factory. Aucun cast de contournement ni vérification désactivée n'est ajouté. Le contrôle final du handler utilise les imports officiels de son source, sans substitution de SDK.

Le premier essai de résolution des SDK sous Linux avait été bloqué par une connexion refusée vers `deno.land`. Ce blocage d'environnement est conservé ; il n'est pas présenté comme un échec de compilation du source. Le contrôle macOS a fourni le diagnostic de types puis le résultat final réussi.

## Qualification fraîche

| Contrôle | Résultat | Preuve |
| --- | --- | --- |
| Contre-épreuve sur le handler initial exact | 9 PASS, 31 FAIL sur 40 | [journal avant](webhook-before.txt) |
| Restauration historique, avant correction de type | 40/40 PASS | [journal restauré](webhook-restored.txt) |
| Ensemble commercial final, Deno 2.9.6 Linux | 82/82 PASS ; 1,817 s pour la commande | [journal Linux](commerce-final.txt) |
| Ensemble commercial final, Deno 2.9.7 macOS | 82/82 PASS ; 3,084 s ; entrées identiques avant/après | [reçu macOS](commerce-mac-final-result.json) |
| Vrais types des SDK, handler historique restauré | 18 erreurs | [diagnostic](sdk-historical-patch-errors.txt) |
| Vrais types des SDK, handler final | PASS ; 14,571 s ; source finale identique entre machines | [journal final](sdk-final.txt), [commandes](commands.json) |
| Crédit de dépassement, source et fixture finales | 38/38 PASS ; Node 22.23.3 / Vitest 5.0.3 ; 8,456 s | [reçu final](overage-mac-final-result.json), [journal](overage-mac-final.txt) |
| ESLint du handler, des deux tests restaurés et de la fixture de crédit | PASS, aucune erreur ou sortie | [commandes](commands.json) |
| Conservation du bloc commissions, des produits et prix | Identités contrôlées | [preuve de conservation](restoration-preservation.json) |

Les 40 cas font partie des 82 cas commerciaux. Les exécutions Linux et macOS couvrent la même suite ; leurs nombres ne sont pas additionnés. Les tests de crédit et du webhook se recouvrent fonctionnellement. Les fixtures remplacent les transports, la vérification de signature Stripe et les SDK des tests commerciaux. Le fichier de crédit exécute les vrais SQL sous PGlite, qui reste un seul backend et ne prouve pas la concurrence de plusieurs sessions PostgreSQL natives.

### Pourquoi la fixture de crédit a changé

Deux tentatives Linux ont été interrompues par SIGKILL ou expiration de préparation. Sur macOS, la première passe a ensuite réussi 37 cas et expiré sur le dernier, qui ouvrait sa propre instance PGlite dans le délai de test de cinq secondes. Sa reprise isolée a également expiré. Ces échecs ne sont pas effacés.

Une copie instrumentée utilisant le même runner a mesuré **6 646 ms de préparation, 103 ms d'assertions SQL et 9 ms de fermeture**. Elle a conservé le délai initial et a échoué. Cette mesure est un diagnostic, pas un résultat de qualification.

Le dernier cas initialise maintenant sa base dans `beforeAll` et la ferme dans `afterAll`, comme les autres cas SQL du fichier. La préparation bénéficie du délai de hook préexistant de 30 secondes. Les assertions conservent le délai de test de cinq secondes ; la durée totale permise de préparation et d'exécution est donc distincte. Les six instructions de requête et de vérification, dont les trois assertions, sont identiques par comparaison de l'arbre syntaxique. Le helper `database` et les migrations sont inchangés. La [preuve de conservation](fixture-preservation.json), le [diagnostic instrumenté](vitest-phase.txt) et son [patch reproductible](phase-instrumentation.patch) sont conservés.

Une nouvelle passe **complète** du fichier final réussit les 38 cas, sans cas ignoré. Les empreintes de ses neuf entrées sont contrôlées avant et après.

## Analyse d'impact et limites

GitNexus a été interrogé avant les modifications sur les UID exacts du handler et du fichier de test, en vérifiant que les fichiers indexés correspondaient aux sources auditées. Le graphe retourne **UNKNOWN** pour ces nœuds fichier, avec un avertissement explicite sur les appels non résolus. Le complément de contexte du handler s'est terminé avec le code 137, sans cause établie. Le callback HTTP a donc aussi été relu manuellement. La portée métier est **CRITICAL** : identité, droits payants et frontière avant commissions. L'absence d'arête du graphe n'est pas un classement de risque faible.

Le bloc de calcul, d'écriture et de notification des commissions reste identique, sur 5 484 octets. Cette conservation ne lui ajoute pas de déduplication ou d'atomicité. Les cas de répétition des commissions, l'ordre global des événements, les suppressions d'abonnement et les factures échouées reçues tardivement nécessitent toujours leur propre rapprochement. Le schéma courant ne contient pas de liaison `stripe_subscription_id` sur laquelle cette restauration pourrait s'appuyer.

La documentation officielle [Stripe — webhooks](https://docs.stripe.com/webhooks) décrit les réessais, les doublons et l'absence d'ordre de livraison garanti. Cette restauration ne revendique aucune garantie globale « exactement une fois ».

Les anciens plans IAO 33/99/199 € et le pack 19 € / 2 000 actions restent inchangés dans ce lot. Les plans et règles de PURAMA ONE ne sont pas redéfinis ici. La pagination de secours est bornée à 50 pages de 1 000 utilisateurs, mais ce parcours ne dispose pas d'un délai global qualifié. L'accès réel au fournisseur, les données de production, les rôles déployés et les limites commerciales complètes restent **NON TESTÉS**.

## Commande commerciale qualifiée

```sh
deno test --no-remote --no-prompt --deny-net --deny-run \
  --allow-env=WEBHOOK_SECRET,STRIPE_SECRET_KEY,STRIPE_WEBHOOK_SECRET,SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,RESEND_API_KEY \
  --config tests/commerce/deno.json tests/commerce
```

Les [commandes et résultats](commands.json), le [manifeste des sources finales](integrated-source-manifest.json), les [entrées commerciales](commerce-inputs.json) et le [registre de normalisation des journaux](log-normalization.json) permettent de distinguer source historique, diagnostic, échec d'environnement et qualification finale.
