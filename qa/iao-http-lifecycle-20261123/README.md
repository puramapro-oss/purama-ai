# IAO — Continuité des requêtes HTTP — 23 novembre 2026

## Identité et périmètre

- Dépôt : `puramapro-oss/purama-ai`.
- Base inspectée : `aa3220fca64ba786fb4fcb18daf379ce0d17e7c5`, branche de consolidation `audit/reliability-oauth-20261110`.
- Branche initiale conservée : `fix/iao-http-lifecycle-20261123`. Reprise isolée : `fix/iao-http-qualified-20261123` ; déploiement Vercel automatique désactivé pour les deux branches.
- État de conception : `PRET_A_CODER` pour la correction des contrats existants de disponibilité, identité et arrêt. Autorisation collective du 21 novembre réutilisée ; demande actuelle de fiabilité et de continuité.
- Responsables historiques : `assemblage_runtime_iao_20261123` et `performances_locales_iao_20261123`. Reprise et qualification : `iao_current_audit`, mandat du 23 novembre ; réception et intégration : agent racine.
- Fichiers produit autorisés pour le correctif initial : `karta/src/api/server.ts`, `karta/src/api/iaoRoutes.ts`. Tests : `karta/test/apiIaoIntegration.test.ts` et suites existantes de façade, identité et cycle de vie.
- Périmètre repris et qualifié : ajout des métadonnées de budget dans `karta/src/iao/iaoFacade.ts` et `karta/src/iao/kartaRuntimePort.ts`, test `karta/test/apiIaoTransportBudget.test.ts`, configuration de déploiement et présent dossier. Le checkout historique demeure intact.
- Aucun assemblage factice de SMARANA, aucun authentificateur de remplacement, aucune modification des permissions ou des modèles.

## Critères d’acceptation

1. Une panne de dépendance refuse les nouvelles soumissions sur les deux alias IAO.
2. Une requête déjà admise reste consultable et annulable par son utilisateur authentifié pendant cette panne.
3. La reprise de disponibilité n’exécute pas une nouvelle fois une ancienne requête.
4. Les identités absentes, expirées ou incohérentes et les accès d’un autre utilisateur ou tenant restent refusés.
5. Un arrêt du runtime garde la priorité, y compris s’il survient pendant une attente d’authentification ou de lecture du corps.
6. L’admission est contrôlée au moment de l’exécution, après les attentes HTTP ; une disponibilité ancienne ne vaut pas permission de démarrer.
7. Les réponses restent non stockables dans les caches HTTP ; les routes administratives conservent leurs règles.
8. Une exécution valide peut dépasser les 15 secondes d'inactivité HTTP sans perdre sa réponse ; son propre délai fournisseur demeure borné.
9. Un client déconnecté avant admission ne déclenche pas tardivement du travail. Une opération déjà admise reste drainée après déconnexion.
10. Un budget absent, invalide ou lançant une exception ne change pas l'admission ; les délais de réception du corps et des en-têtes demeurent conservés.

## Analyse avant modification

GitNexus 1.6.12 a indexé la base en 100,4 s : 29 449 nœuds, 95 170 relations. La recherche FTS n’est pas disponible dans cet environnement. Les limites de résolution et de parcours du graphe imposent une lecture complémentaire des frontières HTTP ; un chemin non listé n’est pas une preuve d’absence.

| Symbole | Dépendances directes observées | Risque renvoyé | Lecture complémentaire |
|---|---|---|---|
| `handleRequest` | 1 | LOW | Callback du serveur HTTP et branches de disponibilité. |
| `handleIaoRoute` | 4 | LOW | Serveur, tests de façade et frontière d’identité ; huit parcours associés au groupe `handleRequest`. |
| `startApiServer` | 7 | MEDIUM | Démarrage, suivi des requêtes actives et suites HTTP. Aucune modification autorisée initialement sans reproduction du délai. |

Les recherches sur l’apprentissage et les performances complètent le dossier IAO existant. Elles ne valent pas activation d’une nouvelle chaîne d’apprentissage.

## Résultats

**Correctif HTTP qualifié localement ; suite complète PARTIEL en raison de 35 sockets Unix interdits par l'exécuteur.**

