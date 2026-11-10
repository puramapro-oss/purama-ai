# Réconciliation OTS / DocuSeal du 10 novembre 2026

Cette livraison fusionne réellement les historiques `27d226590f8fb490abd4c637c8c8946637177893` et `58a85a9f7ae0c20abc37158ea0901243e0bf2acd`. Elle n'a pas été déployée. Les journaux du dossier `qa/contracts-reconciliation-20261110` et du précédent document OTS décrivent leurs commits d'origine ; ils ne constituent pas des exécutions de ce résultat.

## Contrats conservés et évolutions explicites

- Le stamper exige la clé de service exacte ou une identité vérifiée dont `public.has_role(user_id, admin)` retourne strictement le booléen `true`. Les tables restent dans `purama_ai`. Aucun environnement ne désactive le secret du webhook.
- Le lecteur UTF-8 est unique : `request-body.ts`. `ots-body.ts` est seulement son adaptateur JSON. Le stamper conserve sa limite de 4 KiB, le webhook conserve 64 KiB ; le délai total de lecture devient 5 secondes. Les caractères, y compris un BOM, restent exacts pour HMAC ; UTF-8 invalide, longueur incohérente, interruption et dépassement sont refusés. Annulation de flux et libération du lecteur ne peuvent bloquer la réponse.
- Le Bearer valide **ou** un HMAC cryptographiquement valide autorise désormais le webhook. Cette extension de l'admission, issue de `58a85a9`, a été approuvée explicitement. Un HMAC mal formé ne provoque aucune lecture. Un HMAC de forme valide exige le corps borné puis sa vérification ; il n'est jamais accepté par sa seule présence.
- Un ensemble de signataires absent ou vide produit désormais 409. C'est une modification explicite de l'attente historique 200 ; cela ne prouve jamais une signature complète. Les valeurs truthy ne remplacent pas `signed === true`.
- Les IDs restent des entiers sûrs strictement positifs, requis selon l'événement ; le nom d'événement conserve son format et sa longueur maximale de 64 caractères. Ces contrôles précèdent la création du client privilégié.
- Les erreurs de lecture/écriture et d'audit DB ne deviennent pas un succès. Les mises à jour de signataire sont liées au contrat et les mutations de contrat vérifient son statut et sa soumission. Les états terminaux et les changements concurrents restent protégés.
- Le hachage porte sur les octets exacts du PDF. Une preuve sans attestation est refusée. Le correctif des preuves malformées et des preuves vides est conservé dans `verifyProof`. Les erreurs privées du fournisseur ne sont pas exposées par les réponses ou les logs du stamper.

## Accusé de livraison OTS corrigé

Le contre-exemple exécutait les vrais handlers avec des ports externes simulés : le webhook renvoyait 200 tandis que le stamper renvoyait 500 sur l'écriture de preuve. Avant correction, les 8 régressions de livraison ajoutées échouaient. Après correction, elles passent.

Le webhook attend maintenant le résultat HTTP du stamper. `ots-delivery.ts` impose un délai monotone total de 15 secondes, combine AbortController avec une course de promesses, interdit les redirections et annule sans attendre un éventuel corps de réponse. Cela borne aussi un transport qui ignore l'annulation. Un refus HTTP ou une erreur réseau produit 502, le délai produit 504, et l'interruption de la requête produit 503. Aucun corps d'erreur fournisseur n'est lu ou communiqué. L'absence d'URL dans les métadonnées ne saute plus silencieusement le déclenchement : le stamper résout lui-même le document signé.

Les contrats déjà signés restent éligibles à une nouvelle livraison. Le test causal fait échouer la première écriture de preuve puis réussit au retry sur le même état signé. Les écritures de contrat, la preuve et les audits **ne forment pas une transaction** : un retry peut répéter un audit `signed`, voire un estampillage après un résultat réseau incertain. Le timeout n'annule pas un effet déjà exécuté par le serveur distant. Aucune file durable, migration ou garantie d'exécution unique n'a été ajoutée. Les appels DB et DocuSeal antérieurs sont des phases distinctes ; les 15 secondes ne sont pas une borne globale du webhook.

