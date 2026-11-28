# IAO — intégration du 24 novembre 2026

Ce reçu décrit la qualification locale du lot préparé sur `60a3f6bce721331566951dee59b4c7b9a4b17099`, depuis la consolidation `audit/reliability-oauth-20261110`. La réception GitHub et la fusion de la branche `feat/iao-integration-20261124` sont suivies dans la pull request du lot. Les échecs et interruptions locaux restent conservés, même si la qualification hébergée réussit ensuite.

## Changements produit

1. **Admission de session.** Les deux chemins de soumission revalident l'authentificateur existant immédiatement avant l'exécution. Tenant, acteur et session restent liés à l'identité initiale ; cette session doit encore être valide. Le budget monotone de 15 secondes est partagé avec la lecture du corps et les contrôles de disponibilité. Déconnexion, révocation et fermeture du runtime empêchent une nouvelle admission. Une soumission admise ajoute un appel à l'autorité.
2. **Rétention et terminaison interne.** Une preuve finale valide clôt aussi un travail devenu obsolète. Son affichage reste `partial/stale`, sa preuve n'est pas publiée comme une réponse actuelle vérifiée et son échéance de conservation commence. Les callbacks suivants ne remplacent pas le résultat, ne renouvellent pas sa durée de vie et ne redélivrent pas son export. L'annulation laisse cette réponse terminée inchangée. Les ports encore en cours restent protégés jusqu'à leur retour ; une réponse partielle sans preuve finale reste ouverte.
3. **Projection mémoire.** Le modèle reçoit une indication lorsque du texte mémoire éligible est abrégé ou omis. Les sources exclues ne modifient pas cette indication. Les deux sections du prompt sont encodées en JSON avec échappement de `<`, et une paire UTF-16 complète n'est plus coupée. La validation intégrale, les permissions, le tri, les bornes existantes et le refus du repli payant sont conservés.

Trois fichiers produit sont modifiés. Quatre fichiers de tests apportent **40 nouveaux cas**. Deux fichiers de tests existants sont adaptés aux comportements explicitement modifiés : la seconde authentification et l'immuabilité interne d'une réponse obsolète déjà terminée. Le contrat IAO documente ces changements. Aucune dépendance, migration, politique de modèle ni autorité nouvelle n'est ajoutée.

## Résultats locaux finaux

| Contrôle | Résultat et portée |
| --- | --- |
| Rétention initiale et admission | 17 cas identiques : 15 FAIL / 2 PASS avant, 17 PASS après ; suite initiale combinée 258 PASS |
| Projection mémoire | 14 cas identiques : 10 FAIL / 4 PASS avant, 14 PASS après ; frontière mémoire et voisins inclus dans 154 PASS |
| Immuabilité complémentaire | 9 tests finaux identiques : 7 FAIL / 2 PASS avant les deux gardes internes, 9 PASS après |
| Régression runtime après l'ultime correction | **261 PASS**, 8 fichiers, aucun cas ignoré |
| Suite KARTA entière, un worker | **PARTIEL : 4 576 PASS, 35 FAIL par `listen EPERM`, 42 cas non qualifiés**, sur 4 653 cas recensés |
| TypeScript global | **PASS**, `npm run typecheck`, heap 1 024 MiB, code 0 |
| Compilation KARTA | **PASS**, `npm run build`, code 0 |
| Revues indépendantes | Projection mémoire et DreamForge relus et exécutés ; admission HTTP contrôlée par cinq scénarios supplémentaires ; terminaison interne relue par la racine |

Les compteurs se recouvrent : les 261, 258, 154 et autres répétitions ne s'additionnent pas au total global. Le premier test d'horloge du lot d'immuabilité supposait une éviction avant la prochaine fenêtre du balayage paresseux ; l'assertion a été conservée et son instant corrigé. L'avant/après final a été rejoué avec le même fichier de tests et la même configuration dans une copie isolée. Les premiers essais, dont cette erreur de test, restent distincts dans les reçus.

