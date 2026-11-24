# IAO — exposition des outils et trajectoire Code Mode

Date : 24 novembre 2026. **Statut global : PARTIEL.**

Ce lot réalise une correction préalable du catalogue et documente l'intégration Code Mode. Il n'implémente ni une boucle PTC, ni une sandbox distante, ni un nouveau transport fournisseur. Aucun gain de facture ou de qualité générative en production n'est revendiqué.

## Base et coordination

- Dépôt : `puramapro-oss/purama-ai`.
- Base de consolidation : `audit/reliability-oauth-20261110`, commit `e81129a56e07535129827c95211d82815df8dc5a`.
- Branche isolée : `feat/iao-tool-context-efficiency-20261124`.
- `main` n'est pas la base de développement actuelle ; elle présente déjà 2 748 fichiers différents du commit de consolidation avant ce lot.
- La PR de continuité mémoire existante n'a pas été réimplémentée. Les checkouts et agents du Mac ont été préservés. Le registre de coordination a été complété et une copie temporaire isolée a servi à la vérification finale.

## Correction réalisée

`resolveCustomAgentTools` résout chaque nom connu une fois, dans l'ordre initial, et conserve les objets du registre. Cela évite que le constructeur d'agent copie plusieurs définitions d'une même capacité.

Au transport Messages, des occurrences du **même objet** sont exposées une fois. Deux objets différents de même nom sont refusés, même s'ils ont un JSON similaire : leurs exécuteurs et permissions peuvent différer. Le refus précède tout accès réseau, y compris le GET de découverte de LM Studio.

Le modèle est sélectionné selon l'entrée initiale avant cette projection. Le contexte, la politique, le budget de sortie, les schémas stricts, les préférences manuelles et le raisonnement approfondi restent conservés dans les cas testés. Les deux actions distinctes retournées par le modèle pour un même outil restent deux actions ; seule la définition répétée est dédupliquée.

Le complément de recherche est intégré au document existant `docs/api-cost-research-20261112.md`, dont le texte antérieur est conservé intégralement. Il couvre l'hébergement hybride, les trois approches fournisseurs, les incompatibilités réelles, les recettes, la découverte progressive, les références de résultats, les autorisations, les coûts complets et les critères de qualification.

## Vérifications

| Vérification | Statut | Preuve / portée |
|---|---|---|
| Régression avant correction | PASS pour la démonstration du défaut | 15 nouveaux tests échouent et les 17 anciens passent, code produit encore inchangé |
| Deux suites ciblées après correction | PASS | 32 tests réussis, vrai SDK avec réseau intercepté |
| Matrice élargie | PARTIEL | 346 tests réussis dans 13 fichiers ; ces 346 incluent les 32 ciblés |
| Suite SQL locale `approval.test.ts` | BLOQUÉ localement | Worker interrompu par SIGKILL ; les 16 assertions ont ensuite réussi en CI |
| KARTA complet en CI sur la première proposition | PASS | 4 704 tests / 206 fichiers, dont les 16 assertions SQL ; reçu `ci-initial-karta.json` |
| TypeScript complet | PASS | `npm run typecheck`, heap 768 MiB et semi-space 8 MiB ; les tentatives 512/1024 avaient respectivement épuisé le heap et été interrompues |
| Build KARTA | PASS | `npm run build`, aucune dépendance produit ajoutée |
| Revue indépendante | PASS dans le périmètre décrit | `/root/iao_repo_inventory`, empreintes dans `independent-review.json` |
| Génération réelle, coût facturé, hébergement actif | NON TESTÉ | Aucun appel fournisseur réel, aucune nouvelle infrastructure activée |
| Déploiement / vente du mode complet | NON TESTÉ | Ce lot ne constitue pas une réception de production |

Les contrôles ne prouvent pas une qualité générative universellement identique. Ils établissent les invariants du contrat observés. Le scénario de trois références répétées en transmet une seule tout en conservant le modèle principal ; il ne constitue pas une estimation d'économie globale en tokens.

## Analyse d'impact

GitNexus 1.6.12 a finalement indexé le runtime KARTA au vrai Git root : 4 226 nœuds, 10 277 relations, 310 flux extraits. Les sources de production et scripts KARTA sont inclus. Les tests et le reste du dépôt sont hors graphe ; la recherche textuelle des consommateurs et les tests exécutés complètent cette portée. La rétention des corps et FTS sont désactivées pour cette analyse, sans supprimer les relations structurelles.

Les analyses `impact` ont été exécutées avant l'édition du moteur. `resolveCustomAgentTools`, `toAnthropicTools`, `createRealClaudeClient` et `send` portent un risque **HIGH**, signalé à l'utilisateur. `decide` porte **UNKNOWN** : un receveur d'appel n'est pas résolu. Les appels du cycle et de la consultation ont donc été examinés dans les sources. Les limites d'extraction des flux sont conservées dans le log ; aucun appel absent du graphe n'est déclaré inutilisé.

