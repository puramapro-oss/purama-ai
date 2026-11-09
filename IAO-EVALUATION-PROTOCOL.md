# IAO : preuves de fiabilité et protocole d'évaluation

État au 19 septembre 2026. Ce document distingue le travail exécuté, la conception à valider et les comparaisons non réalisées. Il ne certifie pas toutes les applications PURAMA et ne constitue pas un classement mondial d'IAO.

## Ce qui rendrait IAO utile et distinctive

La proposition est une seule IAO intégrée à PURAMA, s'appuyant sur KARTA et SMARANA. Son avantage doit être démontré sur des résultats utiles : un projet livré et maintenu, une démarche réellement reçue, une activité suivie sans double facturation, du temps rendu à la personne. Une architecture d'application utilisant des modèles externes n'est pas, à elle seule, un nouveau modèle fondamental plus intelligent qu'eux.

| Axe à construire ou compléter | Preuve attendue avant de le déclarer opérationnel |
| --- | --- |
| Intégration de chaque application | Identité, permissions, abonnement, capacités et version de contrat recensés ; lecture et écriture testées avec le bon utilisateur et la bonne entité |
| Travail entre plusieurs applications | Un objectif commun, des identifiants stables, des étapes persistantes et une preuve de l'état final dans chaque application concernée |
| Autonomie et arrière-plan | Reprise après arrêt, budget borné, autorisations révocables, échéances, annulation et escalade lorsque l'IA ne peut pas conclure |
| Mémoire fiable | Source, date, propriétaire, consentement, correction et suppression ; conflits et informations périmées détectés ; aucune fuite entre personnes |
| Résultat vérifiable | Distinction préparé/transmis/reçu/accepté/payé ; aucune annonce de succès sans preuve correspondante |
| Sécurité | Autorisation contrôlée dans les services, secrets hors du modèle, outils restreints, journalisation, essais de révocation et de contenu hostile |
| Performance et coût | Temps au premier retour utile, durée totale p50/p95/p99, coût par tâche réussie, concurrence et taux de panne mesurés sur le parcours réel |
| Qualité humaine | Compréhension, accessibilité, respect du choix, transparence, autonomie de la personne et spiritualité libre ; évaluation par des utilisateurs réels |

Ces objectifs prolongent la conception fournie ; ils ne sont pas tous réalisés par les correctifs de cette branche. Les abonnements des clients des utilisateurs, les tarifs PURAMA et les budgets de l'association doivent garder leurs comptes, droits et preuves séparés. Aucun revenu n'est garanti.

## Résultats effectivement exécutés

La campagne utilise fast-check 4.10.2, Node 24.19.0 et des graines fixes. Chaque ligne ci-dessous représente une propriété exécutée sur 20 000 entrées générées, sans cas abandonné.

| Dépôt | Propriété | Cas | Échecs après correction |
| --- | --- | ---: | ---: |
| SMARANA | Requêtes valides, conservation des entrées | 20 000 | 0 |
| SMARANA | Refus des types publics invalides | 20 000 | 0 |
| SMARANA | Refus des rôles système/outils dans l'historique | 20 000 | 0 |
| SMARANA | Entiers, fractions, limites SQL | 20 000 | 0 |
| SMARANA | Base64 canonique et variantes malformées | 20 000 | 0 |
| SMARANA | Clés de cache : contexte, frontières et casse | 20 000 | 0 |
| PURAMA-AI | Restitution Unicode du flux vers le client | 20 000 | 0 |
| PURAMA-AI | Chaîne flux fournisseur simulé → convertisseur → client | 20 000 | 0 |
| PURAMA-AI | Refus des réponses sans confirmation de fin | 20 000 | 0 |
| PURAMA-AI | Propagation d'une erreur fournisseur | 20 000 | 0 |
| **Total** | **10 propriétés** | **200 000** | **0** |

Il s'agit de 200 000 essais d'entrées générées, pas de 200 000 propriétés distinctes, questions de raisonnement, scénarios métier ou entrées nécessairement uniques. Les tirages peuvent se répéter. Les reprises avec la même graine ne sont pas additionnées. Les requêtes fournisseur sont simulées ; aucun modèle ne produit les textes de cette campagne. Les durées de ces tests locaux ne mesurent pas la latence d'IAO en production.

Les premiers essais ont échoué sur trois classes de défauts : fins de ligne SSE mixtes, durée de cache hors int4, base64 invalide. Les reçus `generative-before-20260919.json` conservent les contre-exemples minimisés ; `generative-after-20260919.json` conserve les résultats corrigés avec les empreintes des fichiers testés. Ils sont dans `karta/test/evidence/` ici et `test/evidence/` dans SMARANA.

