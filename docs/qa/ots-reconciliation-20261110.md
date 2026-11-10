# Réconciliation OTS et webhook DocuSeal — 10 novembre 2026

## Origine et périmètre

Ce lot descend de PR33 `0c7f7da1b4ecb0d93e00b1f73a55a3736b0f348c`.
Il reprend les corrections de transport et d’empreinte de PR32
`3cd01de34447003ac7aad4a6ad54cf7524b77a67`, tout en conservant l’autorisation
de PR33 : utilisateur vérifié, RPC serveur `has_role`, résultat strictement
égal à `true`, et comparaison exacte du secret de service.

Le webhook et le lecteur de corps proviennent du travail Mac déjà committé
dans `a3dbad12756387bb7c01606818e6ee42b85b4d5b`, également présent dans l’arbre
intégré `25bc3e685a27d4bc9822f4e91d9d04ec3e3cb474`. Les deux arbres étaient propres
au moment de leur lecture. Leur webhook avait la même empreinte SHA-256 :
`ddf44fc2ad34035dd1c86f6d242b852b58478d19ffac22b85f0131fd2a232c5b`.

La classe `OtsHttpError` et la fonction `readOtsBody` ont été extraites sans
modification de leurs corps vers `_shared/ots-body.ts`. Cette extraction
évite d’importer l’autre politique d’autorisation du module Mac `ots-auth.ts`.
Le secret DocuSeal reste obligatoire dans tous les environnements, avec le
message et le statut 503 de PR33 lorsqu’il manque. Les archives Mac nommées
`iao-webhook-qa` et `iao-webhook-retry` concernent Stripe et ne sont pas la
source de cette correction DocuSeal.

## Comportement obtenu

- Les empreintes et preuves nouvelles portent sur les octets PDF bruts.
  Les vues binaires respectent leur décalage et leur longueur ; un instantané
  immuable empêche qu’une mutation entre deux attentes asynchrones fasse
  diverger l’empreinte affichée et la preuve. Les anciennes preuves calculées
  sur le texte Base64 restent vérifiables.
- Une preuve sans attestation de calendrier n’est plus annoncée comme
  « en attente ». Une preuve sérialisée invalide produit un refus de vérification.
- L’Edge stamper exige un contrat signé. Le jeton DocuSeal est réservé à
  l’origine exacte du serveur configuré, et les redirections du PDF sont refusées.
  Les liens HTTPS externes restent possibles sans transmettre ce jeton.
- La sauvegarde compare l’identifiant, le statut signé et l’identifiant de
  soumission lus avant le téléchargement. Une modification concurrente produit
  un conflit 409. Un nouvel horodatage efface les anciennes confirmations Bitcoin.
- L’événement d’audit utilise l’identité réellement vérifiée, ou l’acteur service.
  Une erreur de sauvegarde ou d’audit n’est pas renvoyée comme un succès.
  Les erreurs privées du fournisseur ne sont pas reproduites par le stamper.
- Le webhook refuse un Bearer invalide avant de lire son corps ou de créer
  un client privilégié. Après authentification, les limites sont de 64 KiB
  pour le webhook et 4 KiB pour le stamper, mesurées sur les octets reçus.
  Le lecteur applique un délai total de 10 secondes, respecte l’annulation
  et libère son verrou sans attendre un producteur dont l’annulation ne termine pas.
- Les enveloppes nulles, les identifiants non entiers ou non positifs et les
  listes de signataires absentes ou vides ne peuvent plus déclencher un
  horodatage de contrat présenté comme entièrement signé.

## Vérifications effectuées sur ce lot

| Vérification | Résultat observé |
| --- | --- |
| Suite Node sur les handlers et la bibliothèque réelle | PASS — 103 tests, 0 échec, 0 ignoré |
| Autorisation PR33 d’origine | PASS — 24 tests ; assertions inchangées, fixtures adaptées au nouveau transport |
| Exécution native Deno 2.9.6, contrôle TypeScript actif | PASS — 50 tests, 0 échec |
| Contrôle TypeScript applicatif | PASS — sortie 0 |
| Build Vite de production | PASS — sortie 0 |
| Compatibilité des dépendances | PASS — 5 tests |
| Découverte Playwright | PASS — 339 tests dans 13 fichiers ; les suites Deno/Node restent hors de cette découverte |

