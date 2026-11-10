# Dépendances et validation — 10 novembre 2026

Statut global : **PARTIEL**. Le correctif améliore les dépendances et les contrôles
de la branche de PR10. Il ne certifie ni la production ni l'ensemble de PURAMA.
Point de départ : `e8f1ce2e16aacdfdb6108a2fa33bea70c198b94e`.

## Résultats vérifiés

Les vérifications locales utilisent Node **22.23.4**, soit la version majeure
configurée dans la CI. Les installations reproductibles ont été réalisées par
`npm ci --ignore-scripts --no-audit --no-fund`. Les commandes de validation ont été
exécutées avec ce binaire Node, indépendamment du Node global de l'environnement.

| Contrôle | Résultat et portée |
|---|---|
| KARTA : Vitest | **PASS** — 488 tests dans 45 fichiers |
| KARTA : TypeScript et build | **PASS** |
| KARTA : audit de production, seuil low | **PASS** — 0 vulnérabilité connue signalée |
| Racine : `test:dependencies` | **PASS** — 5 tests ; 4 échouaient avant le correctif |
| Racine : build Vite | **PASS** avant et après correction |
| CSS après mise à jour de Vite et du parseur Typography | **PASS** — contenu strictement identique, vérifié par SHA-256 |
| Racine : `typecheck:app` | **BLOQUÉ** — 103 diagnostics préexistants, sortie strictement identique avant/après |
| Racine : audit de production | **PARTIEL** — 16 paquets signalés dans l'audit initial du 8 novembre, 6 après correction le 10 novembre ; 0 critique, 1 élevée, 2 modérées, 3 faibles |
| Racine : audit incluant le développement | **PARTIEL** — 16 paquets signalés au contrôle final : 0 critique, 1 élevée, 12 modérées, 3 faibles |
| Collecte Playwright desktop | **PASS** — 66 tests dans 9 fichiers, sans chargement des tests Node |
| Exécution navigateur | **NON TESTÉ** — la collecte n'exécute aucun scénario ; le téléchargement Chromium tenté le 8 novembre a échoué avec une archive invalide |
| Calendriers externes, fonctions Edge, Supabase et Hostinger | **NON TESTÉ** |

Les nombres d'audit désignent des paquets signalés, y compris les dépendances
parentes ; ils ne sont pas un décompte d'exploitations démontrées. Un audit sans
alerte ne constitue pas une preuve d'absence de défaut de sécurité.

## Changements de dépendances

| Périmètre | Avant | Après |
|---|---|---|
| `qs`, racine et KARTA | 6.16.0 | 6.17.1 |
| DOMPurify | 3.4.15 | 3.4.17 |
| `source-map-js` | 1.2.1 | 1.2.2 |
| Moment | 2.30.1 | 2.31.0 |
| `postcss-selector-parser`, résolution racine | 6.1.4 | 6.1.6 |
| `postcss-selector-parser` sous Tailwind Typography | 6.0.10 | résolution 6.1.6 partagée |
| Vite, outil de développement | 6.4.3 | 6.4.6 |
| `bn.js` utilisé par Bitcore | 4.11.8 | 4.12.5 |
| HTTP d'OpenTimestamps | `request` 2.88.2 | alias vers `@cypress/request` 4.0.1 |
| Cookies du client HTTP remplacé | override global v4 | résolution v5.1.2 limitée à ce client |
| Glob d'OpenTimestamps | override global `minimatch` v10 incompatible | `minimatch` 3.1.5 et `brace-expansion` 1.1.21 limités à ce sous-arbre |