La comparaison avec `main` porte un risque **CRITICAL** et englobe l'importante consolidation antérieure. Elle ne doit pas être présentée comme une analyse limitée à ces cinq fichiers. L'analyse staged a réussi : 7 symboles du runtime, tous dans les deux fichiers produit attendus, 7 flux et risque HIGH. Les propriétés `model`/`response` apparaissent dans la correspondance des lignes du callback ; leur comportement reste couvert par les assertions. Le diff Git complet reste la preuve des fichiers livrés.

Les tentatives d'indexation interrompues sont récapitulées dans `index-attempts.json`. Elles n'ont pas servi de preuve verte. Le reçu réussi contient les empreintes des sources, la commande et les paramètres de ressources ; la cause exacte des SIGKILL antérieurs n'est pas affirmée. Le petit adaptateur d'analyse borne les connexions LadybugDB à un thread via leur API existante et peut tracer les requêtes, sans changer leurs arguments/résultats ni la logique du graphe. Il n'appartient pas au moteur produit. Le fichier temporaire de périmètre a été restauré après chaque tentative.

## Conditions de suite

1. Confirmer la CI sur la dernière tête du brouillon après le raccordement et la correction de style ; les 16 assertions SQL ont déjà réussi dans le job KARTA initial.
2. Revoir et intégrer le correctif dans la branche de consolidation ; ne pas assimiler une proposition à une fusion ou un déploiement.
3. Étendre le protocole existant pour les continuations, résultats intermédiaires, budgets, interruptions et reçus d'usage ; conserver les parcours directs autorisés.
4. Qualifier une route sandbox/fournisseur avec isolation, permissions par opération, approbation/reprise, absence de double effet et compte autorisé ; commencer par les lectures composées.
5. Mesurer coût total par tâche réussie, qualité, preuves complètes, latences médiane/p95 et échecs sur les usages PURAMA avant d'activer progressivement.

Le moteur reste une seule architecture IAO/KARTA/CHEF : ce lot n'ajoute pas de deuxième catalogue, routeur, ordonnanceur ou interface utilisateur.

## Raccordement à la continuité intégrée pendant ce travail

La branche de consolidation a avancé à `18c40d0eb59b48636dd8d8fb54c0516b700ed746` pendant la réception (fusion de la PR 108). Aucun des cinq fichiers de correction/recherche ne chevauche ce lot. Le brouillon reçoit cette évolution sans conflit ; les sources du correctif conservent les empreintes de la revue indépendante. La déduplication exacte de mémoire ajoutée par la PR 108 est réutilisée, sans seconde implémentation.

La branche de ce lot est aussi ajoutée à `git.deploymentEnabled: false` dans `vercel.json`, selon la protection déjà utilisée par les autres branches de qualification. Cette entrée ne modifie aucune autre règle de déploiement.

Le raccordement local valide 295 tests de six suites, puis le typecheck complet et le build. La CI initiale a aussi trouvé une erreur de style dans un appel chaîné de test ; le retour à la ligne a été corrigé, les 32 tests ciblés relancés avec succès, et le delta de format revu indépendamment. Les avertissements de style antérieurs hors périmètre ne sont pas modifiés.

## Réception finale du graphe après raccordement

La reconstruction locale de l'index a échoué à plusieurs reprises ; les résultats et les limites sont conservés dans `reconciliation-index-attempts.json`. Aucun de ces essais n'est une preuve verte. La vérification a donc utilisé GitNexus 1.6.12 déjà installé sur le Mac, dans une copie temporaire isolée du commit de consolidation, avec les six fichiers exacts du lot appliqués et staged. Aucune source des projets ouverts n'a été modifiée.

L'indexation de tout le runtime et des scripts KARTA a réussi. Les six fichiers du lot et tous les fichiers TypeScript du runtime ont des empreintes identiques à la proposition locale, sans changement pendant l'analyse (`reconciliation-mac-match.json`). Les tests et documents restent hors graphe. Le contrôle staged réussit : **5 symboles, tous dans les deux fichiers produit attendus, 6 flux, risque HIGH**. La comparaison `main` réussit aussi : **2 869 fichiers, 3 214 symboles, 309 flux, risque CRITICAL**, avec liste de symboles plafonnée ; elle inclut toute la consolidation antérieure. Ces résultats ne remplacent pas les limites d'extraction signalées par l'outil.

Les reçus Mac et les sorties exactes de l'analyse sont conservés à côté des contrôles initiaux. La CI de la nouvelle tête doit être reçue après publication ; son résultat final sera attaché à la description de la PR pour éviter de modifier à nouveau les sources seulement pour y enregistrer ce résultat.
