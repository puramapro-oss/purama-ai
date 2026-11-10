# IAO — réconciliation des contrats, 10 novembre 2026

**Statut : PARTIEL.** Le lot corrige les défauts reproduits ci-dessous. Il ne qualifie pas encore une mise en production : la CI du compte est bloquée et les fournisseurs, la passerelle hébergée et l'atomicité des événements restent à vérifier.

## Sources réconciliées

La recette de départ porte sur la PR #33, commit `0c7f7da1b4ecb0d93e00b1f73a55a3736b0f348c`, arbre `dde936db94d0d21880656de8ce76d9558fdc692a`, qui conserve les missions, budgets, voix, consentements et sessions. Ses fichiers KARTA, migrations et son lock de dépendances restent inchangés dans ce lot.

Le contrôle avant publication a détecté un avancement concurrent de cette PR vers `8631305fe0a4e0208566191b795ef876d9b5dfbe` (arbre `16d4f2b45afc7ba05f8c74ef71e1b209c7bcac0e`). Ce nouveau commit devient le **parent final** de la correction. Ses quatre lignes de workflow — déclenchement sur `main`, lancement manuel et exécution de tous les scénarios qualité — sont préservées. La seule ligne ajoutée à ce workflow par le présent lot est `npm run test:contracts-security`. Les empreintes prouvent que **482 des 483 fichiers** de la recette restent identiques ; le seul écart est ce workflow, vérifié séparément. Les unités inchangées ne sont pas rejouées artificiellement. Voir `concurrent-head-reconciliation.json` et la collecte des scénarios qualité.

La lecture des arbres et des fonctions a confirmé que plusieurs protections de la PR #32 (`3cd01de34447003ac7aad4a6ad54cf7524b77a67`) n'étaient pas présentes dans cette base. Elles sont reprises ici avec l'autorisation `has_role` de la PR #33. Aucun lot Entraide de la PR #23 n'est réappliqué ; ses fichiers ne recoupent pas ce correctif.

## Corrections et preuves

- **Preuves PDF cohérentes.** Les nouvelles preuves portent sur les octets bruts du PDF ; l'ancien format Base64 reste vérifiable. Les tableaux et buffers sont copiés avant les attentes asynchrones. L'absence d'attestation après l'appel OpenTimestamps devient un refus, même lorsque la bibliothèque absorbe toutes les erreurs de calendriers.
- **Identité et rôle serveur.** Le bearer interne exact reste admis ; les autres appels passent par `auth.getUser` et un résultat strictement booléen de `public.has_role`. Le schéma `public` est explicite pour cette RPC, alors que les contrats restent dans `purama_ai`. Le test utilisant le véritable SDK Supabase **2.91.0**, identique à l'import Edge, a reproduit l'ancien en-tête erroné `Content-Profile: purama_ai`, puis vérifié `public` et `Accept-Profile: purama_ai` pour les données de contrat. Les transports sont inertes : aucune base distante n'est appelée.
- **Écritures et événements fiables.** Les erreurs de lecture, de modification des signataires/contrats et d'insertion d'audit renvoient une erreur. Les signataires doivent exister ; une liste vide ne prouve pas la signature de tous. Seul `signed === true` vaut signature complète. Les mises à jour des signataires sont limitées au contrat sélectionné. Les écritures des contrats comparent l'état et la soumission lus, et les événements tardifs ne réactivent pas les contrats annulés, refusés ou expirés et ne dégradent pas un contrat signé.
- **Accès au PDF et anciennes confirmations.** Le jeton DocuSeal n'est transmis qu'à son origine exacte ; les redirections et URL non sûres sont refusées. Une nouvelle preuve efface les anciennes confirmations Bitcoin. L'acteur d'audit vient de l'identité vérifiée.
- **Admission HTTP bornée.** Le corps est limité à **256 Kio** pour le webhook et **8 Kio** pour l'horodatage, avec un budget absolu de **5 secondes**, UTF-8 strict, cohérence de `Content-Length`, interruption du client et limitation des morceaux vides. L'annulation du producteur n'est pas attendue. Un test du véritable handler a attendu le délai configuré puis obtenu HTTP 408 sans effet tardif. Le bearer invalide sans HMAC est refusé avant consommation du corps ; le HMAC porte sur le texte exact décodé, BOM compris.
- **Configuration et confidentialité.** Le secret webhook est indispensable dans tous les environnements. L'absence de configuration serveur est refusée. Les erreurs internes ne sont pas renvoyées au client et l'avertissement sur l'identifiant de soumission n'imprime plus les valeurs du payload.