Le client HTTP constitue un changement de fournisseur et de version majeure,
pas une simple mise à jour corrective. Il retire du graphe racine l'ancien
`request`, `har-validator` et UUID. L'avis
[GHSA-p8p7-x288-28g6](https://github.com/advisories/GHSA-p8p7-x288-28g6)
indique un correctif dans le fork Cypress à partir de 3.0.0 et aucun correctif
dans le paquet historique. `request-promise` reste ancien ; son remplacement
complet et la migration des fonctions Edge nécessitent un travail distinct.

Les mises à jour de DOMPurify, `source-map-js` et `qs` répondent notamment aux avis
[DOMPurify](https://github.com/advisories/GHSA-cg2g-xh64-v4q7),
[source-map-js](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) et
[qs](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw).
Les conditions d'exploitation propres à chaque avis ne sont pas assimilées à
une exploitation du produit démontrée.

La mise à jour corrective de Vite traite aussi les avis visant son serveur de
développement, notamment
[GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm).
L'override du parseur de Tailwind Typography reste limité à ce consommateur.

## Compatibilité réellement exercée

L'import OpenTimestamps échouait sur `uuid/v4`, absent d'UUID v11. Les overrides
globaux imposaient aussi à `minimatch` et `brace-expansion` des API incompatibles
avec leurs consommateurs historiques. Le correctif préserve les versions modernes
des autres sous-arbres et cible les résolutions du module d'horodatage.

Les cinq tests vérifient :

1. Le chargement complet d'OpenTimestamps et de ses dépendances HTTP.
2. Une liste de calendriers autorisés : hôtes attendus, faux domaines ressemblants,
   rejet HTTP et motifs comportant des accolades.
3. La sérialisation et relecture d'une preuve pendante : même empreinte, même
   calendrier, mêmes octets ; une preuve tronquée est rejetée.
4. Les opérations entières et conversions binaires utilisées par Bitcore.
5. Le contrat HTTP avec un serveur sur `127.0.0.1` : objet `URL`, POST binaire,
   réponse binaire, cookie et rejet d'une réponse 403.

Aucun calendrier externe ni transaction blockchain n'est contacté par ces tests.
Ils ne prouvent pas l'ancrage Bitcoin, les échanges TLS ou l'exécution dans Deno.
Les wrappers racine d'horodatage sont conservés ; l'analyse des imports les trouvait
hors du graphe actuel de `src/main.tsx`. Les fonctions Edge importent séparément
`npm:opentimestamps@0.4.9` : le lock et les overrides racine ne les corrigent pas.

Le fichier `tests/dependency-compat.cjs` est volontairement hors du motif de
collecte Playwright. Il est exécuté explicitement par `npm run test:dependencies`.

## Contrôle TypeScript corrigé

L'ancienne commande CI `tsc --noEmit` visait un fichier solution contenant
`files: []`. Elle ne constituait pas le contrôle de `tsconfig.app.json` attendu.
`npm run typecheck:app` vérifie maintenant explicitement l'application.

Les 103 diagnostics existent déjà sur le commit de départ et restent identiques
après correction. Les principaux groupes concernent Boutique et Wallet
(16 chacun), Fiscal (10), Aide (9) et DashboardOverview (8). Les autres concernent
notamment des hooks, Stripe Connect et les types de données. Ils doivent être
corrigés en vérifiant le schéma et les contrats réels, sans masquage par `any`,
`@ts-ignore` ou désactivation du contrôle.

La CI exécute les tests de dépendances, le build et ce contrôle explicite.
L'audit reste exécuté après un échec du typage si l'installation a réussi et si
le run n'a pas été annulé. L'échec du typage conserve son statut d'échec.

## Alertes de production restantes

| Paquets signalés | Situation | Travail restant |
|---|---|---|
| Zod, élevée | Le correctif proposé par npm change de version majeure | Migrer les schémas et leurs consommateurs avec tests ; auditer séparément les imports Zod des fonctions Edge |
| React Router / React Router DOM, modérées | Le correctif proposé change de version majeure | Migrer et tester les redirections, liens dynamiques et retours OAuth |
| Elliptic → Bitcore → OpenTimestamps, faibles | Dépendance cryptographique héritée | Choisir un remplacement maintenu et vérifier les preuves existantes |

Le routage observé utilise `createRoot` et `BrowserRouter`, sans le mode serveur
visé par l'un des avis Router. Des destinations dynamiques restent présentes dans
les notifications et le retour OAuth ; leur exploitation n'est pas démontrée.
L'analyse de ces prérequis ne justifie pas de supprimer les alertes de l'audit.
Les dépendances de développement ne sont pas couvertes par les chiffres de
l'audit de production ci-dessus. L'audit complet conserve notamment `minimatch`
et ses consommateurs ESLint/TypeScript-ESLint. Leur correction doit préserver les
API attendues par chaque consommateur ; un override global de version majeure ne
constitue pas une validation de compatibilité. Les alertes Vite et du parseur
Typography ne figurent plus dans le dernier audit complet.

## CI distante et coordination CHEF

Le dernier run observé avant publication de ce complément est
[42514432309](https://github.com/puramapro-oss/purama-ai/actions/runs/42514432309).
Ses deux jobs n'avaient pas démarré. L'inspection des annotations le 8 novembre a
confirmé : « The job was not started because your account is locked due to a billing issue. »
Cette observation historique ne prouve pas l'état actuel de la facturation.
Le titulaire du compte doit traiter ce blocage ; aucun paiement ni changement de
facturation n'est effectué par ce correctif.

L'inspection du travail T1 le 8 novembre a également identifié une lignée CHEF
distincte, au commit local `6be8ea365179dd84dc6a0b199e6fdf71e5bbb172`, non publiée
à l'origine GitHub observée. Il ne faut pas la remplacer ou la fusionner en bloc :

- Ses numéros de migrations 016/017 désignent déjà d'autres changements.
- Son contrat `addEvidence` utilise session/token et retourne `Promise<void>` ;
  PR10 utilise une portée explicite et un refus booléen.
- Son rattachement de preuves reste différent de celui de PR10.
- Son vérificateur dispose d'une architecture d'isolation et d'autorisation,
  mais la construction observée dans `worker-main.ts` ne fournit pas les deux
  adaptateurs requis. Un double de test ne remplace pas l'isolation de production.

Ces observations doivent être rapprochées de l'état T1 courant par son responsable
avant intégration. Les worktrees et verrous de coordination du Mac n'ont pas été
modifiés. Le présent complément ne revendique aucune correction du cycle de vie T1.

## Conditions avant livraison

GitNexus classe ce complément de 7 fichiers à risque faible dans le code indexé.
La comparaison cumulée avec `origin/main` porte toutefois sur 215 fichiers et
250 processus, avec un risque critique. Cette divergence inclut les travaux
antérieurs de la branche ; aucun merge automatique n'est approprié. L'analyse du
graphe ne remplace pas les tests de compatibilité des bibliothèques tierces.

- **Mainteneur application :** résoudre les diagnostics TypeScript et les migrations
  de dépendances restantes, puis exécuter les tests navigateur sur un environnement
  disponible et les parcours de connexion, paiement, abonnement et quotas.
- **Responsables CHEF/T1 :** rapprocher les contrats de preuve, les migrations,
  l'isolation et la composition du worker ; conserver les invariants de PR10.
- **Titulaire GitHub :** vérifier et résoudre le blocage de facturation si toujours
  présent, puis obtenir un run distant sur le commit réellement destiné à être livré.
- **Opérateur Supabase/Hostinger :** qualifier les fonctions Edge, les migrations,
  les reprises après panne et la restauration avant déploiement.

La compilation, les tests locaux et les audits ont des portées différentes.
Aucun de ces résultats ne certifie un fonctionnement mondial ou continu 24 h/24.
