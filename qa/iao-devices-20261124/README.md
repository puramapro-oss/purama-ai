# IAO — qualification ciblée des appareils du 24 novembre 2026

## Corrections après la première exécution réelle

La première CI sur `a5196d6ebf6f7eda1a5b90fef5b2f2ae7d291332` réussit les jobs KARTA, identité, concurrence et site, mais le nouveau job appareils découvre **4 échecs sur 113 exécutions** : 109 PASS, aucun test ignoré ou flaky. Chat : 30/30 ; hors-ligne : 30/30 ; public : 48/50 ; tactile : 1/3. La [tentative conservée](https://github.com/puramapro-oss/purama-ai/actions/runs/45318081850) n'est pas présentée comme une réception complète.

**Correction du chat :** après rotation en paysage, le dialogue reste dans le viewport mais ses suggestions repoussent la saisie hors de sa zone visible. Le ratio visible de la saisie est 0 sur Chromium 568 × 320 et 0,7453 sur WebKit 844 × 390. Le widget conserve maintenant l'en-tête et le compositeur à taille stable, avec l'historique, les messages, suggestions et support dans une seule zone défilante. Les 51 callbacks et toute la logique précédant le rendu JSX restent identiques. Le typage et les 29 tests du mode consultation passent ; la validation tactile attend la nouvelle CI. Le test initial reste entier et ajoute le défilement des quatre suggestions sans perte d'accès à la fermeture ou à la saisie.

**Qualification WebKit :** les deux échecs publics attendent une position stable du lien d'inscription sous WebKit bureau et téléphone. Le lien et sa destination sont présents. Une [régression de rendu documentée pour la révision r2370](https://github.com/microsoft/playwright/issues/43426) constitue une piste ; elle ne prouve pas seule la cause de ces échecs. La version stable [Playwright 1.65.1](https://github.com/microsoft/playwright/releases/tag/v1.65.1) et son image officielle sont qualifiées avec les mêmes assertions. Trois diagnostics supplémentaires mesurent les callbacks de rendu, timers, rectangles, animations et surfaces filtrées. Les lectures géométriques peuvent modifier le timing : le scénario public initial reste donc distinct et inchangé.

Le couple courant est Playwright **1.65.1**, avec Chromium 159.0.8154.6/r1255, Firefox 159.0/r1572 et WebKit 27.2/r2388. Le registre Microsoft a fourni l'index d'image `v1.65.1-noble` avec le digest `sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579`, égal au SHA-256 du corps reçu. Les versions du paquet, du verrou et de l'image restent contrôlées par le runner existant. Seuls les trois paquets Playwright changent dans ce second ajustement ; le produit, ses animations et les capacités de réseau/autorisation du runner restent conservés.

La source exacte du binaire r2388 n'a pas permis de vérifier l'inclusion de chaque correctif amont. La nouvelle recette ordinaire, et non le seul numéro de version, décidera de la qualification. Les 113 exécutions métier et les 3 diagnostics sont comptés séparément. Les preuves de la première tentative et de la correction sont conservées dans `first-ci-evidence.zip` et `followup-evidence.zip`, avec leurs manifestes.

L'analyse d'impact préalable du widget rend LOW avec deux appelants directs (App et banc chat), celle de Hero LOW avec Index ; Hero reste inchangé. L'index ciblé élargi contient 295 nœuds, 771 relations et 7 flux. La détection des changements indexés rend MEDIUM et signale le flux ChatbotWidget → AddNotice, attendu puisqu'elle voit le composant entier. La comparaison AST confirme que ses callbacks ne changent pas. La seconde détection contre `origin/main` a été interrompue avec code137 : elle reste **PARTIELLE**, distincte de la première comparaison plus petite et réussie. Le contrôle des différences de fichiers et des 29 tests consultation complète cette portée limitée.

## Périmètre reçu avant la CI

Base de consolidation : `3a8d39c9927c461a7300712b719ef0aa6cc1f173`.
Branche de travail : `fix/iao-device-compatibility-20261124`.
La PR104 et le correctif de préservation des preuves Wealth restent intégralement présents. Ce lot prolonge les composants existants sous une seule interface PURAMA.

Le premier changement du site met à jour i18next vers la version corrigée 26.3.4 et ajoute une qualification régulière des parcours déjà présents. La correction ciblée du rendu du chat décrite ci-dessus suit cette première recette. Le correctif de redimensionnement DreamForge est livré dans l'archive canonique séparée, avec son historique ; il n'est pas copié dans ce dépôt.

| Contrôle local | Résultat observable |
| --- | --- |
| Compatibilité des dépendances | **PASS**, 12 tests, dont 7 nouveaux cas ordinaires utilisant les 16 langues intégrées |
| Audit du verrou du site | **PARTIEL**, 0 modérée/élevée/critique ; 3 faibles dans la chaîne OpenTimestamps conservée |
| Typage du produit | **PASS**, `tsconfig.app.json` |
| Typage du nouveau banc navigateur | **PASS**, `browser/tsconfig.json` |
| Collecte des scénarios | **PASS**, exactement 113 exécutions détectées, aucun navigateur lancé localement |
| Compilation locale | **BLOQUÉ**, processus interrompu avec code 137 pendant la transformation Vite ; les 4 actifs hors-ligne ont été vérifiés auparavant |
| Installation locale des navigateurs | **BLOQUÉ**, téléchargement officiel refusé HTTP403 ; aucune preuve de moteur local n'est revendiquée |
| Mac et appareils physiques | **NON TESTÉ**, les deux connexions Mac ont répondu par une erreur interne |

Ces résultats décrivent la préparation locale. La réception des véritables exécutions navigateur et de la compilation figure dans les jobs GitHub Actions associés au commit publié, puis dans la PR et le suivi existants. Une collecte `--list` n'est pas une exécution de test.

## Qualification ajoutée à la CI existante

Le job `device-compatibility` du workflow CHEF réutilise `scripts/ci/run-site-browser.sh` et Node22. La première tentative emploie l'image Playwright1.64.1, puis le couple client/image est mis à jour vers1.65.1 ci-dessus, toujours verrouillé par digest. Le runner reste sans réseau externe et sans identifiants de fournisseur. Les protections réseau des bancs d'origine restent actives.

| Profil Linux | Chat | Navigation et mise en page | Hors-ligne | Toucher et rotation du viewport |
| --- | ---: | ---: | ---: | ---: |
| Chromium tactile 320 × 568 | 6 | 10 | 6 | 1 |
| Firefox bureau 1280 × 800 | 6 | 10 | 6 | — |
| WebKit bureau 1280 × 800 | 6 | 10 | 6 | — |
| WebKit tactile 390 × 844 | 6 | 10 | 6 | 1 |
| WebKit tactile 768 × 1024 | 6 | 10 | 6 | 1 |
| Total d'exécutions prévues | 30 | 50 | 30 | 3 |

Les trois configurations principales importent les bancs existants et sélectionnent leurs assertions, sans les copier ou les affaiblir. Un nouveau scénario utilise réellement les événements `tap` simulés : ouvrir, saisir, pivoter le viewport, envoyer, arrêter la réponse, revenir en portrait et fermer. Il vérifie la conservation du brouillon Unicode, l'interruption d'une requête unique et le retrait de son fragment provisoire.

Chaque surface dispose de son rapport JSON et de traces en cas d'échec. Une défaillance d'une surface n'empêche pas la collecte des autres surfaces du job. Les résultats sont archivés 14 jours dans `iao-device-compatibility-<sha>` ; les tests, leurs configurations et cette description restent versionnés.

## Portée et limites des preuves

La matrice qualifie des moteurs Linux avec des viewports et du toucher émulés. Elle n'établit pas le fonctionnement sur tous les appareils ou toutes les marques, sur Safari/Chrome commerciaux, avec un clavier virtuel natif, des codecs matériels, une caméra, des capteurs ou un casque AR. Les fournisseurs du chat sont simulés dans ce banc : leur qualité, coût et latence réels ne sont pas mesurés ici.

Le scénario d'import hors-ligne existant impose lui-même 390px ; le profil secondaire de restauration n'hérite pas de l'émulation mobile. Ces limites sont conservées dans `browser/coverage-inventory.json`. Les profils iPad/iPhone du banc de distribution existant utilisent déjà WebKit ; le nouveau lot ne présente pas cette couverture antérieure comme inexistante.

## Analyse d'impact et préservation

L'index GitNexus large et sa mise à jour incrémentale ont été interrompus ; leurs journaux sont conservés. Un index ciblé initial a réussi avec 43 nœuds et 55 relations. La reconstruction ciblée finale a réussi avec 72 nœuds, 96 relations, 2 groupes et aucun flux reconnu. FTS est désactivé dans ces index.

`context` et `impact` ont été exécutés sur `loadLanguage`. L'outil ne résout aucun appelant dans cette portée et rend un risque **UNKNOWN**, ce qui ne prouve pas l'absence de dépendants. La lecture complémentaire identifie le sélecteur de langue dans `src/pages/DashboardSettings.tsx`. Cette fonction n'est pas modifiée : la mise à jour porte sur la bibliothèque et son contrat de compatibilité. Aucune frontière d'identité ou d'autorisation n'est élargie.

Les détections de changements avant publication et la comparaison avec `origin/main` sont conservées avec leur portée limitée. L'absence de flux dans ce petit index ne constitue pas un audit complet du dépôt. Les différences de fichiers sont relues séparément.

## Preuves

- `dependencies/README.md` : versions, commandes, audits avant/après, compatibilité et réserve OpenTimestamps.
- `browser/collection-results.json`, `typecheck-result.json`, `review-notes.json` : sélection et revue des 113 exécutions.
- `local-build-receipts.json` : compilation interrompue et typage réussi, avec commandes et codes de sortie.
- `gitnexus/` : portées, contexte, impact et détection des changements.
- `local-logs.zip` et `local-logs-manifest.json` : journaux bruts compressés sans modification, y compris les essais interrompus. Les fichiers `.log` sont exclus du suivi textuel par la règle existante du dépôt.

Les contrats runtime IAO, SMARANA durable, Fabric RPC/2, l'hôte ONE et la persistance entre appareils conservent leurs réserves d'intégration connues. Ce lot n'est pas un déploiement de production ni une validation de ces intégrations réelles.