## Recette exécutée

Les logs finaux proviennent de **Node 22.23.4**, la même majeure que le workflow. Les 483 fichiers source, configuration et test enregistrés sont identiques avant et après la recette ; ils ont encore été contrôlés lors de la préparation des preuves.

| Contrôle | Résultat |
|---|---|
| Sécurité contrats, vraies bibliothèques OTS et SDK, helpers HTTP | **158/158 PASS**, aucun cas ignoré |
| Autorisation héritée de la PR #33 | **24/24 PASS**, assertions préservées, fixtures adaptées au contrat signé, au schéma public et aux réponses conditionnelles |
| Compatibilité des dépendances | **5/5 PASS** |
| TypeScript application et build Vite | **PASS** |
| ESLint des fichiers TypeScript concernés | **PASS**, aucun avertissement |
| Collecte Playwright par défaut | **339 tests dans 13 fichiers**, collecte seule ; aucun navigateur exécuté dans ce lot |
| Collecte qualité après réconciliation du workflow | **49 tests dans 5 fichiers**, aucun scénario omis par le filtre précédent ; collecte seule |
| Deno 2.9.6, helpers HTTP et signatures | **PASS**, vérification de types réelle |
| Deno 2.9.6, handlers complets | **BLOQUÉ** : connexion refusée lors du téléchargement de `deno.land/std@0.190.0/http/server.ts` |
| Audit npm production | **0 critique / 0 high / 0 moderate / 3 low**, sortie 1 conservée ; aucun changement forcé de dépendance |

Les suites historiques KARTA et navigateur de la PR #33 ne sont pas additionnées à ces résultats ni présentées comme réexécutées. KARTA n'a pas été modifié.

Les reproductions négatives sont conservées : 38 échecs sur 72 cas lors de la réintroduction des protections manquantes, 32 échecs sur 34 cas de persistance webhook, 10 échecs sur 10 cas d'admission HTTP et un échec observant directement le mauvais schéma RPC. Ce sont des cas de tests, pas un décompte de défauts distincts.

## CI distante : cause établie

Le [run 42762512839](https://github.com/puramapro-oss/purama-ai/actions/runs/42762512839) du commit de base n'a démarré aucune étape. Les annotations officielles des deux jobs indiquent : « The job was not started because your account is locked due to a billing issue. » Les réponses HTTP 200 de l'API publique sont conservées dans `ci33-public-annotations.json` avec leurs URL. Aucune dépense, modification de facturation ou relance répétée n'a été effectuée.

## Analyse d'impact et limites

GitNexus 1.6.12 a été exécuté avant les modifications, puis réindexé : 11 613 nœuds, 28 917 relations, 525 flux. Les analyses des bibliothèques sont LOW ou UNKNOWN ; les entrées HTTP ne sont pas entièrement modélisées. Le lecteur de corps est relié aux deux handlers et à son test. L'extension de recherche FTS n'a pas pu être chargée et certains flux sont tronqués : un résultat vide ne prouve pas l'absence de dépendances. Les vérifications avant commit sont conservées séparément.

La persistance de la preuve et de son audit, comme les opérations successives du webhook, reste **non atomique**. Un échec tardif peut donc laisser des écritures déjà validées, même si la réponse ne prétend plus au succès. Le déclenchement de l'horodatage reste en **fire-and-forget** ; une file durable, la déduplication et les reprises transactionnelles ne sont pas qualifiées. Les confirmations Bitcoin, DocuSeal réel, le runtime Deno hébergé, la passerelle JWT et les politiques RLS distantes ne sont pas testés ici. Aucune fusion vers `main`, migration de production ou mise en service n'est incluse.

## Reproduction

Après `npm ci --no-audit`, exécuter sous Node 22 : `npm run test:contracts-security`, `npm run test:contracts-auth`, `npm run test:dependencies`, `npm run typecheck` et `npm run build`. Les commandes exactes, versions, sorties et empreintes sont dans `final-node22-receipts.json`, `final-build-receipts.json` et `provenance.json`. Les fichiers `*-before.log.gz` (compression sans modification des octets, empreintes dans `compressed-raw-logs.json`) sont des reproductions sur les états précédant la correction ; leurs échecs sont attendus.
