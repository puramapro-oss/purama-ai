# IAO — jalon AETHER intégré du 10 novembre 2026

## État du jalon

**PASS local sur KARTA et les contrôles affectés. PARTIEL pour une qualification complète. Aucune publication, fusion principale ni mise en production réalisée par ce lot.**

Ce complément reprend les protections découvertes dans la branche AETHER pendant l'audit. Il prolonge l'[assemblage initial documenté](iao-integration-20261110.md), conservé au commit `bc5076fc2c8589e54c09559ed246ae0022ae3a4c` et à l'arbre `665af841209c545da46252244fc5e99544f532de`. Les résultats du premier jalon ne sont pas réécrits.

La branche AETHER observée est `audit/aether-karta-consolidation-20261110`, commit `1daf6314d60f6dd336c3a3601ddf73cf432ef4b3`, créé le 10 novembre à 00:50:04 UTC. Son parent est la PR #14, `d003159bdf3216b155f747b0f8fa93b3a92e5b3a`. Ce commit a été relu après l'exécution des suites ; la branche distante était toujours à cette version.

Le travail d'intégration se déroule sur une branche locale distincte `work/iao-aether-integration-20261110`. La branche source AETHER et le premier jalon restent conservés. La branche de revue prévue reste `audit/iao-integrated-20261110`, avec son garde Vercel déjà désactivant le déploiement automatique.

## Comparaison des sources

Parmi les 18 fichiers du commit AETHER :

- **8 fichiers sont déjà strictement identiques** dans le premier candidat : logger, types et minimisation des traces, tests de clôture/journalisation, test de boucle et test de confidentialité d'approbation.
- **5 fichiers de production apportent des protections complémentaires** : quatre sont repris exactement depuis AETHER ; la boucle reçoit en plus la correction locale avant appel au modèle décrite ci-dessous.
- **2 nouveaux fichiers de tests** et **1 reçu historique** sont repris. Le test d’admission et le reçu gardent leurs blobs exacts ; customAuthorization reçoit huit régressions locales supplémentaires.
- Le test `loopTracePrivacy.test.ts` reste celui de #13 : il utilise le véritable outil Jev désactivé. La branche AETHER l'avait remplacé par un outil générique parce qu'elle ne contenait pas Jev. La vérification réelle Jev est ainsi conservée.
- Le protocole d'évaluation reçoit un complément propre à cet assemblage ; le chapitre Jev existant est conservé.

La reprise est ciblée. Les protections commerce de #15, le tableau de bord de #16 et Jev demeurent présents. Aucune branche complète antérieure n'est réintroduite par cette opération.

## Comportement corrigé

### Autorisation des agents personnalisés

Le résolveur reçoit l'identité du demandeur et vérifie le propriétaire, l'activation de l'agent et son activation KARTA. Le worker utilise l'utilisateur du job ; l'approbation utilise l'utilisateur de l'action en attente.

La boucle relit la définition autorisée après le raisonnement et avant chaque effet. Le retrait d'un outil, la désactivation de l'agent ou une lecture d'autorité indisponible arrête l'exécution concernée. Une nouvelle permission apparue après le raisonnement n'ajoute pas un outil au contrat de la décision déjà produite.

Une fenêtre supplémentaire a été reproduite sur le véritable processor du worker : si le propriétaire, is_active ou karta_enabled changeait pendant l’attente de startRun, l’ancien code envoyait encore une requête au modèle avant de bloquer l’outil. Le contrôle négatif donne trois échecs et un succès positif, avec un appel modèle et zéro effet métier dans chacun des trois refus.

La boucle relit maintenant l’autorité **après buildContext et immédiatement avant decide**. Le builder custom actuel construit son contexte à partir du nom et de la description déjà chargés ; cette dernière lecture protège l’envoi de ces données et du prompt au fournisseur. Un refus confirmé clôture le cycle en cancelled, sans appel modèle. Le chemin de clôture commun conserve son unique réconciliation bornée, la protection du premier résultat et le traitement des pannes secondaires. Une réactivation ultérieure ne rejoue pas une clé déjà clôturée.

