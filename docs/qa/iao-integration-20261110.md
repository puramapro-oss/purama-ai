# IAO — composition vérifiée du 10 novembre 2026

## Résultat et périmètre

**PASS local pour les portes exécutées ; PARTIEL pour la qualification complète ; aucune production déployée.**

Cette branche assemble les corrections Jev/confidentialité/finalisation, la qualité applicative, le commerce et le tableau de bord fondateur dans un seul candidat. Les résultats ci-dessous proviennent d'exécutions fraîches du 10 novembre, avec des fixtures contrôlées. Ils ne qualifient ni les 97 dépôts PURAMA ni les fournisseurs, comptes et bases de production.

Branche de revue : `audit/iao-integrated-20261110`.
Base de revue : PR #15, `e859a4235d6af4d0f07fb52eb9ade3734adfa5b5`.
Le garde `vercel.json.git.deploymentEnabled["audit/iao-integrated-20261110"] = false` existe avant publication de la référence distante. Aucun secret, paiement, courrier, migration distante ou merge sur main n'a été nécessaire aux vérifications.

## Provenance et résolution des divergences

| Source | Version observée | Intégration |
| --- | --- | --- |
| PR #14 — qualité | `d003159bdf3216b155f747b0f8fa93b3a92e5b3a` | Déjà ancêtre de #15 |
| PR #15 — commerce | `e859a4235d6af4d0f07fb52eb9ade3734adfa5b5` | Base conservée |
| PR #13 — Jev, traces et finalisation | `7658be81e937b33a0b5aa3dab6d7939857a8aca8` | Merge local `54f540c81e3b435a1a1435320bc8103e98bab750`, histoire conservée |
| PR #16 — fondateur | `ef9aa78312aa092fc2ad02d33aea4b27d6cca303` | Patch du seul commit appliqué sur l'assemblage |
| Parent de #16 | `ca155cdc412d65b78146c3cccc8b44f62e0db5b5` | Ses 42 commits divergents sont exclus |

Le merge de #13 a présenté exactement deux conflits de tests : `karta/test/logger.test.ts` et `karta/test/loop.test.ts`. Les doubles de base de données restent typés comme dans #14 ; les filtres `is`, les durées non encore finalisées et l'attente de succès après une erreur de comptabilisation respectent #13. Un effet métier déjà confirmé n'est pas artificiellement transformé en échec parce que son écriture de suivi échoue. Les 18 tests de journalisation/boucle ciblés puis la suite complète ont passé.

Le patch #16 a présenté un conflit dans `src/pages/AdminDashboard.tsx`. La résolution conserve exactement la version du composant #16 (blob `a5efc167223ba2441154992490c2299b6485cabd`) : retrait des tableaux financiers fictifs, provenance des indicateurs, distinction zéro/indisponible, contrôle du propriétaire vérifié et retrait des données lors du changement de compte. Le chargement paresseux et la route réelle `/admin/dashboard` restent ceux de l'application commerce/qualité.

Les fichiers applicatifs client/serveur de #16 sont repris sans adaptation fonctionnelle. Les adaptations d'intégration portent sur les commandes npm, le lancement du navigateur, la CI et la documentation.

## Défauts supplémentaires corrigés pendant l'intégration

- Les nouvelles suites commerce et fondateur n'étaient pas toutes reliées à la CI applicative. Elles le sont désormais, avec les contrats SQL, les vérifications de types et les deux suites navigateur.
- Le harnais fondateur imposait Chrome installé sur la machine. Il utilise maintenant Chromium installé par Playwright en CI ; un chemin explicite `PLAYWRIGHT_EXECUTABLE_PATH` permet de réutiliser Chrome localement.
- Après un test navigateur, ESLint parcourait les fichiers générés sous `.vite` et produisait des erreurs de règles internes aux dépendances. Seul ce cache généré est exclu ; les sources et tests continuent d'être analysés.
- Deux regex Jev rejettent volontairement les caractères de contrôle des credentials. Deux exceptions ESLint locales, avec leur justification, conservent strictement cette protection. Les échappements inutiles d'une fixture JSON ont été retirés sans changer sa valeur.
- Les actions modifiées dans cette CI sont épinglées à leur SHA observé ; le checkout ne conserve pas ses credentials. Node est fixé à 22.23.4 et Deno à 2.9.7, versions attestées localement.
- Le graphe GitNexus et les preuves sont isolés du travail des autres terminaux. Aucun remplacement global de Node, de configuration npm ou de dépendances partagées n'a été effectué.

