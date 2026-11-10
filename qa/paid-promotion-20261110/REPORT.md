# PURAMA — fiabilité de la promotion et preuves financières

Date de validation locale : 10 novembre 2026.

## Résultat et portée

**PARTIEL pour une mise en service complète.** Ce lot corrige des erreurs de
publication, d'identité, de concurrence et de comptabilisation. Il fournit du code
et des tests locaux ; il ne constitue pas un déploiement ni un système de
commissions ou de versements opérationnel.

Base examinée : `main` à `d116dc8a6429ea76c67167a195eb3f723f2251fb`.
Branche proposée : `codex/paid-promotion-reliability-20261110`.
Le garde de paiement reprend le travail de la PR #15 ; le contrôle CORS reprend
la PR #3. Leurs branches entières n'ont pas été fusionnées : elles divergent de
`main`, qui contient des évolutions sociales plus récentes.

## Changements vérifiables

### Publication sociale

- Le contrat Zernio utilise `content`, `mediaItems`, les couples plateforme/compte
  et `publishNow`. Une clé d'idempotence stable accompagne la demande fournisseur.
- La demande client possède une identité stable, liée à son propriétaire et à son
  contenu normalisé. Même identité et contenu différent donnent un conflit.
  Une relance après une réponse perdue réutilise la même demande.
- Les destinations sont figées côté serveur à la création. Une reconnexion
  ultérieure ne redirige pas silencieusement une ancienne publication programmée.
- L'état par destination détermine le résultat : publié, partiel, programmé,
  traitement en cours ou résultat à confirmer. Un HTTP 2xx ne suffit pas à prouver
  que tous les réseaux ont publié.
- Les écritures SQL sont contrôlées. Un échec après un envoi externe conserve une
  incertitude au lieu de provoquer un nouvel envoi.
- Le planificateur réclame les publications une à une. Une ancienne réservation
  interrompue n'est pas remise automatiquement dans une file de POST.
- Le rapprochement d'une publication connue utilise GET. Les publications sans
  identifiant fournisseur restent incertaines ; aucun identifiant n'est inventé.
- Les comptes doivent avoir une preuve serveur de liaison. Le financement de X
  doit être confirmé côté serveur ; aucune génération payante de légende ou de
  hashtags n'est lancée implicitement par ce parcours.

### Connexion, déconnexion et réglages

- Un profil fournisseur appartient à un utilisateur dans une table serveur, avec
  contraintes d'unicité. Une création de profil ambiguë est relue avant toute
  nouvelle tentative de création.
- Le callback OAuth exige un état HMAC expirant, un nonce durable à usage unique,
  le bon propriétaire, la bonne plateforme et le bon profil. L'API fournisseur
  confirme le compte ; les paramètres de l'URL ne créent pas cette preuve.
- La liaison et la consommation du nonce sont atomiques. Les anciennes lignes ne
  reçoivent pas automatiquement une preuve de publication.
- La déconnexion désactive d'abord la publication locale et cible un seul compte,
  jamais le profil partagé par plusieurs réseaux.
- Pour une opération de déconnexion donnée, le code réserve le DELETE fournisseur
  à la requête qui a obtenu le passage de `pending=false` à `true`. Les reprises
  restent en lecture et attendent le marqueur `disconnect_reconcile_ready` posé
  dans la branche terminale du propriétaire avant de vérifier une absence.
- L'absence doit provenir d'une liste fournisseur complète et authentifiée. Une
  page manquante, une troncature ou une erreur ne libère pas le verrou.
- Le callback refuse toute reconnexion pendant `disconnect_pending`. La fin est
  datée par l'horloge SQL ; une ancienne intention OAuth ne réactive pas le compte.
- Sur `social_accounts`, les écritures directes de `service_role` sont limitées à
  `is_active`, `disconnect_pending` et `disconnect_reconcile_ready`. La RPC de
  liaison écrit l'identité et la preuve ; le trigger attribue la date de fin.
- Les réglages sont écrits avec comparaison de `updated_at`. Une sauvegarde
  concurrente refusée produit HTTP 409, sans écraser silencieusement l'autre.