Les 99 premiers tests Node ont été exécutés sur les trois sources OTS
originales de PR33 : 58 réussissaient et 41 échouaient. Le même ensemble
est ensuite passé intégralement. Quatre tests supplémentaires ont reproduit
le blocage d’un Bearer invalide sur un corps qui ne se termine jamais, puis
ont confirmé sa correction. La comparaison native avant correction donne
également 4 échecs sur ces 5 tests d’entrée du webhook.

Les huit tests webhook Mac ont été repris sans supprimer d’assertion. Avant
intégration, quatre échouaient : signataires vides, enveloppe nulle,
identifiants invalides et dépassement de 64 KiB. Les trois tests du lecteur
Mac, les tests de non-lecture et les contrôles directs du stamper 4 KiB sont
inclus dans le total natif de 50.

La suite native importe les vrais handlers, les vrais helpers et la version
verrouillée `opentimestamps` 0.4.9. Les ports de base de données, d’identité,
de téléchargement et de calendrier sont remplacés par des fixtures.
La construction des arbres, les attestations et la sérialisation OTS sont
réelles ; les permissions Deno réseau et lancement de processus sont refusées.
Les messages de bibliothèque « Submitting to remote calendar » sont émis
avant le port de calendrier substitué et ne prouvent donc aucun appel réel.

### Reproduction

Depuis la racine du dépôt avec les dépendances du verrou installées :

```sh
node --experimental-vm-modules --test --test-concurrency=1 \
  tests/contracts-ots-auth.mjs tests/contracts-ots-integrity.mjs \
  tests/opentimestamps-content.mjs

deno test --config tests/contracts-ots-native/deno.json \
  --cached-only --no-prompt --deny-net --deny-run --allow-read=node_modules \
  --allow-env=SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,SUPABASE_ANON_KEY,DOCUSEAL_API_URL,DOCUSEAL_API_TOKEN,DOCUSEAL_WEBHOOK_SECRET,NODE_DEBUG,NODE_DEBUG_NATIVE,NODE_ENV,NODE_NDEBUG,BLUEBIRD_DEBUG,BLUEBIRD_WARNINGS,BLUEBIRD_LONG_STACK_TRACES,BLUEBIRD_W_FORGOTTEN_RETURN \
  tests/contracts-ots-native/runtime.ts \
  tests/contracts-ots-native/webhook-runtime.ts \
  tests/contracts-ots-native/webhook-donor-runtime.ts \
  tests/contracts-ots-native/body-runtime.ts

node node_modules/eslint/bin/eslint.js \
  src/lib/opentimestamps.ts src/lib/docuseal/ots-stamper.ts \
  supabase/functions/contracts-ots-stamp/index.ts \
  supabase/functions/contracts-webhook/index.ts \
  supabase/functions/_shared/ots-body.ts tests/contracts-ots-native/*.ts
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.app.json
node --test tests/dependency-compat.cjs
node node_modules/vite/bin/vite.js build
```

Les noms des entrées Deno sont explicites pour éviter leur collecte par
Playwright. Le script `test:contracts-auth` doit inclure les trois fichiers
Node lors de la consolidation par le responsable d’intégration.

## Limites encore ouvertes

PARTIEL : le webhook déclenche encore le stamper sans file persistante ni
garantie de reprise. La sauvegarde de la preuve et celle de l’événement
d’audit ne sont pas atomiques ; une réponse 500 d’audit peut suivre une
preuve déjà enregistrée. Le téléchargement PDF conserve le comportement
de lecture en mémoire existant ; ce lot ne qualifie pas ses limites de taille
ou de latence sur un fournisseur réel.

NON TESTÉ : calendrier distant, confirmation Bitcoin, DocuSeal réel,
passerelle Edge hébergée, droits RLS sur la base réelle et déploiement en
production. Ce lot ne constitue pas une qualification commerciale globale.

BLOQUÉ côté CI distante à la lecture du run `42762512839` : les deux jobs
indiquaient que le compte GitHub était verrouillé pour un problème de
facturation, avant attribution d’un runner. Aucun paiement, aucune modification
de protections et aucune relance de ce run n’ont été effectués par ce lot.