## Portes exécutées

Les commandes utilisent Node **22.23.4**, Deno **2.9.7** et, pour le navigateur local, **Chrome 157.0.8103.39** sur macOS ARM64. L'installation des dépendances publiques est isolée, à partir des lockfiles, avec `--ignore-scripts --no-audit --no-fund`. Les vérifications fonctionnelles ont ensuite utilisé Node 22 ; cela ne prétend pas reproduire une exécution Ubuntu de GitHub Actions.

| Porte | Commande / emplacement | Résultat |
| --- | --- | --- |
| KARTA complet | `npm test -- --maxWorkers=1` dans `karta/` | **705/705**, 54 fichiers |
| Types KARTA | `npm run typecheck` dans `karta/` | **PASS** |
| Build KARTA | `npm run build` dans `karta/` | **PASS** |
| Types application | `npm run typecheck` | **PASS** |
| Lint application et KARTA | `npm run lint` | **PASS**, 0 erreur, 30 avertissements conservés |
| Contrats SQL générés | `npm run check:database-contracts` | **PASS**, conformes au catalogue SQL versionné |
| Plans commerciaux | `npm run test:commerce:plans` | **17/17** |
| Handlers commerciaux Deno | `npm run test:commerce:handlers` | **40/40**, réseau non autorisé |
| Contrats client/serveur fondateur | `npm run test:founder` | **47/47** |
| Types fondateur | `npm run test:founder:types` | **PASS** |
| Entrée Edge fondateur | `deno check --cached-only --no-config supabase/functions/founder-dashboard/index.ts` | **PASS** |
| Build application | `npm run build` | **PASS** |
| Navigateur qualité/commerce | `npm run test:quality` | **46/46** |
| Navigateur fondateur | `npm run test:founder:browser` | **16/16**, écrans 390 px et 1280 px |
| Recontrôle Jev après correction du lint | `npm test -- test/jev-client.test.ts test/jev-schema.test.ts test/jev-tool.test.ts --maxWorkers=1` dans `karta/` | **83/83**, sous-ensemble des 705 |
| Recontrôle types/build KARTA après correction du lint | Même commandes | **PASS** |
| Audit des dépendances de production KARTA | `npm audit --omit=dev --audit-level=high --json` | **PASS**, 0 vulnérabilité signalée |
| Audit des dépendances de production du site | Même commande | **PASS au seuil high**, 0 haute/critique, 4 modérées et 2 faibles |

Les 705 + 17 + 40 + 47 + 46 + 16 scénarios représentent **871 passages distincts dans les six suites**. Les 83 tests Jev et les 18 tests ciblés précédents ne s'ajoutent pas à ce total. Aucun de ces chiffres ne mesure une couverture fonctionnelle exhaustive.

La suite KARTA complète conserve ses assertions, son isolation entre fichiers et ses timeouts. Elle est simplement exécutée avec un seul worker concurrent pour les fixtures PostgreSQL/WASM.

La première passe de lint a échoué : ce résultat est conservé dans les preuves. La revalidation a passé après les corrections décrites. Les types et le build KARTA ont été relancés ; les 83 tests Jev ont été relancés après la modification de la fixture. Aucun comportement des composants/handlers navigateur n'a changé après leur passe complète.

## Analyse d'impact et revue

GitNexus **1.6.12** a effectivement été installé dans un répertoire de travail isolé et exécuté. Les analyses avant modifications, la détection des changements avant le merge et les logs sont conservés. L'index est partiel : des candidats, appels et parcours sont tronqués par les limites de l'outil. L'absence d'arête n'est donc pas une preuve d'absence d'utilisation.