Les suites de régression passent : 121 tests KARTA et 48 tests SMARANA. Ces nombres incluent les dix propriétés exécutées avec leur volume par défaut ; ils ne s'ajoutent pas comme autant de nouveaux scénarios à la campagne étendue. Les contrôles TypeScript concernés, la compilation KARTA et la construction Vite passent. Les audits de dépendances KARTA/SMARANA signalent zéro vulnérabilité connue au moment du contrôle.

Reproduction depuis `karta/` ou depuis la racine de SMARANA, après installation des dépendances verrouillées :

```bash
IAO_PROPERTY_RUNS=20000 IAO_PROPERTY_SEED=20260919 IAO_PROPERTY_REPORT=/tmp/iao-properties.json npm test -- test/generative.test.ts
```

Utiliser un chemin de résultat distinct pour chaque dépôt. Les propriétés disposent de graines dérivées de la graine de base ; un échec rapporte aussi le chemin de réduction de fast-check. Le nombre par défaut est 200 par propriété pour garder les régressions ordinaires rapides. [Documentation fast-check](https://fast-check.dev/docs/core-blocks/properties/).

## Ce que montrent les références actuelles

Les annonces officielles publient notamment Terminal-Bench 4.0 à 57,9 % pour Astra et 55,8 % pour Fable 5.1 ; Humanity's Last Exam avec outils à 57,2 % et 65,0 %. Ces chiffres sont des résultats publiés avec leurs configurations respectives, pas une reproduction par PURAMA. Une victoire dans une ligne ne prouve pas une supériorité universelle. Les notes d'OpenAI signalent des différences de tâches et de notation OSWorld entre publications : ne pas fusionner leurs scores. [OpenAI](https://openai.com/index/gpt-6-astra/), [Anthropic](https://www.anthropic.com/claude-fable-and-mythos-5-1).

AutomationBench affiche Astra Max à 41,4 % et une combinaison Fable 5.1 avec recours à Opus 5 à 31,4 %. Ce second score inclut Opus sur environ 40 % des tâches ; son coût affiché exclut ces tokens. Son classement utilise un ensemble privé distinct du jeu public. Les tâches publiques permettent donc une nouvelle comparaison contrôlée, sans reproduire exactement le classement privé. [Classement Zapier](https://zapier.com/benchmarks), [dépôt officiel](https://github.com/zapier/AutomationBench).

La fiche Astra rapporte encore des attaques réussies dans une évaluation externe d'injection indirecte : 8,5 % avec quinze tentatives par scénario. Ce taux concerne ce protocole adversarial ; il ne décrit pas le taux d'incidents des utilisateurs. La fiche documente aussi des erreurs factuelles et précise qu'aucun échec observé sur un test ne garantit la fiabilité ailleurs. [Fiche de sécurité Astra](https://deploymentsafety.openai.com/gpt-6-astra).

## Comparaisons à préparer, encore non exécutées

| Évaluation | Ce qu'elle mesure | État réel ici |
| --- | --- | --- |
| [Terminal-Bench 4.0](https://www.tbench.ai/run) | Travail dans un terminal avec vérification des tâches | Référence vérifiée ; dataset/harness exact non installés, aucun score IAO |
| Terminal-Bench Science 0.1 | Tâches scientifiques ; version citée par les deux éditeurs | Référence dans les annonces ; protocole complet non reproduit |
| [AutomationBench](https://github.com/zapier/AutomationBench) | État final de plusieurs applications simulées | Jeu public identifié ; jeu officiel privé inaccessible ; aucune exécution |
| [OSWorld 2.0](https://osworld-v2.xlang.ai/) | Manipulation d'applications et travail long | Environnement bureau non disponible ; variante offline/notation à figer |
| [Humanity's Last Exam](https://lastexam.ai/) | Raisonnement multidisciplinaire | Version et outils à figer ; aucun appel modèle effectué |
| [AgentDojo](https://github.com/ethz-spylab/agentdojo) | Utilité et résistance aux injections dans des outils simulés | Piste publique complémentaire ; pas présentée comme les tests privés d'Astra/Fable |
| Parcours PURAMA réservés | Projets, mémoire, abonnement, association, administration | À relier à l'inventaire réel des applications et aux preuves de bout en bout |

Précontrôle de cet environnement : variables OPENAI_API_KEY et ANTHROPIC_API_KEY absentes ; exécutable Docker absent. Les tentatives antérieures de disponibilité du navigateur et de PostgreSQL natif ont des blocages déjà documentés. Aucun contournement, achat de crédits ou lancement de services payants n'a été effectué. Les tests internes privés des éditeurs ne sont pas disponibles dans cette session.

## Protocole commun proposé

1. Geler le commit IAO, les versions des modèles réellement accessibles, le jeu de tâches et son empreinte, le harness, les outils, prompts, limites de tours, délais et budgets. Les noms commerciaux seuls ne suffisent pas.
2. Séparer développement et évaluation réservée. Ne pas régler IAO sur les réponses du jeu réservé ; garder aussi des cas nouveaux après chaque version.
3. Comparer Fable avec outils, Astra avec les mêmes outils, IAO+Fable, IAO+Astra, puis IAO AUTO. Documenter les changements de modèle et leurs coûts ; ne pas déguiser une combinaison en modèle unique.
4. Respecter le protocole officiel pour toute revendication de reproduction. En parallèle, définir avant les essais une étude PURAMA appariée avec répétitions, même environnement réinitialisé et mêmes plafonds. Publier séparément les deux études.
5. Vérifier l'état final des systèmes et les contraintes qui doivent rester vraies. Une belle réponse textuelle ou le jugement de l'agent sur lui-même ne suffit pas. Calibrer les juges automatiques avec une revue humaine pour les critères qualitatifs.
6. Mesurer réussite complète au premier essai, stabilité entre répétitions, reprises, interventions humaines, incidents, coût par succès, délai initial et total p50/p95/p99. Rapporter la taille d'échantillon et l'incertitude ; distinguer échecs, timeouts, refus justifiés et tâches impossibles.
7. Conserver tâches échouées, traces expurgées, preuves d'effets, versions et reçus. Corriger la cause puis tester sur des cas réservés ; ne pas retirer silencieusement les cas difficiles pour atteindre 100 %.

Cette méthode reprend la séparation entre évaluations de capacités, régressions et validation des résultats décrite par [Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents). Elle reste un protocole à exécuter, pas une preuve de supériorité déjà obtenue.

## Conditions avant une généralisation

Priorité aux essais natifs des verrous et reprises, aux comptes sandbox fournisseurs, aux sessions authentifiées, aux droits entre entités et à la révocation en cours de travail. Ensuite : charge soutenue, pannes réseau, événements en double/désordre, cache périmé, changement d'abonnement, coût épuisé et contrôle de l'état après compensation. Valider les sauvegardes et la restauration, les migrations et le retour à une version précédente. Les essais de sécurité doivent aussi porter sur les services déployés, au-delà de l'audit des dépendances.

Les points ouverts de `IAO-SAFETY-REVIEW.md` demeurent : diagnostics TypeScript globaux du site, dépendances du site et du mobile, médias non récupérés, absence de tests navigateur réel et d'essais multisessions PostgreSQL natif. Il n'y a ici ni scan antivirus complet des appareils, ni garantie contre tout piratage, ni certification de toutes les applications. Les travaux non publiés des terminaux locaux Codex/GLM restent hors de visibilité de cette session.

La cible raisonnable est une fiabilité mesurée sur des usages définis, des erreurs détectées et récupérables, et une progression vérifiable. Aucune campagne finie ne permet d'affirmer « tous les besoins, zéro bug, zéro latence, aucune concurrence ».

## Complément du 9 novembre 2026 — Jev et sélection de moteurs

Ce complément conserve une seule IAO, KARTA/KRIYA pour les missions, SMARANA/AKASHA pour
la mémoire, VAJRA pour les droits, SATYA/PRAMANA pour les preuves et AGNI pour l'observation.
Les moteurs ci-dessous sont des candidats spécialisés à qualifier, pas un appel simultané
à tous les fournisseurs ni une preuve de supériorité mondiale.

### Ajout logiciel Jev

Le connecteur `karta/src/jev/` et la factory `createJevJudgmentTool` sont préparés dans cette
branche, sans activation automatique. Ils valident les contrats, bornent le transport,
permettent l'abstention et exigent des callbacks serveur d'autorisation, de réservation et
de réconciliation. Le [contrat d'intégration](karta/src/jev/README.md) précise les limites.

Les fournisseurs sont simulés dans les tests. Aucun résultat de ces tests n'est un score
de précision, de calibration, de vitesse ou de coût réel de Jev. Le signal d'annulation,
les quotas atomiques et les autorisations doivent être raccordés aux services canoniques
par l'hôte avant utilisation.

Validation de ce complément : **83 nouveaux tests Jev** (30 schéma, 19 transport,
34 outil), **588 tests KARTA réussis dans 49 fichiers**, compilation et contrôle
TypeScript KARTA réussis. [Preuve du lot](karta/test/evidence/jev-20261109.json).
Ces résultats s'ajoutent à l'historique daté plus haut ; ils ne réexécutent pas la
campagne étendue de 200 000 cas et ne certifient pas le site complet.

### Catalogue court à comparer

| Rôle proposé | Candidat identifié | Décision de qualification |
| --- | --- | --- |
| Jugements structurés | [Jev 1.14.0](https://docs.typesafe.ai/models) | Questions bornées, version épinglée, abstention et critères propres au cas d'usage |
| Code et travail général | [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) | Vérifier l'adaptateur Responses pour les outils et la qualité sur les missions PURAMA |
| Alternative et contre-expertise ciblée | [Claude Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/overview) | Réutiliser le fournisseur existant ; deuxième réponse seulement si son gain est mesuré |
| Opérations courantes bornées | [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) | Respecter le même seuil de qualité ; exclure les usages où le modèle économique échoue |
| Compréhension multimodale | [Gemini 3.8 Flash](https://aistudio.google.com/docs/models/gemini-3.8-flash) | Entrées audio/vidéo/image/PDF ; sortie texte, génération média évaluée séparément dans SUTRA |
| Alternatives API | [DeepSeek V4.1 Flash](https://api-docs.deepseek.com/quick_start/pricing/) ou [Mistral Small 4](https://docs.mistral.ai/models/mistral-small-4-0-26-03) | Comparer aux connecteurs déjà disponibles ; enregistrer versions, politique de données et coût complet |
| Recherche des preuves AKASHA | [Qwen3 Embedding et Reranker](https://qwenlm.github.io/blog/qwen3-embedding/) | Essai sur un échantillon, sans réindexation générale avant preuve du gain |
| Transcription | [Voxtral Mini Transcribe 3](https://docs.mistral.ai/models/voxtral-mini-transcribe-3-0) | Offre en aperçu ; ajouter seulement si une lacune du moteur vocal actuel est mesurée |
| Escalade pour tâches difficiles | [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), éventuellement [Claude Fable 5.2](https://platform.claude.com/docs/en/models/fable-5-2/overview) | Budget explicite, contrats et données admissibles, amélioration de réussite démontrée |

Ce tableau ne modifie aucun modèle de production, abonnement ou compte. Le moteur le
moins cher admissible est choisi seulement **après** les contraintes de qualité, de
droits, de données, d'outils et de délai. Un domaine non évalué reste non qualifié.

### Techniques à mesurer dans les composants existants

1. Recherche lexicale et vectorielle combinée, puis reclassement des passages ; vérifier
   droits, dates et références avant génération. [Principe de recherche hybride](https://learn.microsoft.com/en-us/azure/search/hybrid-search-overview).
2. Cache exact lié au contrat et aux permissions, préfixes stables, déduplication des
   opérations et réutilisation d'artefacts validés. Ne pas confondre une cache-hit logique
   avec une preuve de fraîcheur ou d'autorisation.
3. Effort de raisonnement ajusté à la tâche, outils chargés à la demande et transformations
   déterministes en code. Mesurer la réussite avant de réduire l'effort. [Effort](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost), [outils](https://www.anthropic.com/research/advanced-tool-use).
4. Parallélisme limité aux tâches indépendantes, échéance commune et interruption des
   travaux devenus inutiles. Comparer le coût par succès au total des appels, y compris
   reprises, vérifications et erreurs.
5. Traitement différé/batch des tâches non urgentes, budgets réservés puis rapprochés,
   limites de concurrence et absence de baisse silencieuse sous le seuil de qualité.
6. Spéculation, quantification et optimisation du cache KV seulement si PURAMA contrôle
   l'inférence. Cela n'ajoute pas une option magique aux API distantes ; confirmer
   exactitude, matériel et distribution du résultat. [vLLM](https://docs.vllm.ai/en/latest/features/speculative_decoding/).

Pour Jev, ajouter aux scénarios réservés : catégories incomplètes, ambiguïtés, français,
permutation des options, adversaires textuels, qualité selon niveau de confiance,
couverture après abstention, erreurs 402/429, réponse tardive et révocation pendant la
réconciliation. Une réponse structurée ou la concordance de deux modèles ne suffit pas
à établir la vérité. Les critères exécutables restent contrôlés par le code et les
critères qualitatifs par une procédure de revue calibrée.

Les indicateurs restent séparés : qualité, temps utile et total p50/p95, coût par mission
réussie, volume facturé et énergie. Les kWh d'une API distante sont **inconnus** sans
télémétrie fournisseur adéquate ; une baisse de tokens ne mesure pas à elle seule une
baisse d'énergie. Aucun pourcentage de gain de production n'a été calculé dans ce lot.
