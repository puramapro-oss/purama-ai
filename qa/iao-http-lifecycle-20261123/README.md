# IAO — Continuité des requêtes HTTP — 23 novembre 2026

## Identité et périmètre

- Dépôt : `puramapro-oss/purama-ai`.
- Base inspectée : `aa3220fca64ba786fb4fcb18daf379ce0d17e7c5`, branche de consolidation `audit/reliability-oauth-20261110`.
- Branche isolée : `fix/iao-http-lifecycle-20261123` ; déploiement Vercel automatique désactivé.
- État de conception : `PRET_A_CODER` pour la correction des contrats existants de disponibilité, identité et arrêt. Autorisation collective du 21 novembre réutilisée ; demande actuelle de fiabilité et de continuité.
- Responsable du correctif : agent `assemblage_runtime_iao_20261123` ; réception et intégration : agent racine. Recherche du délai socket : agent `performances_locales_iao_20261123`.
- Fichiers produit : `karta/src/api/server.ts`, `karta/src/api/iaoRoutes.ts`, `karta/src/iao/iaoFacade.ts` et `karta/src/iao/kartaRuntimePort.ts`. Les deux derniers exposent uniquement une métadonnée bornée du budget déjà appliqué par le port. La sémantique de `prepare` reste inchangée.
- Aucun assemblage factice de SMARANA, aucun authentificateur de remplacement, aucune modification des permissions ou des modèles.

## Critères d’acceptation

1. Une panne de dépendance refuse les nouvelles soumissions sur les deux alias IAO.
2. Une requête déjà admise reste consultable et annulable par son utilisateur authentifié pendant cette panne.
3. La reprise de disponibilité n’exécute pas une nouvelle fois une ancienne requête.
4. Les identités absentes, expirées ou incohérentes et les accès d’un autre utilisateur ou tenant restent refusés.
5. Un arrêt du runtime garde la priorité, y compris s’il survient pendant une attente d’authentification ou de lecture du corps.
6. L’admission est contrôlée au moment de l’exécution, après les attentes HTTP ; une disponibilité ancienne ne vaut pas permission de démarrer.
7. Les réponses restent non stockables dans les caches HTTP ; les routes administratives conservent leurs règles.
8. Une complétion autorisée de plus de quinze secondes conserve son transport, dans la limite du budget fini du port.
9. Une deuxième requête partageant ce socket garde sa propre échéance de préadmission de quinze secondes ; sa résolution tardive ne provoque aucun accès à la façade.

## Analyse avant modification

GitNexus 1.6.12 a indexé la base en 100,4 s : 29 449 nœuds, 95 170 relations. La recherche FTS n’est pas disponible dans cet environnement. Les limites de résolution et de parcours du graphe imposent une lecture complémentaire des frontières HTTP ; un chemin non listé n’est pas une preuve d’absence.

| Symbole | Dépendances directes observées | Risque renvoyé | Lecture complémentaire |
|---|---|---|---|
| `handleRequest` | 1 | LOW | Callback du serveur HTTP et branches de disponibilité. |
| `handleIaoRoute` | 4 | LOW | Serveur, tests de façade et frontière d’identité ; huit parcours associés au groupe `handleRequest`. |
| `startApiServer` | 7 | MEDIUM | Démarrage, suivi des requêtes actives et suites HTTP. Aucune modification autorisée initialement sans reproduction du délai. |
| `IaoFacade` | 9 | MEDIUM | Métadonnée facultative, validation du budget et absence d'effet sur `submit`. |
| `KartaRuntimeIaoPort` | 7 | MEDIUM | Budget dérivé des étapes déjà bornées ; résolution par interface incomplète dans le graphe. |

Les recherches sur l’apprentissage et les performances complètent le dossier IAO existant. Elles ne valent pas activation d’une nouvelle chaîne d’apprentissage.

## Résultats

**PASS — qualification locale du delta.** La qualification complète de la CI est exigée avant intégration ; ses SHA, arbres et résultats seront consignés dans la PR et le dossier IAO existant, sans réécrire ce commit pour lui ajouter sa propre preuve.