Une panne de lecture reste distincte d’un refus : error, sans fournisseur. Avant réservation du run, la panne du résolveur reste retryable dans le worker. Après réservation d’une clé durable, le résultat n’est pas rejoué automatiquement ; sans clé durable, la politique existante de réessai avant effet est conservée. Les cas de panne, de reprise après clôture et de révocation pendant buildContext sont vérifiés.

Un refus confirmé d'autorisation est terminal pour l'ancien job. Une panne de lecture avant exécution conserve la possibilité de réessai prévue par le worker. Aucun de ces refus ne devient une permission implicite.

### Confidentialité des traces et des erreurs initiales

Les agents personnalisés utilisent des descripteurs d'outils copiés, avec une trace limitée aux métadonnées. Le registre partagé et les paramètres/résultats nécessaires au traitement métier restent inchangés.

Les erreurs initiales de lecture de l'arrêt global, d'état d'agent, d'écriture d'un cycle ignoré et de création du run ne transmettent plus le détail brut du fournisseur dans l'exception ou le journal du worker. L'échec de transport du claim d'approbation produit un refus générique, sans exécuter l'effet ni remettre une revendication incertaine en attente.

Ces modifications complètent la confidentialité et la conservation du résultat confirmé déjà reprises de #13.

### Contrôle après compilation

Le lint parcourait aussi le répertoire `karta/dist` après compilation. L'exclusion couvre maintenant les répertoires `dist` imbriqués et le cache `.vite`. Aucun fichier source ni test n'est exclu par cette adaptation. Le lint exécuté après build revient à zéro erreur et 30 avertissements de sources déjà présents.

## Vérification avant et après

Les tests emploient les véritables chemins de résolution, boucle, approbation et traitement du worker. Seuls les transports externes, la base, Redis, les notifications et les outils à effet sont remplacés par des fixtures. Les contrôles positifs utilisent `mock: false` et doivent réellement appeler les outils inertes.

| Porte | Résultat observé |
| --- | --- |
| Deux nouvelles suites sur le premier candidat, avant les protections AETHER | **38 échecs et 10 succès sur 48** ; contrôle négatif attendu |
| Deux nouvelles suites après les cinq fichiers AETHER | **48/48** |
| Contrôle ciblé comprenant aussi le test réel Jev et la confidentialité de boucle | **70/70**, sous-ensemble de la suite complète |
| Probe de révocation pendant startRun avant la correction locale | **3 échecs / 1 succès**, fournisseur encore appelé sur les trois révocations |
| Contrôle ciblé final, autorité et clôture comprises | **95/95**, sous-ensemble de la suite complète |
| KARTA complet après correction locale, `npm test -- --maxWorkers=1` | **761/761 dans 56 fichiers**, zéro échec et zéro test ignoré |
| Types KARTA, `npm run typecheck` | **PASS** |
| Build KARTA, `npm run build` | **PASS** |
| Types application, `npm run typecheck` | **PASS** |
| Lint global après build, `npm run lint` | **PASS**, zéro erreur, 30 avertissements |

Ces exécutions utilisent le runtime Node **22.23.4** du premier jalon et les mêmes dépendances verrouillées. Aucun paquet supplémentaire n'a été installé.

Le contrôle négatif démontre que les nouvelles assertions détectent des défauts du premier candidat ; les 38 échecs ne représentent pas 38 vulnérabilités indépendantes. Ses deux nouveaux fichiers de tests étaient alors non suivis par Git : un reçu complémentaire consigne leurs empreintes et leur provenance, en plus de l'empreinte du diff suivi vide. Ils sont ajoutés à l'index avant les exécutions positives et complètes.

## Surfaces conservées et réutilisation des preuves

La comparaison d'objets Git vérifie l'identité avec `bc5076` de :

