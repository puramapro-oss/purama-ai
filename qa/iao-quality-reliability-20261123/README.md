# IAO — fiabilité du chat et des consultations

Corrections bornées sur la base `5df79859548d8732317bc89f9ca837435beaccf2`, dans la branche `fix/iao-quality-reliability-20261123`, à destination de `audit/reliability-oauth-20261110`.

Le périmètre reprend la validation collective du 21 novembre 2026 et la demande de finalisation de l'IAO existante. Les profils, l'interface PURAMA et les travaux mobiles/SMARANA de la PR 99 sont préservés. Aucune nouvelle passerelle, autorité de budget ou orchestration n'est introduite.

## Trois défauts reproduits puis corrigés

### Enregistrement dont la confirmation réseau se perd

Le widget conserve l'UUID du tour avant l'écriture et le transmet à la clé primaire existante de `chat_messages`. Une relance non confirmée réutilise cet UUID. Après une erreur de transport admissible ou un conflit de clé, la poursuite exige une relecture correspondant exactement à l'identifiant, à la conversation, au propriétaire, au rôle et au contenu. Les refus d'accès explicites restent des échecs, qu'ils soient retournés ou levés. La sauvegarde de l'assistant utilise également son UUID, sans nouvelle inférence.

L'arrêt et les changements de compte ou de conversation invalident les opérations en cours. Aucun `upsert`, droit SQL supplémentaire ou changement de schéma n'est nécessaire.

### Catalogue rejeté malgré une politique valide

L'hôte passait les champs de budget et de contexte au validateur strict du catalogue. Celui-ci les refusait avant toute requête fournisseur. L'appel au chargeur natif projette maintenant uniquement `model` et `maxOutputTokens`. Les plafonds, le budget et les droits de l'utilisateur restent contrôlés séparément. Les tests utilisent le chargeur réel avec un transport simulé, au lieu de remplacer tout le raccordement par un catalogue déjà préparé.

### Synthèse déclarée complète mais impossible à restituer

Une liste de désaccords ou d'incertitudes contenant une chaîne vide passait la validation interne puis était refusée par le contrat public. Le validateur de synthèse exige désormais une chaîne non vide après `trim()`. Le résultat incompatible devient une opération échouée lisible et récupérable. Les usages observés restent enregistrés et aucune nouvelle inférence automatique n'est ajoutée. Les tableaux vides et le texte non vide restent valides.

## Preuves locales

| Périmètre | Avant correction | Après correction |
| --- | --- | --- |
| Chat | 3 échecs initiaux ; 3 échecs complémentaires pour les exceptions d'accès définitives | 29 tests React PASS, dont 18 nouveaux |
| Catalogue | 2 échecs sur la composition réelle | 60 tests PASS dans quatre suites |
| Synthèse | 6 échecs et 2 témoins valides dans les nouveaux cas | 102 tests PASS dans deux suites |
| Statique | — | Types site et KARTA, lint ciblé, compilation KARTA et diff check PASS |
| Navigateur | — | 24 cas collectés ; exécution locale bloquée avant assertion par le binaire Chromium absent ; exécution effective à vérifier dans la CI |

Les nouveaux cas sont inclus dans les totaux. Les répétitions locales et CI ne sont pas additionnées pour gonfler le nombre de tests. Les commandes, répertoires, codes de sortie, limites des fixtures et empreintes sont conservés dans `validation.json` et les manifestes associés. La revue indépendante du chat est dans `chat-independent-review.json`. Les fichiers `.log` lisibles ont leurs espaces de fin de ligne normalisés ; le contenu UTF-8 original exact et son empreinte restent dans `raw-terminal-output.json`. La transformation est détaillée dans `terminal-output-normalization.json`. Les empreintes de logs des manifestes individuels se rapportent aux originaux.

Les analyses d'impact ont précédé les éditions : LOW pour le chat et le validateur de conclusion ; HIGH pour le chemin catalogue alimentant l'hôte, le serveur et la consultation. Ce risque a été annoncé avant modification. L'index GitNexus est exact sur la base examinée ; sa recherche plein texte est indisponible et ses graphes sont des bornes inférieures, complétées par lecture du code.

La détection des changements de ce lot est LOW. La comparaison historique avec `main` est CRITICAL (2 310 fichiers, 21 307 symboles, 541 processus) ; elle inclut toute la consolidation antérieure. Ce résultat ne constitue pas une autorisation de promotion vers `main` ou la production. Le risque HIGH du chemin catalogue reste pris en compte malgré le résumé LOW du diff.

Les contrôles de la PR constituent la preuve de CI et identifient le SHA exécuté. Ce dossier consigne les preuves locales enregistrées avant sa publication ; il ne prétend pas anticiper un résultat CI.

## Limites opérationnelles

La reprise du chat est locale au widget monté. Le rechargement ou crash complet, la perte de confirmation de création initiale d'une conversation et une file durable de sauvegarde de l'assistant ne sont pas ajoutés par ce lot. Une réponse reçue dont la sauvegarde reste indéterminée reste signalée à l'utilisateur. Une inférence explicitement relancée peut être facturée.

Les frontières fournisseurs et base de données utilisent des fixtures ; aucun compte fournisseur réel ni base de production n'est qualifié ici. Le transport HTTP local des tests de consultation est réel, mais ses dépendances externes sont simulées. Les anciens résultats de consultation déjà mal formés ne sont pas migrés.

La branche de correction est exclue du déploiement automatique dans `vercel.json`. Une fusion dans la consolidation ne constitue pas un déploiement en production ni une garantie d'absence universelle de bugs ou de latence.