### Revenus et versements

- Le webhook conserve les observations Stripe signées dans un journal immuable
  avant de les acquitter. Les montants restent dans l'unité minimale de leur
  devise ; les données manquantes ne sont pas remplacées par un taux supposé.
- La création anticipée d'une commission annuelle et sa validation globale au
  premier paiement sont supprimées. Les anciennes commissions sont conservées.
- La clé du journal distingue compte Stripe, mode test/live et événement. Le pack
  historique de 2 000 actions est crédité une seule fois par session effectivement
  payée, même si deux types d'événements annoncent ce même paiement.
- Les abonnements sont rattachés par métadonnées serveur ou lien client unique,
  sans rapprochement par email. Les erreurs SQL et les écritures sans ligne
  confirmée restent des erreurs. Un essai ne devient pas implicitement actif.
- Le traitement automatique des commissions renvoie explicitement 503 lorsque le
  prestataire de versement manque. Il ne marque aucune commission payée et
  n'envoie aucun email annonçant un virement inexistant.
- La commande administrative qui écrivait directement `paid` sans preuve de
  virement est également désactivée. Son ancien dialogue et son message de faux
  succès sont retirés ; les données historiques restent consultables.

Le journal Stripe **n'est ni le registre canonique ONE, ni un solde disponible, ni
une autorisation de versement**. Tous ses événements demandent un rapprochement.
Les détails du volet financier figurent dans `tests/revenue/README.md`.

## Validation locale

Les tests de serveur interdisent le réseau et injectent leurs réponses externes.
Les tests SDK utilisent les bibliothèques réellement installées. Les tests SQL
exécutent les migrations dans PGlite ; ils ne simulent pas simplement leur texte.

| Ensemble | Résultat |
|---|---:|
| Garde du traitement automatique de paiement | 9/9 PASS |
| Webhook Stripe, signatures SDK réelles et branches applicatives | 30/30 PASS |
| Publication : fournisseur, intentions, traitement et planification | 36/36 PASS |
| Routes de publication, véritable SDK Supabase | 5/5 PASS |
| Connexion OAuth, état signé et vérification fournisseur | 24/24 PASS |
| Routes OAuth, véritable SDK Supabase | 4/4 PASS |
| Gestion des comptes et réglages, gardes et concurrence | 41/41 PASS |
| Routes de gestion, véritable SDK Supabase | 5/5 PASS |
| SQL : journal et crédits Stripe | 23/23 PASS |
| SQL : demandes de publication et permissions | 11/11 PASS |
| SQL : liaison OAuth, nonces, permissions et déconnexion | 29/29 PASS |
| Hook administratif réel : refus sans effet financier | 1/1 PASS |
| Compilation `npm run build` | PASS, 21,16 s |
| Lint des fichiers frontend modifiés et de Playwright | PASS, aucune erreur ni avertissement |
| Vérification du diff destiné au commit | PASS |
| Collecte Playwright | PASS, 156 tests existants dans 8 fichiers ; non exécutés |
| TypeScript global | PARTIEL : 140 erreurs préexistantes, 140 après, aucune nouvelle |
| Parcours dans le navigateur | BLOQUÉ avant la création de la première page |

Soit **218 tests ciblés réussis**, dont 63 tests SQL. La collecte Playwright n'est
pas comprise dans ce nombre. Les résultats remplacent les précédentes passes
intermédiaires ; ils ne les additionnent pas.

La comparaison TypeScript porte sur les triplets fichier/code/message, afin de ne
pas confondre un déplacement de ligne avec une nouvelle erreur. Les dépendances
applicatives et leur lockfile ne sont pas modifiés. Le build utilise le véritable
package privé `@purama/entraide` existant, vérifié séparément ; son code n'est pas
recopié dans ce dépôt public.

### Frontière du navigateur

Le harnais `tests/social-browser/run.mjs` charge le vrai composant de publication
et le vrai client social, avec un transport Supabase contrôlé et toute requête
externe interdite. Sept scénarios sont préparés : publication confirmée, résultat
partiel, programmation, réponse perdue, remontage, rechargement et contenu changé.

