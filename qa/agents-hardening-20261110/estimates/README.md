# Ingestion des estimations CHEF — 10 novembre 2026

## Résultat et périmètre

**PASS : 58 tests ciblés**, dont 44 nouveaux tests et 14 tests existants de brief/ingestion. Le correctif permet de fournir les estimations d'admission depuis le brief canonique jusqu'aux colonnes SQL déjà utilisées par CHEF.

Fichiers produit et test de ce sous-lot :

- `karta/src/chef/brief.ts`
- `karta/src/chef/mission.ts`
- `karta/migrations/022_chef_mission_estimates.sql`
- `karta/test/chefEstimates.test.ts`

La migration 022 reprend intégralement la fonction de la migration 015 avec uniquement la validation et la persistance des deux estimations. La migration 021 et les autres fichiers d'exécution CHEF appartiennent à des travaux coordonnés séparément. Aucun commit, déploiement, accès à une base distante ou appel de fournisseur n'a été effectué dans ce sous-lot.

## Défaut et compatibilité

Au commit de base `1daf6314d60f6dd336c3a3601ddf73cf432ef4b3`, `normalizeChefBrief` éliminait `estimatedTokens` et `estimatedCostMicros`. De plus, la fonction SQL de la migration 015 ne les insérait pas, même lorsqu'ils étaient fournis directement au RPC. Les deux colonnes restaient nulles. Le script `reproduce-baseline.cjs` lit le vrai code et les migrations 008–015 depuis ce commit et vérifie ces résultats dans une base PGlite privée.

Le correctif :

- conserve les zéros explicites et ajoute les estimations au hash canonique ;
- refuse les nombres négatifs, fractions, nombres non finis, valeurs non numériques et entiers dépassant `Number.MAX_SAFE_INTEGER` ;
- vérifie les mêmes limites en SQL, même si l'appelant contourne la validation TypeScript ;
- exige une estimation pour chaque tâche dans chaque dimension plafonnée, y compris avec un plafond nul ;
- laisse facultative la dimension non plafonnée ;
- préserve exactement la forme normalisée et le hash historique lorsque les deux estimations sont absentes ;
- conserve les contrôles de fichiers autorisés, les profils de vérification, les dépendances, la couverture des exigences, l'idempotence par version/hash et l'accès réservé au serveur.

Le hash historique du fixture sans estimation est `62c06f360859f8533fa837b47e7aa9f92fc77dd5d291d768aa902624e55d205f`. Il a été calculé en exécutant le vrai `brief.ts` de la base, puis fixé dans le test de compatibilité.

Les missions anciennes sans plafond restent acceptées. Les lignes déjà enregistrées ne sont pas réécrites : une ancienne mission plafonnée dont les estimations sont nulles doit recevoir un plan explicite compatible avec l'admission 021, par exemple une nouvelle version du brief. Le correctif n'invente aucune estimation et ne modifie ni tarifs ni quotas commerciaux.

## Analyse d'impact avant édition

GitNexus 1.6.12, index `purama-agents-hardening-20261110` :

| Cible | Résultat observé | Portée connue |
| --- | --- | --- |
| `normalizeChefBrief` | LOW, commande terminée 0 | `hashChefBrief` et `createChefMission`, deux appelants directs |
| `validateChefBrief` | LOW, commande de rattrapage terminée 0 | Un appelant direct, deux indirects, module Chef |
| `ChefBriefTask` | LOW, borne basse, commande terminée 0 | Cinq symboles ; limite explicite du graphe pour les consommateurs d'interface |
| `createChefMission` | UNKNOWN | Aucun appelant résolu ; JSON obtenu avant terminaison 137 du processus |
| `chef_create_mission` dans 015 | UNKNOWN, cible non indexée | Trace manuelle : appel RPC dans `mission.ts`, dernière définition SQL dans 015 |

Le risque fonctionnel **MEDIUM** a été communiqué au responsable avant édition : le changement porte sur le contrat de brief, son hash et l'ingestion budgétaire. L'absence d'arêtes du graphe n'a pas été interprétée comme une absence de consommateurs.

## Vérifications exécutées

Depuis `karta/` :

```sh
npm test -- test/chefEstimates.test.ts test/chefBrief.test.ts test/chefMission.test.ts --reporter=verbose --maxWorkers=1
```

**PASS**, sortie 0 : 3 fichiers, 58 tests, 14,68 secondes. Le journal complet est dans `vitest-estimates.txt`. Les appels de transport Supabase sont remplacés localement ; la normalisation, le corps de `createChefMission`, la vraie fonction SQL et ses contraintes sont exécutés. Aucun paiement ni appel réseau n'est nécessaire.

```sh
npm run typecheck
```

Le premier contrôle global a terminé 2, uniquement à cause du test `chefWorkerShutdown.test.ts` d'un autre sous-lot : incompatibilité de signatures `SignalsListener` et callbacks de signal appelés sans argument. Aucun diagnostic ne concerne les quatre fichiers de ce sous-lot. Le journal est dans `karta-typecheck.txt` ; le responsable et le propriétaire ont été informés. Un contrôle global après leur correction reste nécessaire.

`git diff --check` a terminé 0.

Pour reproduire le défaut de base depuis la racine du dépôt :

```sh
node qa/agents-hardening-20261110/estimates/reproduce-baseline.cjs
```

La sortie vérifiée est enregistrée dans `baseline-reproduction.json`. Un premier essai interrompu par signal 137 pendant la saturation de l'environnement n'est compté comme aucune couverture.

## Limites et suite

Ces estimations servent à l'admission cumulée mise en place séparément dans 021. Elles ne constituent pas un plafond de dépenses réelles auprès des fournisseurs. L'exhaustivité des reçus d'usage, les réservations autour des appels externes et l'arrêt effectif des traitements sont des sujets distincts.

Les essais sont locaux et isolés. Ils ne constituent ni un test en production, ni une preuve de l'intégration commerciale complète. Le responsable du lot réalise la revue finale, les contrôles globaux, le commit et la décision de déploiement.
