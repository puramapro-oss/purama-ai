# IAO — maintenance ciblée des dépendances

Date : 24 novembre 2026, UTC. Base : `3a8d39c9927c461a7300712b719ef0aa6cc1f173`.

## Résultat vérifié

**PASS : i18next passe de 26.0.4 à 26.3.4.** Le nouvel audit du verrou ne signale plus l'alerte moderate `GHSA-6jcc-5g8w-32mx`. Les douze tests de compatibilité passent après installation.

**PARTIEL : trois entrées de faible gravité restent présentes dans la chaîne OpenTimestamps → bitcore-lib → elliptic.** Elles ne sont ni masquées ni déclarées corrigées. Aucun paquet de cette chaîne n'a été modifié.

| Contrôle | Avant | Après | Preuve |
| --- | --- | --- | --- |
| i18next installé | 26.0.4 | 26.3.4 | `versions-before.json`, `versions-after.json` |
| Tests existants de compatibilité | 5/5 PASS | 5/5 PASS | `compat-before.tap`, `compat-after.tap` |
| Nouveaux tests ordinaires de traduction | 7/7 PASS sur 26.0.4 | 7/7 PASS sur 26.3.4 | `i18next-ordinary-before.tap`, `compat-after.tap` |
| Audit du verrou | 1 moderate, 3 low | 0 moderate, 3 low | `audit-before.json`, `audit-after.json` |
| Alertes high / critical | 0 / 0 | 0 / 0 | mêmes audits |
| Arbre ciblé `npm ls` | PASS | PASS | fichiers `versions-*.json` |
| Comparaison complète du verrou | — | PASS : seul i18next change | `lock-comparison.json` |

Les audits complets retournent le code 1 avant et après, car des alertes sont présentes. Le code 1 du dernier audit ne signifie pas que la correction ciblée a échoué ; il conserve la visibilité des trois alertes restantes.

## Modifications

- `package.json` : plage i18next `^26.3.4` et ajout du nouveau fichier au script existant `test:dependencies`.
- `package-lock.json` : plage racine et entrée `node_modules/i18next` uniquement. Aucun paquet ajouté ou retiré ; aucune autre version modifiée. La nouvelle version officielle n'annonce plus la dépendance directe `@babel/runtime` ; le paquet reste dans le graphe pour ses autres consommateurs.
- `tests/i18next-compat.test.mjs` : sept tests ordinaires de compatibilité. Le fichier existant `tests/dependency-compat.cjs` est inchangé.

Aucun fichier produit, fournisseur, service, workflow ou fonctionnalité OpenTimestamps n'a été modifié. Les preuves de cette sous-tâche ne constituent pas une preuve de publication ou de déploiement.

Empreinte SHA-256 du verrou final audité :

```text
fafcf64aae08475707031a0cd46b9528c4f85db846539732bdd7d5b3b49b894a
```

L'empreinte est également enregistrée dans le reçu de l'audit, le reçu des tests et la comparaison du verrou. Le reçu d'audit confirme que le fichier est resté inchangé pendant cette opération.

## Portée des tests

Les sept nouveaux tests utilisent le paquet installé et les ressources réelles du dépôt lorsque la vérification concerne les traductions intégrées :

1. Français et anglais : chargement et changements de langue répétés.
2. Quatorze autres langues : ajout des ressources, sélection, conservation des chaînes Unicode et résolution de clés de l'interface. Les seize fichiers JSON sont ainsi utilisés.
3. Traduction absente, variante régionale `fr-CA` et langue indisponible : repli français.
4. Interpolation de valeurs ordinaires, objets imbriqués et option explicite d'échappement.
5. Pluriels anglais et les six catégories de pluriel arabe.
6. Fusion ordinaire des ressources imbriquées : conservation des clés voisines et remplacement des valeurs visées.
7. Compatibilité `react-i18next` : fournisseur, hook et rendu React dans la langue active.

Ils passent avant et après la mise à jour : il s'agit d'une vérification de non-régression fonctionnelle. La correction de l'alerte est établie par la version officielle installée et par l'audit final du verrou. Aucun test offensif ou démonstration d'exploitation n'a été développé ou exécuté dans cette voie de maintenance.