Firefox 1511 et 1538 démarrent, puis la création de leur processus de contenu
échoue : `Sandbox: writing /proc/self/uid_map: EPERM`, puis signal 11. La tentative
est arrêtée par délai borné. **Aucun de ces sept scénarios n'est déclaré réussi**
et aucune capture d'écran n'est présentée comme preuve.

### Commandes reproductibles

Versions utilisées : Deno 2.9.6, Stripe 18.5.0, Supabase JS 2.91.0,
PGlite 0.5.16, GitNexus 1.6.12. Les résolutions initiales des dépendances doivent
être effectuées avant une passe avec réseau interdit.

```sh
deno test --no-config --no-prompt --deny-net tests/social-management/handlers.test.ts
deno test --no-config --no-prompt --deny-net tests/social-connection/connection.test.ts
deno test --deny-net tests/social-publish/client-intent.test.ts tests/social-publish/provider.test.ts tests/social-publish/publish.test.ts tests/social-publish/scheduled.test.ts
```

Les tests des vraies routes utilisent `tests/social-connection/deno.json`, qui
résout le SDK Supabase et remplace seulement le serveur HTTP de test. Les seules
variables d'environnement permises sont celles de configuration de la route
testée ; leurs valeurs sont des fixtures, jamais des secrets de production.

```sh
deno test --cached-only --no-prompt --deny-net \
  --allow-env=SUPABASE_URL,SUPABASE_ANON_KEY,SUPABASE_SERVICE_ROLE_KEY,SOCIAL_DB_SCHEMA,SOCIAL_STATE_SECRET,APP_URL,CORS_ALLOWED_ORIGIN,ZERNIO_API_KEY,ZERNIO_BASE_URL,CRON_SECRET \
  --config tests/social-connection/deno.json \
  tests/social-connection/handler-sdk.test.ts tests/social-management/handler-sdk.test.ts tests/social-publish/runtime.test.ts

PGLITE_MODULE=/chemin/runtime/node_modules/@electric-sql/pglite/dist/index.js \
  node --test --test-isolation=none tests/revenue/inbox-sql.test.mjs tests/social-publish/migration-sql.test.mjs tests/social-connection/binding-sql.test.mjs

npm run build
npx tsc -p tsconfig.app.json --noEmit --pretty false
npx playwright test --list
node tests/social-browser/run.mjs
```

Les instructions financières complémentaires et leur import-map se trouvent dans
`tests/revenue/README.md`. Le harnais navigateur peut utiliser un Playwright déjà
installé via `SOCIAL_PLAYWRIGHT_MODULE`, sans modifier les dépendances du projet.

## Conditions avant mise en service

### Revue de portée avant commit

L'index GitNexus a été actualisé sur le checkout modifié. La commande
`detect-changes --scope compare --base-ref main` a ensuite examiné les 64 fichiers
proposés : 803 symboles et 48 parcours signalés, risque **CRITICAL**. Ce classement
a été communiqué avant la préparation du commit. Le détail structuré ne porte
aucun marqueur `partial` ou `truncated` et tous les symboles modifiés appartiennent
à la liste des fichiers proposés.

La revue complète cette analyse automatique : le client social partagé a cinq
appelants directs et touche notamment `DynamicAgentForm`, `SocialSettings` et la
déconnexion. Ses requêtes et retours de succès gardent leur contrat ; les erreurs
sociales restent interceptées dans le parcours de génération. Les corrections
de concurrence ont aussi reçu une seconde lecture indépendante.

