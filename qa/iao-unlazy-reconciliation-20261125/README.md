# IAO — Réconciliation de la vérification observée, 25 novembre 2026

## Résultat et portée

**PASS — composition locale du lot existant, sans conflit ni réécriture produit.**
La branche de travail `audit/unlazy-reconciliation-20261125` compose la base
`d25f2e72a59689def3d8095db31c086a8b6eeca9` avec
`82d7e11299bab207688144807b35bd86451041ef`. L'ancêtre commun est
`795d7db298416f98cf95103c096714f82c01c8cb`.

Le lot apporte les commits existants `383d54cc3b47415b2cc5fe3e2351a9212dc95ad3`,
`42b86982fe880539b41827fe0969fd6285ac759c` et `82d7e112…` ; son histoire reste
conservée. Les 18 fichiers de source, tests, consignes et documentation sont
identiques octet par octet à ceux du lot source. Les 64 reçus de QA historiques
sont conservés avec leurs résultats et limites d'origine. Aucun autre parcours
de d25 n'a été remplacé. La recherche GitHub par le nom exact de la branche
source n'a retourné aucune PR ; ce résultat de recherche n'est pas une preuve
exhaustive d'absence de publication.

La lacune constatée était l'absence, sur d25, du contrat d'observation du livrable,
du module de retour correctif durable et de leurs tests. Le raccordement réutilise
CHEF et la politique canonique. Il ne crée ni orchestrateur parallèle, ni nouvelle
migration, ni installation d'un observateur.

Un seul réglage supplémentaire de publication est ajouté dans `vercel.json` :
`git.deploymentEnabled["audit/unlazy-reconciliation-20261125"] = false`.
Il maintient le déploiement automatique désactivé pour cette branche de revue.
Toutes les entrées existantes et les autres propriétés du fichier sont conservées.

## Qualification de la composition

L'arbre testé avant ajout de ce dossier de reçus est
`88c61e052c99cd85aa54159805f761417281bcb4`. Le manifeste SHA-256 de
`verification.json` lie les résultats aux 18 fichiers concernés.

| Contrôle exécuté | Résultat observé |
| --- | --- |
| KARTA, campagne ciblée de 23 fichiers | **PARTIEL : 577 réussites, 10 échecs, 0 assertion ignorée** ; sortie 1 |
| Trois nouveaux fichiers observation/retour/correction | **95/95 PASS**, inclus dans la campagne ci-dessus |
| TypeScript KARTA | **PASS**, sortie 0 |
| Compilation KARTA | **PASS**, sortie 0 |
| ESLint des 16 fichiers TypeScript du lot | **PASS**, 0 erreur et 0 avertissement |
| Composition Git et vérification des 18 empreintes | **PASS**, aucune résolution de conflit requise |

Les dix échecs sont tous des erreurs `listen EPERM` à la création des fixtures
de sockets Unix dans `localComputeFabricProvider.test.ts`, avant les assertions
de transport. Les trois autres cas de ce fichier passent. Aucun délai, droit,
contrôle, assertion ou test n'a été désactivé pour modifier ce résultat. Le rapport
complet, sa commande et le code de sortie restent disponibles dans
`composed-tests.json` et `composed-tests-receipt.json`.

La campagne couvre les 16 fichiers du lot déjà qualifié, les trois suites SQL de
fraîcheur/preuves/budgets et le fournisseur Fabric, puis les régressions d'annulation
Git, d'arrêt du worker et du runtime atelier. Elle vérifie notamment la reprise sur
le commit exact, la liaison de portée et de génération, le refus d'une preuve
modifiée, l'arrêt sans progrès et la conservation du travail préexistant. Les
processus et dépôts Git temporaires sont réels ; modèles et transports Supabase
sont des fixtures. Le libellé « audio » d'une fixture ne constitue pas une écoute.

## Preuve native distincte

Avant la composition, les quatre suites auparavant bloquées ont été réexécutées
sur le Mac, au commit `82d7e112…`, avec Node 26 et Vitest 5.0.3 :
**79/79 PASS**, sortie 0, zéro assertion en attente. Elles comprennent les
13 cas Fabric et les 66 cas SQL de fraîcheur, de preuve et de budget. Les délais
par défaut sont restés inchangés et un seul worker a été utilisé.

Le rapport exact est conservé dans `native-requalification-79.json`, SHA-256
`c1d3eb97d00d672e0eae4bd0dd206392ce02450083afc9d022025c3b70a18f07`.
Les modules et tests Fabric concernés, ainsi que le lock KARTA, sont identiques
dans la composition. Ce résultat est une preuve native liée à ces entrées sur
82d ; il ne transforme pas les dix échecs Linux en réussites de cette campagne
et n'est pas annoncé comme une nouvelle exécution du checkout composé.

## Contrôles sur la base d25

La base exacte a également passé 855 tests frontend sur 46 fichiers, 69 contrôles
hors-ligne et cinq parcours dans un vrai Chromium local. Les appels API des
parcours navigateur étaient simulés. Ces résultats portent sur d25 et leurs
sources frontend/hors-ligne restent inchangées dans cette composition. Ils ne
s'additionnent pas aux compteurs KARTA. Les huit workflows GitHub réussis sur d25
qualifient cette base ; **la composition locale n'a pas encore de CI hébergée**.

## Analyse d'impact et limites

GitNexus 1.6.12 a indexé la base exacte puis la composition, avec un parseur,
sans FTS ni embeddings, en mode sans modification des instructions. Le fichier
`gitnexus-scope.txt` décrit le périmètre : CHEF, politique/transport communs et
fournisseur local. Le graphe ne couvre pas tout le dépôt.

Les impacts du vérificateur et du pilote Codex sont **CRITICAL** ; ceux du
superviseur, du profil de vérification et de la configuration atelier sont **HIGH**.
Ces risques ont été signalés avant la composition. Les appelants directs pertinents
ont été examinés et leurs suites de régression intégrées à la campagne ciblée.
La première détection staged identifie 132 symboles et 30 flux sur les 82 chemins
du lot et de ses preuves historiques ; le risque reste CRITICAL. Les appels et
leurs sorties sont conservés dans `impact-before/` et `graph-after/`.

Le contrôle de propagation des données ne retourne aucun finding sur les cinq
fichiers examinés. Les gardes du lecteur d'artefact et de la validation du retour
sont présentes dans le graphe PDG. Ces résultats statiques ne prouvent pas une
absence universelle de défaut : callbacks, propriétés et flux implicites restent
hors modèle, et le graphe est limité au périmètre décrit.

**NON TESTÉ sur cette composition :** CI hébergée, fournisseur réel, observateur
audiovisuel réel, parcours en production et activation de profils de l'hôte.
L'observation demeure optionnelle et nécessite une commande indépendante de
confiance. Une interruption sans checkpoint de génération impose toujours une
réconciliation explicite. Aucune branche distante, fusion vers main, migration,
dépense, publication ou mise en production n'a été effectuée.
