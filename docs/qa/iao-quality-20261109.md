# IAO — correction des contrats et contrôles de qualité

## Périmètre

Candidate locale `repair/iao-quality-20261109`, fondée sur la tête de PR12
`87ea6753b91794b1aadab0d36418b82f2b83f3b0`. Ce lot ne modifie pas les migrations
financières de PR11/PR12, ne déploie aucune fonction et n’écrit pas dans une base
de production. Il doit être rapproché des candidats encore présents sur le Mac
avant intégration ; le premier contrôle distant a expiré et cette comparaison
n’a pas été réalisée dans ce lot local.

Le garde-fou `vercel.json` conserve la désactivation Git de la branche d’audit
précédente et ajoute `repair/iao-quality-20261109: false`. Il concerne le
déploiement automatique par Git ; aucun déploiement manuel n’a été effectué.

## Corrections

### Contrats Supabase

Les 103 erreurs TypeScript du site ont été reproduites avant modification. La
majorité provenait de tables absentes des types du client, alors que leur DDL
figurait déjà dans le dépôt.

`scripts/generate-supabase-contracts.mjs` exécute les deux sources SQL ci-dessous
dans une base PGlite éphémère, puis interroge le catalogue PostgreSQL pour produire
`schema-contracts.ts` :

- `p3_schema.sql` : 15 tables dans `purama_ai` ;
- `supabase/migrations/20260422180000_v4_1_stripe_connect_opentimestamps.sql` :
  7 tables dans `public`.

Le générateur conserve les colonnes nullables, les valeurs par défaut, les champs
obligatoires à l’insertion et les relations entre tables d’un même schéma. Les
empreintes SHA-256 des sources sont inscrites dans le fichier généré. La fixture
`auth` sert uniquement à résoudre les clés étrangères et les politiques SQL.

Les colonnes d’essai et les RPC sont complétées à partir des migrations
`20260727000000_subscriptions_security_and_trial.sql` et
`20260727010000_public_weekly_actions_count.sql`. Le type de la requête abonnement
réutilise désormais le contrat partagé. Le schéma par défaut du client et des
helpers reste explicitement `purama_ai`.

**Ces contrôles établissent la conformité au DDL versionné. Ils ne prouvent pas
que ces migrations sont présentes dans une base déployée.** Les anciennes données
commerciales contenues dans les seeds P3 ne sont pas validées par ce travail.

### Comportement du site

- `connect_accounts`, `user_tax_profiles` et `reglements` utilisent explicitement
  leur schéma `public`. Les valeurs Stripe nulles ne sont pas traitées comme des
  autorisations actives. Une erreur de lecture Connect renvoie un statut inconnu
  (`null`), distinct d’une réponse vide qui confirme l’absence de compte.