| Contrôle | Résultat | Preuve |
|---|---|---|
| Reproduction sur la base propre `aa3220f` | 4 échecs attendus : lecture pendant panne, admission après authentification sur les deux alias, coupure à 15 s | `baseline-reproductions.log.gz` |
| Déconnexion avant admission, avant correction complémentaire | 1 échec attendu : `prepare` appelé après fermeture du client | `disconnected-admission-before.log.gz` |
| Déconnexion avant admission et drain des opérations admises, après correction | 3/3 PASS | `disconnected-admission-after.log.gz` |
| Nouveaux tests de budget HTTP | 24/24 PASS, dont une vraie connexion locale attendant 15,1 s | `transport-budget-initial.log.gz` et suite complète |
| Suite KARTA entière | 4 450 PASS sur 4 485, aucun test ignoré ; 35 bloqués par `listen EPERM` avant scénario | `karta-tests.json.gz` |
| TypeScript KARTA | PASS | `typecheck-final.log.gz`, reçu `verification.json` |
| Build KARTA | PASS | `build-final.log.gz`, reçu `verification.json` |
| ESLint ciblé | PASS, règles TypeScript et Hooks du dépôt | `eslint-targeted.log.gz` |

Les effectifs des sous-suites sont inclus dans le total. Les quatre suites initiales de façade/identité/rétention/HTTP passaient déjà à 190/190 lors de la reprise ; elles ne sont pas additionnées de nouveau. L'import inutilisé détecté au premier typage du nouveau test a été retiré ; son diagnostic historique est conservé dans `typecheck-initial.log.gz`.

Les 35 blocages concernent `localComputeFabricCancellation.test.ts`, `localComputeFabricProvider.test.ts` et `localComputeFabricResponseBoundary.test.ts`. Ils échouent à la création du serveur Unix, avant les assertions métier. Aucune exclusion, aucun changement d'assertion ni transport TCP de remplacement n'a été ajouté. La CI native existante doit les recevoir après publication.

### Complément réellement corrigé

La vérification finale de disponibilité pouvait se terminer après la fermeture du client et appeler la façade malgré cette fermeture. La garde de durée de vie vérifie maintenant aussi l'abandon de requête et l'état de la réponse ; elle ne tente pas de répondre sur une connexion détruite. Les tâches déjà admises continuent de suivre leur contrat de drain existant.

Le budget HTTP est seulement une métadonnée bornée du moteur : deux étapes pour une conversation, une pour le contrôle mémoire. Il ne supprime ni le délai du moteur, ni ceux des corps/en-têtes, ni l'identité authentifiée. Le test keep-alive vérifie le retour au délai normal à la requête suivante. Référence du comportement Node : [HTTP — response.setTimeout et server.timeout](https://nodejs.org/api/http.html).

### Réception d'impact et limites

L'index reconstruit avant les modifications a observé 29 485 nœuds et 95 504 arêtes. `handleIaoRoute` et `handleRequest` ont un appelant direct chacun, risque LOW dans l'index. Les appels dynamiques de budget et de démarrage restent incomplets ; une lecture ciblée des appels les complète. `detect_changes` classe l'ensemble HIGH, avec huit parcours associés à `handleRequest` : ce risque a été signalé avant la finalisation. Le résultat final et la comparaison à `main` sont conservés dans ce dossier.

Le lint ciblé réutilise les règles TypeScript et Hooks du dépôt. Le plugin React Fast Refresh, absent de la toolchain disponible, n'est pas chargé pour ces fichiers Node `.ts` ; aucun succès de lint frontend global n'est revendiqué.

`karta/src/index.ts` ne fournit pas encore `iaoRuntime` au serveur standard. Cette qualification porte sur le runtime injecté et les contrats existants, sans prétendre raccorder l'authentificateur, SMARANA et le calcul local de production. Aucun test matériel, fournisseur distant, migration ou déploiement de production n'est revendiqué.


# Complément de qualification — PR 96

Les sections suivantes décrivent le lot initial 8899219, qualifié séparément sur aa3220f avant la fusion concurrente de PR 95. Ses 244 tests locaux et ses 4 496 tests CI restent des résultats historiques de cet arbre. La combinaison avec a898622 et la déduplication des suites nécessitent une nouvelle réception, consignée dans integration/ et dans la PR 96. Les preuves de PR 95 ci-dessus sont conservées.


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