Le graphe contient des rapprochements de noms communs, notamment `success` et
`update`, et l'indexeur signale des limites de couverture. Les mentions de KARTA
et de la file d'expiration des toasts ont été confrontées à leurs imports et au
diff : ces modules ne sont pas modifiés. Une absence d'arête n'est jamais utilisée
comme preuve d'absence d'impact. Les 64 fichiers comprennent six fichiers
frontend, 24 fichiers de fonctions (dont l'ancien test supprimé), trois migrations,
29 fichiers de tests, une configuration Playwright et ce rapport.

Le risque global reste élevé pour l'intégration : authentification, effets
externes et statuts financiers justifient une pull request en brouillon et les
conditions suivantes avant déploiement.

1. **Source commerciale canonique — responsable métier/ONE.** Raccorder le
   registre ONE, fixer l'assiette contractuelle, le taux applicable, les retours,
   les réserves et la durée promotionnelle. Ce lot n'invente aucun barème et ne
   change pas arbitrairement les anciennes promesses commerciales.
2. **Versement — responsable paiements.** Raccorder un prestataire, enregistrer ses
   références et confirmations, rapprocher les remboursements et les soldes, puis
   vérifier les fonds disponibles avant l'exécution d'un virement, en distinguant
   cette possibilité d'exécution de l'exigibilité des commissions dues. Aucun
   revenu ni aucune absence de frais personnels ne sont garantis par ces tests.
3. **Déploiement — responsable Supabase.** Vérifier le schéma réellement utilisé,
   appliquer les migrations 002/003/004 avant les nouvelles routes, vérifier les
   secrets, l'origine autorisée, le cron et les droits effectifs. La migration
   financière refuse des doublons historiques sans supprimer les données : les
   rapprocher avant de recommencer.
4. **Compte réel — responsable intégration sociale.** Effectuer une connexion
   OAuth et une publication contrôlées, vérifier le coût du forfait fournisseur,
   ses limites, la modération des plateformes et les retours réels par réseau.
   Valider aussi la déconnexion et une récupération après perte de réponse.
5. **Qualité — responsable du dépôt.** Rejouer le navigateur dans un environnement
   compatible, vérifier la CI distante et traiter les 140 erreurs TypeScript
   existantes avant d'annoncer une validation globale.

### Limites conservées et identifiées

- La table historique d'abonnements n'enregistre pas une version de l'état Stripe
  ni tous les identifiants nécessaires à un ordre total entre événements. La
  relecture du fournisseur réduit les retards, sans prouver la concurrence native.
- Les tests PGlite ne remplacent pas plusieurs connexions PostgreSQL réelles.
- Si le propriétaire d'une déconnexion s'arrête brutalement avant son marqueur
  terminal, le verrou reste actif. Sa résolution exige une preuve opérateur ;
  aucun délai ne déclenche un nouveau DELETE ou une reconnexion automatique.
- La policy SQL héritée permettant à un administrateur de modifier directement
  des commissions n'est pas réécrite ici. Le garde couvre les parcours applicatifs
  modifiés, sans certifier toutes les écritures possibles dans la base.
- Le portefeuille historique, ses demandes de retrait et ses délais affichés ne
  sont pas un circuit de versement vérifié par ce lot. Le contrat PDF et certaines
  mentions promotionnelles anciennes restent à aligner sur la décision métier.
- Le parcours Stripe Connect hérité n'est pas validé : la conservation de sa
  liaison, son idempotence et la protection de ses identifiants demandent une
  correction distincte avant de l'utiliser comme fondement d'un versement.

Aucune migration distante, publication sociale, publicité payante, opération
bancaire ou fusion dans `main` n'a été effectuée par cette validation.

## Sources des contrats externes

- [Zernio — connexion des comptes](https://docs.zernio.com/guides/connecting-accounts)
- [Zernio — création d'une publication](https://github.com/zernio-dev/zernio-dotnet/blob/main/docs/CreatePostRequest.md)
- [Zernio — API des comptes](https://github.com/zernio-dev/zernio-dotnet/blob/main/docs/AccountsApi.md)
- [Zernio — pagination des comptes](https://github.com/zernio-dev/zernio-dotnet/blob/main/docs/AccountsListResponsePagination.md)
- [Stripe — webhooks](https://docs.stripe.com/webhooks)
- [Stripe — métadonnées](https://docs.stripe.com/metadata)

Les pages officielles ont servi à vérifier les contrats. Leur consultation ne
prouve pas la configuration des comptes PURAMA ni la réussite d'un appel réel.