- tout `src/`, `supabase/`, `public/` et `scripts/` ;
- les tests qualité/commerce/fondateur ;
- la CI, les manifests et lockfiles du site et de KARTA ;
- le garde Vercel ;
- le client, le schéma et l'outil Jev, son registre et son test réel dans la boucle.

Les preuves précédentes restent donc rattachées à des sources identiques : plans **17/17**, handlers commerce **40/40**, contrats fondateur **47/47**, navigateur qualité/commerce **46/46**, navigateur fondateur **16/16**, contrats SQL, build du site et vérifications Deno. Ces portes n'ont pas été relancées pour des fichiers inchangés ; elles ne sont pas présentées comme de nouvelles exécutions.

Le périmètre combiné des six suites est maintenant **927 scénarios** : 761 + 17 + 40 + 47 + 46 + 16. Les 95 ou 70 ciblés, les 48 importés, les huit nouvelles régressions et les exécutions historiques de 612, 705 ou 753 ne s’ajoutent pas à ce total. La passe complète de 753 avant correction de la fenêtre modèle est conservée comme jalon intermédiaire.

Les audits des dépendances de production restent ceux des lockfiles inchangés : zéro vulnérabilité signalée pour KARTA ; zéro haute/critique, quatre modérées et deux faibles pour le site. L'intégration AETHER ne corrige pas cette dette OpenTimestamps.

## Analyse d'impact et limites

GitNexus a été exécuté avant modification. Le builder et le résolveur personnalisés sont classés **HIGH**, avec cinq dépendants sur les chemins du worker et de l'approbation ; l'avertissement a été signalé. La boucle, l'approbation et le démarrage du worker sont classés LOW pour leurs appels résolus.

L’index a été reconstruit après la correction de la fenêtre modèle : 9 529 nœuds, 22 239 arêtes, 314 communautés et 542 flux rapportés. Le nouvel impact runAgentCycle/processJob est classé CRITICAL ; l’avertissement a été communiqué avant modification. Les seuls appelants produit réels de runAgentCycle restent le worker ; les appels du résolveur dans le worker, l’approbation et la boucle ont été contrôlés dans les sources. Les limites de troncature, de dispatch et de recherche sans FTS sont conservées. Les détections finales staged et par comparaison au main sont consignées dans les receipts ; ce graphe ne démontre pas l'absence de chemins non résolus.

**NON TESTÉ** : fournisseurs payants réels, Redis réel, déploiement, authentification sur les comptes de production et concurrence native multiconnexion de la base KARTA. Les tests SQL locaux utilisent PGlite.

La relecture d'autorité précède chaque effet mais ne rend pas atomique la révocation avec une requête ultérieure chez un fournisseur. Les payloads nécessaires à une approbation restent dans leur chemin autorisé ; la minimisation des traces KARTA ne certifie pas les journaux internes de tous les connecteurs.

Les anciens écrans et le traitement OpenTimestamps font l'objet d'un lot distinct. Ce jalon ne prétend pas corriger leurs avertissements ou qualifier leurs parcours de changement de compte. La publication est laissée à l'intégrateur après rapprochement avec ces travaux.

## Dossier de preuve

Les receipts de ce complément sont séparés dans `evidence-aether/`. Ils conservent les commandes, cwd, SHA de référence, empreintes de diff/log, durée, heure UTC et codes de sortie. Les résultats négatifs, les résultats de la branche AETHER importés et les vérifications propres à l'assemblage sont distingués.

Le fichier `karta/test/evidence/aether-consolidation-20261110.json` est une preuve historique importée de la branche AETHER ; il annonce 612 tests sur sa base #14. Il ne remplace pas l’exécution complète de **761** tests sur ce candidat commerce/Jev/fondateur/AETHER.

Le payload de publication contient uniquement les fichiers modifiés par rapport à la PR #15, avec leur contenu exact et un manifeste de blobs. Il sert à reconstruire un arbre vérifiable ; il ne publie aucune référence à lui seul.
