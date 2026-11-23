# Réception du périmètre GitNexus

Le contrôle obligatoire a été exécuté sur l'index final `iao-harmony-20261123` avec GitNexus 1.6.12, avant commit. L'index contient 29 623 nœuds, 96 193 relations et 557 parcours ; FTS indisponible. Les rapports complets sont voisins de ce fichier.

## Delta préparé

`detect_changes(scope=staged)` retourne **CRITICAL**, 110 symboles, 485 parcours associés et 54 fichiers préparés au moment du contrôle. Les fichiers additionnels de réception sont des preuves et de la documentation ; le produit demeure limité à quatre fichiers TypeScript, quatre suites de tests et une désactivation de déploiement par branche.

La liste intégrale des symboles modifiés a été parcourue : leurs chemins sont les quatre fichiers produit attendus, les quatre suites attendues, la notice QA et le harnais natif avant correction. Aucune fonction produit extérieure à ce périmètre ne figure parmi les symboles modifiés.

Le nombre de parcours ne constitue pas un décompte fiable des comportements modifiés. En particulier, `context(MAX_EXECUTION_BUDGET_MS)` attribue à cette constante des accès vers des symboles de facturation, de mémoire, d'interface et d'autres fichiers. La lecture du source établit qu'elle est locale, non exportée, définie une fois et lue une fois dans `IaoFacade.executionBudgetMs`. Ces associations du graphe ne sont donc pas retenues comme des appels réels. Le rapport brut est conservé pour rendre cette limite vérifiable.

`context(handleIaoRoute)` confirme les appelants attendus : `server.handleRequest` et les suites de façade, identité et échéance. Les noms `executionBudgetMs` sont ambigus dans l'index ; la lecture des identifiants et fichiers distingue l'interface, la façade, le port et les doubles de test. La route utilise la méthode de la façade, qui consulte le port facultatif.

L'avertissement CRITICAL a été communiqué à l'utilisateur. La réponse au risque est une revue des frontières HTTP, 244 tests locaux uniques, un contre-exemple natif de pipelining reproduit puis corrigé, et la CI complète sur la branche avant intégration. Aucun changement des règles GitNexus ni affaiblissement des tests n'a été réalisé pour obtenir un statut favorable.

## Comparaison obligatoire avec main

`detect_changes(scope=compare, base_ref=main)` a été exécuté avec `main` à `ae84415be0b9516422805910be999a2c1e6350c0` : **CRITICAL**, 9 283 symboles, 557 parcours, 2 221 fichiers. La réponse est tronquée à 1 000 symboles, explicitement signalée par le champ `truncated`.

Ce périmètre inclut l'ensemble de la consolidation historique entre `main` et la branche d'audit. Il n'est pas présenté comme le delta de ce correctif, ni comme une qualification exhaustive de tous les travaux historiques. La destination du correctif reste `audit/reliability-oauth-20261110`, à partir de `aa3220fca64ba786fb4fcb18daf379ce0d17e7c5`. Aucune fusion dans `main` ou mise en production n'est prévue dans ce lot.

## Conservation des preuves

Les rapports GitNexus sont bruts. Les logs de tests copiés ne diffèrent de leurs originaux que par la suppression de lignes vides terminales ; les empreintes originales et la transformation figurent dans `manifest.json`. Les observations, erreurs, résultats, timings et codes de sortie n'ont pas été réécrits.