| Vérification | Résultat et preuve |
|---|---|
| Reproduction readiness avant correction | 11 échecs / 19 tests ; `readiness/red.log`. |
| Même suite après correction | 19/19 réussis ; `readiness/green.log`. |
| Reproduction échéance avant correction | 8 échecs / 9 tests ; `admission/red.log`. |
| Même suite après correction | 9/9 réussis ; `admission/green.log`. |
| Régressions finales, première exécution | 234/234, huit fichiers ; `admission/regression.log`. |
| Régressions finales, transport et budgets | 36/36, trois fichiers ; `admission/budget-regression.log`. |
| Total sans compter les 26 tests communs deux fois | **244 tests uniques, neuf fichiers**. |
| TypeScript | Code de sortie 0 ; `admission/final-typecheck.json`. |
| Socket natif avant correction | `ECONNRESET` après environ 15,019 s alors que la tâche continue ; `socket-before/result.json`. |
| Socket natif après correction | Connexion ouverte après 16,046 s ; réponse 202 `verified` après 16,063 s ; `socket-after/result.json`. |
| Revue indépendante du pipelining | Deuxième réponse 503 terminée côté serveur après environ 15,033 s ; première tâche toujours active puis 202 `verified` ; `pipeline/pipeline-admission-green.json`. |

Les deux commandes Vitest finales figurent dans les fichiers JSON voisins des logs. Les empreintes du produit et des preuves sont dans `manifest.json`. Les preuves natives utilisent Node 24.22.3 ; la CI du dépôt qualifie Node 22.

## Contrats conservés et correction

- Une indisponibilité de dépendance refuse une nouvelle soumission ; elle ne retire plus les lectures et annulations authentifiées des travaux déjà conservés.
- L'arrêt du runtime reste prioritaire après chaque attente et juste avant le dispatch.
- Les réglages globaux du serveur restent à 15 000 ms pour le socket et la réception de requête, 10 000 ms pour les en-têtes. Seule une réponse authentifiée et admise reçoit le budget de son port augmenté de 1 000 ms.
- Le budget est facultatif et validé : entier strictement positif, au plus 1 200 000 ms. Une métadonnée absente, invalide ou lançant une erreur ne modifie pas le délai initial.
- Le port standard expose deux étapes de 120 000 ms par défaut pour une conversation, soit un délai de réponse de 241 000 ms sur un socket initial de 15 000 ms. Ce plafond n'ajoute aucun appel de modèle.
- L'échéance monotone de préadmission est partagée entre readiness, authentification, corps et contrôle final. Elle est indépendante du socket et ses timers sont nettoyés avant le travail admis.
- Aucun timeout concurrent n'entoure `facade.submit` ou `prepare`. Une déconnexion ne prétend pas annuler une opération déjà lancée ; le drainage reste lié à sa vraie fin.

## Limites et réception

- Les dépendances injectées sont des doubles contrôlés : aucun appel fournisseur payant, aucune mémoire SMARANA réelle et aucune inférence sur le Mac ne sont qualifiés ici.
- Une opération d'authentification, de disponibilité ou de lecture non annulable peut continuer après l'échéance. Son résultat tardif ne reprend plus le dispatch.
- Sur une connexion HTTP/1 pipelinée, les octets du second 503 attendent la première réponse. Le refus côté serveur est produit à l'échéance ; aucun traitement supplémentaire n'est lancé.
- Un calcul synchrone ne peut pas être préempté par un timer JavaScript ; le contrôle monotone refuse son dispatch après dépassement.
- Le délai d'arrêt gracieux existant de 30 secondes n'est pas prolongé par ce correctif. Un budget HTTP plus long ne constitue pas une garantie de drainage pendant vingt minutes.
- Le raccordement de la mémoire canonique, de l'autorité de session et du routeur automatique entre fournisseurs reste un travail distinct, non activé par ce delta.
- GitNexus signale un périmètre global CRITICAL sur le serveur et la façade partagés. Les rapports détaillés et la comparaison avec `main` sont conservés dans `impact/` ; la revue distingue les associations du graphe des fichiers réellement modifiés. Les tests complets de CI restent un critère d'intégration.