L'analyse du transport `requestJev` relève un appelant direct (`execute`), risque LOW. La fabrique de l'outil et le composant chargé paresseusement ne sont pas complètement résolus, statut UNKNOWN ; les appels réels sont contrôlés dans le texte et dans les tests. Le nom générique `result` d'un double de test provoque un impact CRITICAL exagéré reliant des symboles homonymes ; cet avertissement a été conservé et signalé, sans le prendre pour une mesure exacte du périmètre.

La détection finale des changements a été exécutée après réindexation : 23 fichiers / 133 symboles / 5 flux sur le staged, risque MEDIUM. La comparaison avec le main distant observé couvre 292 fichiers / 1 224 symboles / 385 flux, risque CRITICAL : elle inclut toute la pile de corrections antérieures. Ce risque est signalé ; la proposition de revue garde #15 comme base. L’index final rapporte 9 307 nœuds, 21 645 arêtes, 304 communautés et 541 flux, avec ses limites de troncature explicites.

La revue React porte notamment sur le nettoyage des effets et timers, l'annulation et le rejet des réponses d'anciennes sessions, l'affichage des indisponibilités, le rendu échappé des noms et la taille bornée de la liste. Le composant conserve les vérifications du serveur ; la permission affichée côté client n'est pas utilisée comme autorisation de données.

## Limites, dette et conditions de mise en service

**PARTIEL — lint et dépendances.** Trente avertissements ESLint subsistent, notamment dans les dépendances de hooks et les exports Fast Refresh de fichiers déjà présents. Le site conserve la chaîne OpenTimestamps signalant quatre vulnérabilités modérées et deux faibles. Aucun `npm audit fix --force` ni remplacement sémantique majeur n'a été appliqué. L'audit de production ne couvre pas les dépendances de développement.

**BLOQUÉ — exécution distante de CI.** Les jobs récents examinés n'avaient pas démarré de runner (aucune étape exécutée). Les résultats locaux ne sont pas présentés comme une CI distante réussie. Il faut rétablir le service Actions puis relancer les checks sur le SHA publié.

**NON TESTÉ — production.** Cette vérification n'a pas exécuté les suites dédiées aux environnements réels DocuSeal/KARTA, les paiements Stripe, les mails, les backends n8n ou les routes sur les comptes des utilisateurs. Les tests navigateur utilisent des transports simulés ; les handlers utilisent de vraies implémentations avec fournisseurs simulés.

**PARTIEL — données financières et opérations globales.** Le tableau de bord couvre PURAMA AI et affiche explicitement les connexions restant à finaliser. Les comptes de l'association et de la société, les encaissements/remboursements réels et les commandes globales IAO/ONE ne sont pas consolidés par ce patch.

**Condition de déploiement commerce.** La migration ACL de #15 ferme des écritures historiques directes. Les anciennes opérations client `signContract` et `regenerateLink` doivent disposer de leurs opérations serveur autorisées ; les données de paiements historiques doivent être réconciliées. Appliquer la migration aveuglément en production n'est pas une conséquence de ce PASS local.

**Limite de transport fondateur.** Le SDK Supabase installé maintient le timeout jusqu'à la consommation du corps, et le handler borne la liste renvoyée. Le client ne limite pas séparément le nombre d'octets avant décodage JSON ; ce point reste une amélioration ciblée possible, sans prétendre qu'un plafond a été testé ici.

## Preuves et reproductibilité

Les receipts de chaque commande consignent le cwd, le SHA HEAD, l'arbre de référence, le SHA-256 du diff de travail, l'heure UTC, la durée, le code de sortie et le SHA-256 du log. Les sorties initiales négatives sont conservées. Les variables d'environnement d'exécution sont limitées à une liste autorisée ; les valeurs Supabase utilisées pour le build sont fictives.

La composition locale est préparée dans `purama-patches/iao-integrated-20261110/code` et les receipts dans son dossier voisin `evidence/`. Les preuves finales exportées pour la revue contiennent les textes et leurs empreintes, sans captures écran ni credentials. Les preuves embarquées historiquement dans #13/#15 restent identifiées comme historiques, distinctes des exécutions du présent audit.

Les métadonnées GitHub ont été relues après les suites : `main` vaut `d116dc8a6429ea76c67167a195eb3f723f2251fb` et #15 reste ouverte, en brouillon, non fusionnée au SHA de base indiqué plus haut.
