# IAO — qualification ciblée des appareils du 24 novembre 2026

## Périmètre reçu avant la CI

Base de consolidation : `3a8d39c9927c461a7300712b719ef0aa6cc1f173`.
Branche de travail : `fix/iao-device-compatibility-20261124`.
La PR104 et le correctif de préservation des preuves Wealth restent intégralement présents. Ce lot prolonge les composants existants sous une seule interface PURAMA.

Le changement du site met à jour i18next vers la version corrigée 26.3.4 et ajoute une qualification régulière des parcours déjà présents. Aucun composant produit du site n'est réécrit. Le correctif de redimensionnement DreamForge est livré dans l'archive canonique séparée, avec son historique ; il n'est pas copié dans ce dépôt.

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

Le job `device-compatibility` du workflow CHEF réutilise `scripts/ci/run-site-browser.sh`, Node22 et l'image Playwright1.64.1 déjà verrouillée par digest. Le runner reste sans réseau externe et sans identifiants de fournisseur. Les protections réseau des bancs d'origine restent actives.

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