- La page fiscale ne confond plus un solde avec un revenu annuel. Elle indique
  l’indisponibilité du total annuel et ne promet plus des déclarations URSSAF ou
  fiscales automatiques absentes de cette page. Les chiffres fiscaux génériques
  et les exonérations non établies ont été retirés au profit d’un lien vers
  l’[information officielle](https://www.impots.gouv.fr/revenus-de-plateformes-collaboratives-0).
- Les erreurs de chargement des profils et règlements deviennent visibles avec
  une reprise explicite. Un échec d’enregistrement libère le bouton. Les réponses
  de chargement arrivées après un changement de page ou de compte sont ignorées.
- Une date de publication nulle est affichée comme indisponible. Une requête de
  règlements échouée n’est plus présentée comme une liste vide.
- La réponse du portail Stripe est vérifiée à l’exécution : objet, URL textuelle,
  URL valide et HTTPS. Aucun paiement réel n’est effectué par les tests.
- Le composant de secours React accepte le type `unknown` prévu par sa bibliothèque.

### Validation côté fonctions

Les imports Deno de Zod 3, absents du périmètre de `npm audit`, passent à
`npm:zod@4.6.7`. Le helper utilise `ZodType` et `error.issues`. Le schéma du chat
d’un agent personnalisé exige explicitement `agent_id` ; l’ancien appel à
`required()` sur un `ZodOptional` était invalide.

Les six consommateurs du helper utilisent le vrai SDK
`npm:@supabase/supabase-js@2.91.0`, déjà verrouillé dans le projet, à la place d’un
import CDN mutable. `karta-trigger` utilise le serveur natif `Deno.serve`, comme
les cinq autres fonctions. Les contrôles sont exécutés avec Deno 2.9.6 officiel,
TypeScript 6.0.3, sans accès réseau grâce aux dépendances locales réelles.

### Dépendances

| Périmètre | Avant | Après |
| --- | --- | --- |
| Site Zod | 3.25.76 | 4.6.7 |
| Site React Router | 6.30.6 | 7.18.5 |
| Site Vite | 6.4.3 | 6.4.6 |
| Résolveurs React Hook Form | 3.10.0 | 5.9.2 |
| minimatch | 10.2.5 | 11.0.5 |
| Parseur CSS utilisé par typography | 6.0.10 imbriqué | 6.1.6 dédupliqué |
| KARTA Vite | 8.3.0 | 8.3.7 |
| KARTA Vitest / mocker | 5.0.1 | 5.0.3 exact |

Les `any` des doubles de tests concernés sont remplacés par des types contrôlés,
sans désactiver de règle, retirer d’assertion ou augmenter les délais.

## Vérification

Résultats finaux locaux du 9 novembre 2026 :

| Contrôle | Statut | Résultat vérifié |
| --- | --- | --- |
| TypeScript du site | PASS | 103 erreurs reproduites avant correction, 0 après ; exit 0 |
| Build du site | PASS | Compilation Vite terminée ; aucune preuve de déploiement implicite |
| Lint du dépôt | PASS | 0 erreur, 30 avertissements historiques conservés |
| Contrats SQL générés | PASS | Régénération en mémoire identique au fichier versionné |
| Suite Playwright dédiée | PASS | 15/15 dans la passe complète, puis 3/3 cas Connect ciblés (dont 2 ajoutés) |
| KARTA TypeScript et build | PASS | Vérifiés à nouveau avec Vitest 5.0.3 exact ; exit 0 |
| KARTA tests | PASS | 505/505 tests, 46 fichiers, 87,98 s, un worker, délais d’origine |
| Deno validation | PASS | 5/5 tests du helper sous Deno 2.9.6 |
| Deno fonctions | PASS | 6 points d’entrée vérifiés par le compilateur Deno réel |
| Audit npm KARTA | PASS | 0 alerte après les mises à jour finales |
| Audit npm du site | PARTIEL | 22 → 6 alertes ; aucune haute/critique, 4 modérées et 2 basses OTS ; exit 1 |
| Schéma et flux de production | NON TESTÉ | Base déployée non vérifiée et candidats Mac non comparés dans ce lot |

Les journaux de session conservent la commande, le répertoire, les heures et le
code de sortie. Les commandes reproductibles sont :

```sh
npm ci --ignore-scripts
npm ci --prefix karta --ignore-scripts
npm run check:database-contracts
npm run typecheck
npm run lint
npm run build
npm run test:quality
npm run test:quality -- --grep Connect
npm --prefix karta run typecheck
npm --prefix karta run build
npm --prefix karta test -- --maxWorkers=1
npm audit --json
npm --prefix karta audit --json
deno test --node-modules-dir=manual --no-remote supabase/functions/_shared/validation.test.ts
deno check --node-modules-dir=manual --no-remote supabase/functions/legal-chat/index.ts supabase/functions/legal-build-case/index.ts supabase/functions/creator-agent-chat/index.ts supabase/functions/agent-chat/index.ts supabase/functions/creator-agent-run/index.ts supabase/functions/karta-trigger/index.ts
```

Le navigateur de session est Chromium 153. La suite `test:quality` utilise le vrai
site et des réponses Supabase interceptées, dans une configuration dédiée qui
ne contacte pas la production. Elle vérifie navigation, protection des routes,
lecture/écriture de profil, erreurs et reprises, nullabilité, en-têtes de schéma,
réponses Connect et redirections de facturation, ainsi que les contrats Zod.
Un exécutable local peut être fourni par `PLAYWRIGHT_EXECUTABLE_PATH` ; à défaut,
la suite utilise le Chromium installé par Playwright.

## Limites conservées

- Le lint ne contient plus d’erreur, mais conserve 30 avertissements historiques
  sur les dépendances de hooks et Fast Refresh.
- L’audit npm du site conserve 6 alertes transitives de la chaîne OpenTimestamps :
  4 modérées et 2 basses. Il ne reste aucune alerte haute ou critique dans cet arbre.
  La migration des preuves OTS nécessite une validation de compatibilité dédiée.
- Les tests locaux ne prouvent ni le déploiement des migrations, ni la disponibilité
  des fournisseurs, ni une exécution authentifiée de bout en bout en production.
- La vérification GitNexus utilise le graphe syntaxique local, sans embeddings ni
  FTS. L’outil signale des limites de couverture des flux et des homonymies dans
  les doubles de tests ; les références directes sont également relues. Le
  contrôle du lot préparé identifie 36 fichiers et 78 flux avec un
  risque **CRITICAL**, conservé dans les preuves. Les étapes modifiées de ces
  flux sont `Fiscal`, `Reglement` et des fonctions locales homonymes `result`.
  Le compteur de symboles a varié après la réindexation incrémentale ; les
  fichiers et fonctions concernés sont relus directement dans le diff.
  La comparaison avec `main` inclut les PR antérieures : 241 fichiers et 252
  flux. Elle ne représente pas le seul lot de ce document.
- Vitest 5.1.0 a été évalué puis écarté après des dépassements de délai SQL ; le
  candidat retient le correctif 5.0.3, avec les délais et assertions d’origine.

Le résultat reste **PARTIEL** à l’échelle d’une validation de tout Purama en
production. Les contrôles locaux ne justifient pas une affirmation de perfection
ou de déploiement.