Les 35 échecs de la suite complète concernent l'ouverture de sockets Unix : 14 dans `localComputeFabricCancellation`, 10 dans `localComputeFabricProvider`, 11 dans `localComputeFabricResponseBoundary`. Les quatre workers arrêtés par SIGKILL laissent 42 assertions sans qualification : 18 `chefBudgetAdmission`, 6 `consultationPersistenceRecovery`, 17 `walletRpcPermissions`, 1 `partnerChat`. Le dernier cas n'est pas un saut intentionnel : le détail des assertions et des arrêts fait foi, et non le seul agrégat `numPendingTests` du rapport.

Les premières exécutions globales ont été interrompues avec le code 137. Le typage avec une limite artificielle de 512 MiB a ensuite atteint explicitement sa limite de heap ; sa reprise isolée à 1 024 MiB a réussi. Aucun test, contrôle de permissions ou paramètre de sécurité n'a été retiré pour obtenir un succès. Le transport natif et la suite complète doivent être rapprochés de la réception CI de cette branche.

## Sources et analyses

Les cinq grandes pièces sont conservées sans perte sous forme `.gz` pour réduire le poids de la livraison. `compressed-evidence.json` relie chaque nom logique cité dans les reçus à son fichier compressé et aux deux empreintes. Décompresser restitue exactement les octets et noms originaux ; aucune assertion ou ligne de journal n'est supprimée.

- `source-manifest.json` relie les neuf sources produit/tests pertinentes à la base et au candidat par SHA-256.
- `runtime/` conserve les reproductions et les premières régressions. Son reçu précède le correctif supplémentaire d'immuabilité : les empreintes finales de la façade sont celles de `source-manifest.json` et `assembly/`.
- `memory/summary.json` décrit le périmètre et les limites de la projection mémoire.
- `assembly/summary.json`, `assembly/failure-classification.json` et les reçus voisins décrivent la dernière qualification. La copie isolée d'avant correction ne remplace pas le produit courant.
- `assembly/independent-review.md` conserve la contre-revue mémoire et AR. DreamForge est livré séparément ; son code, ses bundles et son archive ne sont pas dupliqués dans ce dépôt.
- `gitnexus/` conserve les impacts avant édition, les limites de l'indexation et les détections finales avant publication.

GitNexus est utilisé sur un index frais couvrant **KARTA seulement**. Le nouvel index est ancré à la racine Git réelle, afin de rapprocher correctement les chemins des diffs ; le profil temporaire de sélection est conservé dans `gitnexus/root-scope.txt`. Aucun fichier source n'a changé pendant son calcul. Les limites de résolution, de profondeur et de nombre de parcours figurent dans le journal : l'absence d'une arête ne prouve pas l'absence d'un appel. Les impacts inconnus ont été complétés par lecture des appelants et tests. La frontière d'authentification a été traitée comme critique ; l'impact mémoire élevé a été signalé avant édition.

## Limites d'intégration

La composition de production exige toujours l'autorité de session IAO, le port SMARANA avec déduplication durable et le serveur Compute Fabric RPC/2. Les interfaces d'injection existent ; les sources examinées ne réunissent pas ces trois implémentations qualifiées. Le CLI conserve donc son comportement actuel, avec refus `503` quand aucun runtime IAO n'est injecté.

Les tests de prompt démontrent ses propriétés structurelles ; ils ne mesurent pas la qualité sémantique, le coût exact en tokens ou la résistance générale d'un modèle aux injections. Le budget reste en unités UTF-16 ; il ne garantit ni la taille de toute l'enveloppe JSON ni l'intégrité des graphèmes composés. L'ordre d'éviction sous pression reste celui des insertions terminées, sans nouveau tri par heure de clôture.

Les fournisseurs réels, le Mac, le navigateur/GPU, la caméra, les appareils AR et la synchronisation entre appareils gardent leurs propres qualifications. Le déploiement automatique de la branche de travail est désactivé dans `vercel.json` ; ce lot ne constitue pas une mise en production ni une fusion vers `main`.
