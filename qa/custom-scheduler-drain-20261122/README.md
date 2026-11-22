# Agents personnalisés : créneaux stables et arrêt coordonné

## Résultat et périmètre

**PASS local sur les critères ci-dessous ; exploitation réelle NON TESTÉE.** Ce correctif poursuit la branche de revue IAO, sur la base `2890f3c78665b19dde08272aec170709e08225fd`, dans le périmètre déjà autorisé par Matiss les 21 et 22 novembre 2026. Le responsable de ce lot est l’agent `iao_completion` ; la revue croisée est assurée par l’agent principal.

Le planificateur des agents personnalisés utilisait l’heure du callback pour la clé de mise en file. Un même créneau exécuté avec retard pouvait donc recevoir deux identités ; deux créneaux distincts exécutés pendant la même minute pouvaient aussi être fusionnés. Par ailleurs, son arrêt ne rendait aucune promesse au runtime : celui-ci pouvait fermer la file et Redis alors qu’une soumission était encore engagée.

Le code rattache maintenant chaque exécution à `TaskContext.date`, attend les producteurs admis et les destructions de timers, et conserve les générations de redémarrage séparées. L’invalidation des anciens callbacks reste immédiate. Les erreurs de nettoyage rendent l’arrêt non confirmé sans exposer le détail interne.

La revue indépendante a identifié le cas des expressions cron à six champs. Elles sont effectivement acceptées par le `node-cron` installé. Elles utilisent désormais la précision à la seconde ; les expressions à cinq champs conservent le format de clé à la minute. Aucun plafond de fréquence n’a été introduit.

## Critères reçus

| Critère | Preuve |
| --- | --- |
| Un même créneau garde son identité malgré le retard | Régression reproduite puis corrigée. |
| Deux minutes planifiées restent distinctes dans une exécution groupée | Régression reproduite puis corrigée. |
| Six créneaux de dix secondes produisent six clés | Deux nouveaux cas échouaient avant la prise en compte des secondes ; ils passent ensuite. |
| L’arrêt attend toutes les mises en file commencées | Tests avec soumissions suspendues et callbacks qui se chevauchent. |
| Un timer remplacé reste inclus dans le drainage | Tests de remplacement pendant l’exécution et de destruction asynchrone. |
| Un ancien contrôleur ne perturbe pas un redémarrage | Deux générations actives dans le banc, drains séparés et anciens callbacks inertes. |
| Le runtime ferme la file après le producteur | Test du véritable `createRuntime`, avec contrôle de l’ordre des fermetures. |
| Une soumission non coopérative ne donne pas un faux arrêt propre | La limite globale du runtime renvoie `false`. |
| Le vrai cycle de vie `node-cron` fonctionne | `task.execute()` réel, destruction du registre, attente de la soumission puis fin de l’arrêt. |

La première contre-épreuve compte **10 échecs sur 10** sur le code d’origine. La seconde compte **2 échecs et 10 réussites** avant le correctif des secondes. La campagne finale compte **72 tests réussis, zéro échec, zéro exclusion, dans huit fichiers**. Ces campagnes ne s’additionnent pas.

Le typage complet et la compilation KARTA ont tous deux terminé avec le code **0**, en conservant les configurations strictes du dépôt. Les commandes, versions d’exécution et empreintes SHA-256 sont dans `verification.json`. Les tests utilisent des effets de base et de file inertes ; ils n’envoient ni email ni appel.

## Analyse d’impact et limites

L’analyse préalable a utilisé le graphe existant du commit `812830f9bba392f8fcb109a844f083638520a273`. Le fichier ciblé est strictement identique à l’empreinte enregistrée dans ce graphe et à sa version dans la base de travail. GitNexus a classé `destroyTask` **CRITICAL** ; cet avertissement a été signalé avant édition. Les appels réels du runtime ont également été relus et testés.

La reconstruction de l’ensemble du graphe a été interrompue par la mémoire disponible. Un miroir d’analyse limité aux fichiers du planificateur, de son runtime et de leurs tests a été constitué à partir des blobs Git exacts. Son premier index a réussi. Sa réactualisation après la revue des secondes a été interrompue (137). La détection finale s’exécute avec le code 0 et retrouve les cinq fichiers attendus, mais l’état complet du graphe final reste **PARTIEL**. Ce résultat ne diminue pas le risque initial CRITICAL et ne qualifie pas la branche principale. `scope-provenance.json` fixe les sources de ce miroir. Les essais interrompus restent conservés dans le dossier de travail ; ils ne constituent pas des contrôles réussis.

## Intégration

La branche `fix/custom-scheduler-drain-20261122-dcfb` conserve le déploiement automatique désactivé. Le correctif ne change aucune migration, permission, règle commerciale ou cadence enregistrée.

**Avant tout changement de producteur en exploitation, arrêter et drainer l’ancien runtime.** Les clés des expressions à six champs gagnent des secondes : faire fonctionner simultanément une ancienne et une nouvelle version ne constitue pas une transition qualifiée. Le format à cinq champs est préservé. Un effet de file déjà engagé ne peut pas être rétracté par un arrêt ; un arrêt arrivé à sa limite reste signalé comme non confirmé.

Redis réel, les fournisseurs de courrier et de téléphonie, le déploiement et l’endurance ne sont pas reçus par ces tests. Les modifications Gmail et calendrier réalisées parallèlement sont préservées dans leurs branches distinctes.

Référence de contrat : [cycle de vie officiel de node-cron](https://www.nodecron.com/task-lifecycle) et [contexte d’exécution](https://www.nodecron.com/getting-started.html).
