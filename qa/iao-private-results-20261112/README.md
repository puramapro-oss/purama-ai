# Qualification du parcours de résultats privés IAO

## Périmètre et critères

Base de travail : `5ca6add91f1c94ce0e0baf42a1934521270ebd47` de la consolidation
PR45. Le commit et l’arbre livrés seront indiqués dans le reçu de la PR de ce lot.

| Critère d’acceptation | Vérification |
| --- | --- |
| Résultat consultable après cycle direct et approbation | Vrais moteurs, vrais outils avec transport injecté et vrai projecteur dans `privateToolResultsExecution.test.ts`. |
| Conservation du partiel sans faux succès | Assertions séparées sur le résultat privé et sur l’état d’exécution. |
| Pas de répétition de l’outil en cas de livraison incertaine | Compteurs d’exécution et réconciliation de RPC ; résultat et erreur sans contenu privé dans les traces. |
| Identité serveur et isolation du propriétaire | Rôles PostgreSQL, RLS, absence de DML direct, propriétaire courant, mauvais run/agent/opération, suppression. |
| Compatibilité des données | Projection réelle → RPC SQL réelle → parseur partagé, notamment DOI Unicode et résultat partiel. |
| Concurrence et absence de résurrection | Suite native avec plusieurs connexions et attente de verrou observée ; exécution en CI requise. |
| Lecture et sélection dans l’agent existant | Tests du lecteur, du panneau et du vrai `CreatorAgentDetail` : jusqu’à 3 résultats, focus, suppression confirmée, changements de contexte A→B→A. |
| Un seul appel de chat, sans payload client de confiance | Handler Edge réel et vraie validation ; données serveur sélectionnées, refus avant effet, contexte de 16 000 octets maximum. |
| Respect de `Retry-After` tardif | Contre-exemple reproduit avant correction puis suite complète `knowledgeSearch.test.ts`. |
| Compatibilité du dépôt | CI globale sur l’arbre exact ; types, build et régressions existantes. |

## Interprétation des preuves

Les tests utilisent des identités, notices, réponses de modèle et identifiants
synthétiques. Les services externes ne sont pas appelés dans les tests de ce
lot. Aucun test factice n’est présenté comme une exécution de modèle payante ou
un déploiement en production.

Les tests de traces utilisent une réponse de modèle factice qui ne reprend pas
la notice source. Ils prouvent l’absence de copie automatique du payload dans
les journaux ; ils ne prouvent pas qu’une réponse de modèle réelle ne reprendra
aucune information de la source. Cette réponse reste conservée dans l’historique
du chat existant.

L’analyse GitNexus est **PARTIELLE** : le checkout courant n’est pas enregistré
après les échecs antérieurs d’indexation. Les impacts de `runAgentCycle` et
`resolvePendingAction` sont issus d’un index précédent, avec contrôle préalable
de l’égalité des empreintes des fichiers. Ils sont `LOW` dans cet index.
L’absence de résultat pour une constante, un handler anonyme, un test ou un
workflow n’est pas assimilée à un risque nul. Les commandes et sorties sont
conservées dans les fichiers `impact-*.json` ; les recherches textuelles et les
tests complètent ces informations.

Une première tentative de tests SQL PGlite a été arrêtée par le système pendant
la compilation WASM. La relance utilise un seul worker et les paramètres
`--wasm-num-compilation-tasks=1 --liftoff-only --max-old-space-size=256` transmis
au worker. La suite exécutée et son résultat figurent dans les reçus ciblés.

Le quota distribué entre workers, les capacités QPU et la mise en service
production restent hors du résultat certifié de ce lot. La documentation
fonctionnelle et les dépendances de livraison sont dans
`docs/iao-private-results.md`.