## Vérifications fraîches

Node **v22.23.4**, Deno **2.9.6** avec contrôle TypeScript activé. Aucun test n'est ignoré. Deno interdit le réseau et l'exécution de processus ; tous les fournisseurs, la DB et les transports d'authentification des tests Node sont remplacés par des fixtures fermées. Les handlers et la bibliothèque verrouillée OpenTimestamps sont réels.

| Suite | PASS | FAIL | Statut |
| --- | ---: | ---: | --- |
| auth | 24 | 0 | PASS |
| integrity | 62 | 0 | PASS |
| content-historical | 17 | 0 | PASS |
| authorization-reconciled | 124 | 0 | PASS |
| content-incoming | 15 | 0 | PASS |
| webhook-security | 5 | 0 | PASS |
| request-body | 30 | 0 | PASS |
| ots-delivery | 21 | 0 | PASS |
| deno-native | 54 | 0 | PASS |

Le total Node courant est **298 tests**, et le total natif courant est **54 tests**. Les anciens nombres **103 / 50** sont des états historiques, pas des tests supplémentaires à additionner. Les suites se recoupent intentionnellement pour assurer la continuité des deux parents ; ces comptes ne décrivent pas autant de défauts distincts. Les 24 assertions d'autorisation d'origine sont identiques après leur fixture ; le test Bearer/HMAC et l'attente des signataires vides ont les changements de contrat décrits ci-dessus.

ESLint ciblé : PASS, zéro avertissement. La recette globale site/KARTA/types/build/Chromium est à effectuer sur l'assemblage final du parent, distinct de cette recette OTS. Aucune exécution hébergée, preuve de confirmation Bitcoin, livraison de fournisseur réel ou validation de données de production n'est revendiquée.

## Commandes

Préfixer le `PATH` par le répertoire du binaire Node 22 utilisé, puis exécuter les scripts de sécurité et d'autorisation retenus dans l'assemblage final. La recette détaillée, par suite, utilise :

```sh
node --experimental-vm-modules --experimental-strip-types --test --test-reporter=tap --test-concurrency=1 tests/contracts-ots-auth.mjs tests/contracts-ots-integrity.mjs tests/opentimestamps-content.mjs tests/contracts-ots-authorization.test.mjs tests/opentimestamps-content.test.mjs supabase/functions/_shared/webhook-security.test.ts supabase/functions/_shared/request-body.test.ts supabase/functions/_shared/ots-delivery.test.ts
```

```sh
deno test --config tests/contracts-ots-native/deno.json --cached-only --no-prompt --deny-net --deny-run --allow-read="$PWD/node_modules" --allow-env=SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,SUPABASE_ANON_KEY,DOCUSEAL_API_URL,DOCUSEAL_API_TOKEN,DOCUSEAL_WEBHOOK_SECRET,NODE_DEBUG,NODE_DEBUG_NATIVE,NODE_ENV,NODE_NDEBUG,BLUEBIRD_DEBUG,BLUEBIRD_WARNINGS,BLUEBIRD_LONG_STACK_TRACES,BLUEBIRD_W_FORGOTTEN_RETURN tests/contracts-ots-native/runtime.ts tests/contracts-ots-native/webhook-runtime.ts tests/contracts-ots-native/webhook-donor-runtime.ts tests/contracts-ots-native/body-runtime.ts tests/contracts-ots-native/delivery-runtime.ts
```

Les commandes exactes, versions, sorties, dates, empreintes des sources et codes de sortie se trouvent dans le reçu de livraison `resume-evidence/ots-final-merge/gate-receipts.json`. Les sources sont restées identiques entre le début et la fin des gates. L'index GitNexus reste incomplet sur les callbacks et dynamiques de runtime ; ses absences d'arêtes ne sont pas une preuve d'absence d'impact.
