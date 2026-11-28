# Admission IAO sous arrêt global — 24 novembre 2026

Base : `18c40d0eb59b48636dd8d8fb54c0516b700ed746`. Branche isolée : `feat/iao-runtime-composition-20261124`. Publication limitée à la consolidation `audit/reliability-oauth-20261110` après réception de la tête publiée. Aucun déploiement ni changement de `main`.

Les journaux `.log` cités ci-dessous sont conservés octet pour octet dans `raw-logs.zip`, aux mêmes chemins relatifs ; `raw-logs-manifest.json` permet de vérifier chaque empreinte. Leur conditionnement préserve aussi les erreurs initiales et les espaces des sorties originales. Le diff de fixtures est conservé sans perte dans `admission/fixture-alignment-diff.json`.

## Défaut reproduit et correction

Le listener HTTP utilisait seulement `RuntimeReadiness.ready` pour admettre une demande IAO. Or la sonde réelle peut légitimement renvoyer des dépendances prêtes et `globalKillSwitch: true`. Les deux alias acceptaient donc une demande malgré un arrêt actif, à la première sonde comme à la dernière.

La garde propre à IAO exige maintenant `ready === true` et `globalKillSwitch === false`. Elle utilise les deux sondes déjà présentes ; elle ne crée aucun appel supplémentaire. La garde administrative demeure distincte, ce qui permet toujours de lever l'arrêt lorsque les dépendances sont disponibles. Suivi, annulation, santé, double authentification et budget monotone de 15 secondes sont conservés.

Le contrôle couvre les conversations et les commandes mémoire. Il ne rend pas atomique un arrêt survenant après la dernière sonde, ne révoque pas un travail déjà admis et n'active aucun port de production. Voir la révision 6 du contrat IAO.

## Réception locale

| Contrôle | Résultat | Preuve |
|---|---|---|
| Reproduction qualifiée avant correction | 4 PASS / 4 FAIL ; quatre réponses 202 attendues 503 | `admission/qualified-red.json` et `qualified-red-display.log` |
| Mêmes huit tests, empreinte inchangée, après correction | 8/8 PASS | `admission/original-eight-green-receipt.json` |
| Suite complétée | 15/15 PASS, aucun test ignoré | `admission/expanded-green-receipt.json` |
| Régression runtime, identité, échéances, reçus et rétention | 333/333 PASS dans 14 fichiers | `runtime-regression.log` et `.json` |
| Typage complet, produit et tests | PASS avec tas Node plafonné à 768 Mio | `typecheck.json` |
| Compilation produit | PASS | `build.json` et `.log` |
| Revue indépendante | PASS, aucune anomalie concrète | `independent-review.json` |
| Alignement de fixtures HTTP | 8 + 2 objets uniquement ; assertions et délais identiques | `admission/fixture-alignment-review.json` |

Les huit tests originaux sont inclus dans les quinze finaux ; leurs répétitions ne s'ajoutent pas comme de nouveaux cas. Le listener, le routage et la façade sont réels, mais `Server.listen` est neutralisé pour cette réception locale. Configuration, DB, queue et persistance du stop sont simulées. Aucun fournisseur, modèle ou service payant n'est appelé. Les deux fichiers de tests HTTP alignés doivent être exécutés par la CI disposant du réseau local.

## Incidents conservés sans requalification

- `admission/initial-red*` : préparation incomplète, zéro test exécuté. Ce n'est pas la reproduction produit.
- `admission/listener-red*` : harnais incomplet, huit tests exécutés, deux réussis et six échoués ; remplacé pour le diagnostic par le harnais qualifié, sans effacer la preuve.
- `typecheck-uncapped-final.*` : processus interrompu, code 137.
- `typecheck-512mb.*` : tas insuffisant, erreur mémoire. Le même typage réussit ensuite avec 768 Mio sans modification de source.
- Deux indexations GitNexus de portée plus large ont été interrompues par le système. Le troisième index, limité à sept fichiers d'admission/cycle de vie, réussit : 291 nœuds, 725 relations, 26 flux.

## Portée de l'analyse d'impact

Les impacts de `handleRequest`, `startApiServer` et `handleIaoRoute` sont conservés. L'index est partiel, sans FTS et avec des flux tronqués. Le résultat LOW sur un appelant résolu ne suffit pas à établir la portée totale ; l'absence d'arêtes sur le démarrage reste UNKNOWN. La lecture directe confirme l'appel par le listener et les routes affectées. Ce chemin d'admission est traité comme CRITICAL, annoncé avant modification. Les helpers de tests absents du graphe ont également fait l'objet d'une analyse manuelle.

Les analyses `detect_changes` indexée et en comparaison avec `origin/main` ont été exécutées : le correctif touche `handleRequest` et sept flux résolus, risque HIGH ; la comparaison historique porte sur 2 899 fichiers et les 26 flux partiellement indexés, risque CRITICAL. Cette comparaison avec `main` inclut les travaux de consolidation déjà existants et ne décrit pas uniquement ce petit correctif. La portée est relue avant publication. La réception CI finale et son arbre exact sont consignés dans la PR et dans la page de continuité existante.

## Raccordements encore distincts

Cette correction ne remplace ni l'autorité de session IAO, ni les garanties de mémoire durable, ni le producteur Fabric compatible RPC/2. L'examen en lecture seule des sources canoniques et des branches historiques sert à réutiliser leurs travaux ; leurs résultats et identités restent dans la continuité privée du projet. Aucun paquet privé n'est copié dans ce dépôt public, et aucun résultat simulé n'est présenté comme une réception fournisseur.