Les cinq tests préexistants vérifient le chargement OpenTimestamps, la liste des calendriers autorisés, la conservation d'une preuve pending, les calculs entiers Bitcore et les contrats HTTP de son transport. Le test HTTP utilise seulement un serveur de boucle locale.

**NON TESTÉ dans cette sous-tâche :** appareils physiques, interactions dans un navigateur, complétude linguistique de toutes les traductions, build de production et déploiement. Les contrôles globaux sont coordonnés par l'agent principal.

## Usage actuel et réserve OpenTimestamps

`src/i18n/index.ts` charge les ressources françaises et anglaises intégrées, puis ajoute les autres fichiers JSON via `addResourceBundle` lors du changement de langue. La source de traduction observée est celle des fichiers du dépôt. Cette inspection n'établit pas l'arrivée de ressources de traduction contrôlées par un attaquant ; aucune exploitation publique de l'application n'est affirmée.

Versions conservées :

| Paquet | Version |
| --- | --- |
| react-i18next | 17.0.2 |
| i18next-browser-languagedetector | 8.2.1 |
| opentimestamps | 0.4.9 |
| bitcore-lib | 8.25.47 |
| elliptic | 6.6.1 |

L'avis officiel elliptic `GHSA-848j-6mx2-7j84` ne donne aucune version corrigée. Le registre propose un retour à `opentimestamps@0.0.0` comme changement majeur ; cette suggestion n'a pas été appliquée, car elle ne constitue pas une correction compatible démontrée. La présence de trois entrées d'audit reflète la propagation d'une alerte à cette chaîne de dépendances. Elle ne démontre ni trois défauts indépendants, ni une exploitation, ni une absence universelle d'atteignabilité dans IAO.

Le chargement du paquet OpenTimestamps émet déjà avant la mise à jour l'avertissement Node `DEP0128` relatif à son champ `main`. Cet avertissement est toujours présent ; les cinq tests restent passants. Son élimination et une éventuelle évolution de la chaîne cryptographique nécessitent un lot distinct avec preuve de compatibilité des formats et opérations existants.

## Commandes et preuves

Environnement : Node `v24.22.3`, npm `11.19.1`, répertoire `/workspace/scratch/6431e6d17379/iao-devices-20261124`.

| Commande | Phase | Code | Reçu |
| --- | --- | --- | --- |
| `npm audit --package-lock-only --ignore-scripts --json` | Avant | 1 | `audit-before-receipt.json` |
| `npm run test:dependencies` | Avant | 0 | `compat-before-receipt.json` |
| `node --test tests/i18next-compat.test.mjs` | Avant | 0 | `i18next-ordinary-before-receipt.json` |
| `npm install --ignore-scripts --no-audit --no-fund i18next@26.3.4` | Mise à jour | 0 | `install-targeted-receipt.json` |
| `npm run test:dependencies` | Après | 0 | `compat-after-receipt.json` |
| `npm audit --package-lock-only --ignore-scripts --json` | Après | 1 | `audit-after-receipt.json` |

Les reçus indiquent l'heure UTC, le répertoire, le code de sortie, la durée et les fichiers de sortie. Les fichiers `versions-*.json` contiennent les versions installées, les empreintes et le résultat exact de `npm ls i18next react-i18next i18next-browser-languagedetector opentimestamps bitcore-lib elliptic --json`.

## Sources primaires consultées

- [Avis officiel GitHub i18next : GHSA-6jcc-5g8w-32mx](https://github.com/advisories/GHSA-6jcc-5g8w-32mx) — version corrigée 26.3.4.
- [Version officielle i18next 26.3.4](https://github.com/i18next/i18next/releases/tag/v26.3.4).
- [Avis officiel GitHub elliptic : GHSA-848j-6mx2-7j84](https://github.com/advisories/GHSA-848j-6mx2-7j84) — aucune version corrigée indiquée.
- [Manifeste officiel OpenTimestamps](https://github.com/opentimestamps/javascript-opentimestamps/blob/master/package.json) — version 0.4.9 et dépendance bitcore-lib.

Les métadonnées du registre npm pour `i18next@26.3.4` ont également été consultées avant installation. L'intégrité du paquet dans le verrou correspond à la valeur publiée ; les contraintes de pair TypeScript restent `^5 || ^6` et le pair de `react-i18next@17.0.2` accepte cette version d'i18next.
