# IAO : preuves de fiabilité et protocole d'évaluation

Document commencé le 19 septembre 2026, complété le 10 novembre 2026. Les relevés historiques restent attachés à leur date et à leur version. Le dernier lot ci-dessous passe 679 tests moteur ainsi que les contrôles TypeScript et les compilations du moteur et du site ; sa validation navigateur reste bloquée avant l'ouverture d'une page. Ce document distingue le travail exécuté, la conception à valider et les comparaisons non réalisées. Il ne certifie pas toutes les applications PURAMA et ne constitue pas un classement mondial d'IAO.

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

## Consolidation KARTA du 10 novembre 2026

**PASS pour le lot isolé : 612 tests sur 52 fichiers, contrôle TypeScript et compilation. PARTIEL pour l'intégration dans PURAMA ONE.** Ce relevé remplace le compte de régressions KARTA pour cette version précise ; les campagnes historiques ci-dessus ne sont pas additionnées à ce résultat.

La base est la PR #14 au commit `d003159bdf3216b155f747b0f8fa93b3a92e5b3a`. Ses 729 fichiers ont été vérifiés par empreinte avant modification ; sa suite initiale passait 505 tests. Le lot reprend les contrôles d'autorité custom de la PR #7 et la confidentialité/finalisation du commit `7658be81e937b33a0b5aa3dab6d7939857a8aca8` de la PR #13, adaptés aux contrats actuels. Les réservations et finalisations SQL de #14 restent le mécanisme commun. Les connecteurs et catalogues indépendants de ces branches ne font pas partie de ce lot.

| Contrôle | Résultat exécuté |
| --- | --- |
| Propriétaire, activation, retrait d'un outil pendant le raisonnement ou entre deux effets | Les 30 premiers scénarios produisaient 22 échecs avant correction ; 30/30 passent après correction. Les contrôles positifs exécutent des outils inertes avec `mock: false`. |
| Autorisation et confidentialité custom élargies | 38/38 : refus terminaux distincts d'une lecture temporairement indisponible ; descripteurs copiés sans modifier le registre ; paramètres métier préservés ; traces minimisées, y compris sans outil. |
| Erreurs initiales du cycle et du claim d'approbation | 1/10 passait avant correction, 10/10 après : aucune sentinelle privée dans les exceptions, résultats ou logs du worker examinés ; aucun effet après refus d'admission. |
| Confidentialité et clôture reprises de #13 | 59 tests supplémentaires sur quatre fichiers : protection des traces et conservation du premier résultat confirmé. Le test lié à Jev est adapté à un outil inerte désactivé, sans revendiquer une validation de Jev. |
| Régression complète | **612/612**, zéro échec et zéro test ignoré ; `npm run typecheck` et `npm run build` terminent avec le code 0. |

Le reçu [aether-consolidation-20261110.json](karta/test/evidence/aether-consolidation-20261110.json) conserve les versions, les commandes, les résultats avant/après, les empreintes des 16 fichiers produit/tests et les limites de vérification. Le test d'autorisation conserve le nom `customAuthorization.test.ts` déjà utilisé dans #7 afin d'éviter deux suites parallèles lors du rapprochement des branches.

GitNexus a examiné les symboles existants avant modification. Les risques HIGH du résolveur/builder et CRITICAL des types partagés ont été signalés. La comparaison locale finale utilise explicitement `baseline-pr14`, dont l'arbre correspond à #14 ; elle ne se présente pas comme une comparaison avec la branche distante `main`. Les limites de dispatch, les parcours plafonnés et les faux rapprochements par nom du graphe ne remplacent pas les tests.

Les fournisseurs et le transport des files sont simulés. Les contrôles PGlite exécutent les contrats SQL dans le banc local, sans qualifier une instance PostgreSQL native à plusieurs connexions, ses rôles/RLS, Redis ni une migration déployée. La révocation est revérifiée avant l'effet ; elle n'est pas atomique avec une opération ultérieure chez un fournisseur. Les paramètres métier nécessaires à une approbation restent conservés dans son chemin autorisé ; la minimisation ne certifie pas les journaux internes des connecteurs.

Le déploiement et les parcours réels de PURAMA ONE restent **NON TESTÉS**. Le dépôt GitHub `purama-one` était vide lors de ce contrôle ; le checkout local, les verrous et les propriétaires actuels des terminaux restent inaccessibles. L'intégrateur doit réconcilier ce lot avec les autres branches avant toute fusion, puis qualifier les migrations et les parcours authentifiés sur la cible réelle. Aucun appel à un modèle ou fournisseur métier payant n'a été effectué pour cette campagne.

## Exécution durable, reprise vérifiée et états honnêtes — 10 novembre 2026

**PASS pour les vérifications locales décrites ; PARTIEL pour la livraison intégrée dans ONE.** Ce second lot prolonge le commit distant `1daf6314d60f6dd336c3a3601ddf73cf432ef4b3` sur la même branche isolée. Il réutilise la file KARTA, son journal, ses approbations et ses écrans. Un sérialiseur JSON commun sert à l'identité des demandes et aux comparaisons de reprise ; une classification de statuts commune sert à l'onboarding et à l'historique.

### Demande durable et refus des conflits

L'ancienne clé SQL incluait l'horodatage du job. Une réémission après purge du transport pouvait donc être considérée comme une nouvelle exécution malgré une clé métier identique. Les nouvelles demandes possèdent une identité délimitée par utilisateur, agent et clé métier hachée. Une véritable nouvelle demande sans clé de déduplication reçoit une identité distincte.

Le contenu est copié avant toute attente, puis lié à une empreinte canonique. Le worker recalcule cette empreinte. Le producteur vérifie le job réellement conservé par BullMQ, puis le journal avant et après l'ajout. La contrainte SQL unique sur `execution_key` et la comparaison de `execution_fingerprint` constituent la protection atomique finale ; les précontrôles seuls ne constituent pas une réservation.

Un conflit connu de contenu renvoie HTTP 409. Les routes de déclenchement renvoient une `executionKey` calculée côté serveur pour suivre la bonne demande. Le statut HTTP 202 reste une admission asynchrone et ne prouve pas que l'action métier a réussi.

| Cas contrôlé | Résultat vérifié |
| --- | --- |
| Même demande réémise après purge du transport | Un seul effet inerte et un seul journal. |
| Même clé réutilisée avec un contenu différent | Refus ; l'ancien résultat n'est pas attribué au nouveau contenu. |
| Deux workers franchissent leurs précontrôles avec des contenus différents | La réservation SQL permet un seul effet ; l'autre empreinte est refusée. PGlite sérialise ses appels : ceci ne qualifie pas une concurrence réseau multiconnexion. |
| Nouvelle mission, autre utilisateur ou autre agent | Identité distincte et exécution légitime conservée. |
| Métadonnées de livraison incohérentes ou journal illisible | Aucun effet autorisé sur cette preuve insuffisante. |
| Ancien job dédupliqué encore inexécuté | Raccordement à la nouvelle identité stable. Un ancien journal sans empreinte vérifiable impose une vérification du résultat précédent. |

Cette protection couvre une identité de demande conservée. Elle ne déduplique pas toutes les opérations sémantiquement équivalentes entre missions distinctes et ne remplace pas les garanties propres des fournisseurs. Les journaux durables ne doivent pas être effacés en supposant que la même protection reste acquise. Le verrou à durée fixe de la PR #7 n'est pas importé ; ce lot ne revendique pas de sérialisation globale des missions d'un utilisateur et d'un agent.

### Approbation avant effet, puis reprise vérifiée

La migration `019_karta_approval_parent_guard.sql` est réutilisée à l'identique depuis la [PR #20](https://github.com/puramapro-oss/purama-ai/pull/20), head `d553ff2e784a82685d16f59727c55d5499d0db9e`. Elle vérifie le propriétaire, l'agent, le parent clos et le lien unique avec son journal **avant** de permettre un effet approuvé. Un parent simulé ou mock ne peut devenir une autorisation réelle. Les arrêts et l'activation restent contrôlés ; un refus reste possible lorsque le lien de journal est valide. Le test associé de 48 cas est repris sans modification, et les quinze tests historiques d'approbation sont adaptés au nouveau contrat.

La boucle marque aussi l'insertion d'une approbation comme une écriture à résultat potentiellement incertain avant d'attendre sa réponse. Si l'insertion a pu être validée mais que son accusé de réception se perd, l'appelant ne reçoit pas une permission de rejouer automatiquement. Deux nouveaux scénarios, avec clôture du journal réussie ou également incertaine, échouaient avant cette barrière et passent après.

La reprise charge ensuite l'action résolue et son parent, avec les filtres d'utilisateur et d'agent. Elle exige une résolution finalisée, un parent réel et terminé, et une unique entrée de journal cohérente. Les identifiants du déclencheur ne font pas autorité sur les paramètres ni sur le résultat : ces informations proviennent des données détenues par l'utilisateur.

Le modèle reçoit la preuve métier nécessaire et les métadonnées des étapes précédentes. Une comparaison canonique séparée de son contexte mutable interdit de réexécuter exactement l'action déjà approuvée ou refusée, ou de créer une seconde demande d'approbation pour elle. Les paramètres privés et le texte du modèle sont minimisés dans les traces de cette reprise, y compris sans appel d'outil.

La portée est bornée. Une première reprise est admise lorsque l'action résolue est la seule action antérieure déjà traitée et que les autres entrées sont strictement différées. Une autre action déjà exécutée, un échec à effet incertain, une autre approbation ou une reprise d'une reprise sans ascendance durable suspend le traitement **avant de reconstruire le contexte, d'appeler le modèle et d'effectuer de nouvelles actions**. Le reçu précédent reste conservé. Le message explique qu'il faut vérifier l'activité avant une nouvelle mission ; il ne nie pas une action déjà exécutée.

Le premier banc de 29 scénarios présentait 28 échecs. Sept scénarios de prudence sur l'historique, puis les deux scénarios d'insertion incertaine, ont été ajoutés : **38/38 passent** dans le fichier final. Les essais comprennent propriété, agent, résolution falsifiée, preuve manquante, état non finalisé, paramètres réordonnés, contexte modifié, nouvelle demande légitime et confidentialité. Ces comptes successifs ne s'additionnent pas.

### Interface et contrat de données

L'onboarding suit la clé renvoyée par le serveur, avec vérification de l'utilisateur et de l'agent. Il continue à consulter les états `running` et `executing`, distingue la validation humaine et les résultats finaux, et limite l'attente à vingt secondes. Une ancienne réponse sans clé, un statut inconnu, une erreur de lecture ou un délai dépassé restent non confirmés. La fermeture ou la réouverture invalident les réponses tardives d'une tentative précédente.

L'historique distingue succès, erreur, annulation, simulation, résultat partiel, tâche ignorée et résultat inconnu. Les anciennes lignes `success` en mode simulation restent présentées comme des simulations. Les types Supabase reflètent les deux colonnes nullable des migrations 006 et 020. Le texte de première utilisation décrit une simulation, sans promesse de délai ni sécurité absolue.

Ces comportements sont implémentés, compilés et accompagnés de quatorze scénarios de contrôle. **Un test de classification pure a été exécuté ; les treize parcours nécessitant une page navigateur ne sont pas validés.** Chromium n'était pas disponible et ses archives téléchargées étaient invalides. Le dernier essai Firefox a échoué dans `browserContext.newPage`, avant le corps du scénario et avant l'application. Un essai avec le runtime correspondant au navigateur avait également été interrompu pendant la saturation mémoire. Ces constats ne démontrent pas un défaut applicatif et ne valent pas validation visuelle.

### Rapprochement avec les travaux parallèles

Les migrations des vingt heads de PR ouverts ont été inventoriées à des révisions précises, consignées dans le reçu. La PR #20 occupe 018 pour les consignes et 019 pour le garde-fou d'approbation. Notre nouvelle migration est donc renommée **020**, numéro libre dans ces vingt inventaires. Ce constat ne couvre pas les modifications locales invisibles ni les publications ultérieures.

La migration 019 et ses 48 tests sont importés avec leurs blobs d'origine, respectivement `fdb00f1d1842192715979727379245406efd76f8` et `703474853ce627464341af85d2b89acf03ee84d1`. Elle dépend des colonnes déjà présentes avec 006 et n'exige pas 018. Les migrations **019 et 020 sont exécutées ensemble** par les tests de livraison et de continuation dans PGlite. Aucun mécanisme d'approbation parallèle n'est ajouté.

Le cycle de consignes de #20 n'est pas fusionné dans ce lot. Le [patch de rapprochement](karta/test/evidence/aether-pr20-brief-integration.patch) est une **proposition NON APPLIQUÉE et NON TESTÉE au runtime**. Son application est vérifiée dans une copie temporaire, de la base SHA-256 `493182e2b5188d3230415b0bbd172bcca102858ece8333e8ed72f2bb34183a1d` à la cible `ba160cb5080ffdee16867c5ce021afa39fce92da999c559f40b2f0b21aca9c7a`. Ce diff à contexte zéro exige `git apply --check --unidiff-zero` puis, au moment du rapprochement autorisé, `git apply --unidiff-zero`. Il nécessite aussi les types, fonctions et migration 018 de #20 ; il ne doit pas être appliqué seul.

La proposition suspend une reprise d'approbation pour un agent à `pendingBriefKey` avant d'acquérir une consigne. #20 peut conserver la consigne partielle en `reconciliation_required` ; prendre une nouvelle consigne pour continuer l'ancienne serait incohérent. La poursuite automatique de ces agents demande encore une transition SQL reliant la consigne originale, son reçu, l'approbation et le nouveau run. Cette capacité n'est pas déclarée réalisée.

### Vérification finale du lot

| Vérification | Résultat |
| --- | --- |
| Suite moteur complète | **729/729**, 56 fichiers, aucun échec ni test ignoré, sortie 0. Les 117 cas supplémentaires depuis la base comprennent 69 nouveaux cas de ce lot et 48 repris de #20 ; le nombre de cas de la base était 612. Les fixtures et un cas historique d'approbation sont adaptés à 019. |
| Tests ciblés combinés | **132/132** : 48 garde-fou du parent, 15 approbations existantes adaptées, 38 reprises/insertion incertaine, 27 livraisons/migrations, 4 HTTP locaux. Ils sont déjà inclus dans les 729. |
| TypeScript moteur et site | **PASS**, sorties 0. Le moteur est revérifié après les imports tardifs ; le site est inchangé depuis sa vérification réussie. |
| Compilation KARTA et construction Vite | **PASS**, sorties 0. |
| ESLint sur les quatre composants/helpers/hooks concernés | **PASS**, zéro erreur, zéro avertissement. |
| Migration 020 rejouable, formats, clé obligatoire avec empreinte, anciennes valeurs nulles | **PASS** dans PGlite ; aucune migration appliquée à des données réelles. |
| 019 + 020 et contrat d'approbation | **PASS** dans les tests locaux combinés ; aucune qualification PostgreSQL native multiconnexion. |
| Réindexation et contrôles de changement | **PASS de cohérence** sur les 23 sources/tests et deux documents provisoires ; 750 fichiers suivis inchangés pendant l’analyse et douze fichiers d’instructions identiques. |
| Validation navigateur et parcours connectés dans ONE | **NON TESTÉ** ; blocage du navigateur avant la page et absence d'accès confirmé au runtime ONE. |

La suite complète finale a duré **56,11 secondes** dans ce banc (56,64 secondes pour le processus complet). Cette durée ne mesure pas la performance du produit. Les premières tentatives interrompues par SIGKILL ou pendant la saturation mémoire ne sont pas requalifiées en succès ; la campagne finale et ses empreintes sont distinctes. Aucun délai de test n'a été augmenté pour masquer ces interruptions. Le test de reprise isole aussi l'import du transport afin d'éviter une connexion Redis locale involontaire pendant son chargement.

Le reçu [aether-execution-status-20261110.json](karta/test/evidence/aether-execution-status-20261110.json) conserve les résultats, commandes, empreintes des **23 fichiers source/tests**, incidents de vérification, reprises de code et limites. L'arbre de ces sources avant documentation est `52db384d5db9d599199709742a27402d0014e235`.

GitNexus signale automatiquement un risque **CRITICAL** : ses trois vues comptent les mêmes 351 symboles et 88 processus sur le snapshot source23 et ses deux documents provisoires. Soixante-quinze processus mentionnent un symbole `query`, sensible aux homonymes des tests. Les limites de génération et les fichiers sans symbole sont consignés ; ces chiffres ne sont pas une preuve de 88 parcours métier validés. La comparaison utile porte sur le contenu exact de `1daf6314…`. L’appel contre `main` a été retenté et échoue parce que cette référence n’existe pas dans la copie isolée ; aucune référence de substitution n’a été inventée. La réindexation a contrôlé l’absence de modification des sources et des douze fichiers d’instructions. Le contrôle de publication porte ensuite sur le staging définitif ; son résultat et le commit publié sont consignés dans la note de continuité.

### Réception et mise en service restantes

1. L'intégrateur ONE rapproche le lot des autres branches et du checkout réel, dont le cycle de consignes de #20, puis valide les treize parcours UI avec un navigateur opérationnel et un backend d'essai identifié.
2. L'exploitation qualifie les migrations et les permissions sur une copie de données, ainsi que la concurrence PostgreSQL native et le transport Redis.
3. Avant mise en service : arrêter et drainer les anciens workers ; qualifier et appliquer 019 puis 020 une seule fois (019 peut déjà être présente à l'identique via #20) ; démarrer les nouveaux workers/producteurs ; vérifier les contrats API et l'interface. Ne pas faire cohabiter les anciennes et nouvelles versions de workers.
4. En retour arrière, ne pas remettre des jobs v2 à un ancien worker. Conserver les reçus et réconcilier l'état de la file avant reprise.
5. Les propriétaires des connecteurs vérifient les effets et les autorisations sur leurs comptes de test. La prévention des conflits entre missions différentes, l'ascendance durable de plusieurs approbations et les mesures de charge/latence restent des lots identifiés.

Aucun déploiement, aucune migration réelle ni fusion dans `main` ne découle de ces tests locaux. Les interfaces Mac interrogées pendant cette passe renvoient une erreur interne ; le constat ne nie pas les accès à d'autres périmètres consignés dans la note de continuité. Le périmètre confirmé reste ce correctif de `purama-ai`.

## Consignes, délégations et budgets intégrés — 10 novembre 2026

**PASS sur le périmètre local documenté ; PARTIEL pour l’intégration réelle dans PURAMA ONE.** Cette campagne prolonge le commit `27815bcc9660adcc925f1a6c2b8651ff04ff5062` sur la même branche d’audit. Ses résultats actualisent les limites de la section précédente : les parcours navigateur sont maintenant exécutés, les consignes durables sont intégrées et le rapprochement des budgets est vérifié. Les anciennes campagnes restent des preuves datées et leurs nombres de tests ne s’additionnent pas.

### Une seule architecture, des contributions rapprochées explicitement

Le lot utilise les composants KARTA, CHEF, le journal et les approbations existants. Il rapproche les contributions suivantes à des heads précis, sans fusionner leurs branches entières :

| Contribution | Révision examinée | Traitement |
| --- | --- | --- |
| PR #19 : décisions Claude complètes | `73be455cb94ea18159f8390ad1091d277e2f50f0` | Runtime exact ; test adapté seulement pour isoler le transport de queue. |
| PR #20 : consignes durables | `d553ff2e784a82685d16f59727c55d5499d0db9e` | Migration 018 et fonctions de consigne réutilisées ; boucle rapprochée avec nos protections existantes. |
| PR #21 : origine et réservations CHEF | `b826af125ce296d3808d3b71b93fd084e63dbdb7` | Origine minimale extraite ; budget intégré ; numéros SQL réconciliés. Le chargeur de reprise alternatif n’est pas importé. |
| PR #18 : annulation CHEF | `8063016b84b3513af1e52efea79d58dbbaff5682` | Contrôles avant lancement et après attentes conservés, y compris après la dernière preuve. |
| PR #24 : dépendances et contrôle CI | `9b066c5b10f6896041aec9359ee21b173c0f5014` | Quatre blobs exacts : manifestes npm, contrôle de compatibilité et workflow existant. |

L’arbre des **43 fichiers source, configuration et tests**, avant ajout de cette documentation et du reçu, est `f4a837e034dbb052dac5aa6175aa01e1dd9919dc`. Le reçu [aether-runtime-integration-20261110.json](karta/test/evidence/aether-runtime-integration-20261110.json) conserve les empreintes, commandes, contrôles avant/après et limites. Aucun tarif, quota commercial, niveau de qualité selon l’offre ou choix d’hébergement n’est modifié.

### Décider complètement avant de rendre une action exécutable

Le client Claude examine le motif de fin, les types de blocs, les identifiants d’outils et tous les paramètres avant de rendre une décision au moteur. Une réponse tronquée, refusée, incohérente ou contenant un appel non conforme ne peut plus produire un premier effet suivi d’une erreur sur un second appel. Le validateur des outils déjà présent est réutilisé ; une validation de format n’accorde aucune permission d’exécution.

Le banc repris de #19 avait **29 échecs et 5 réussites avant correction** ; les **34 cas passent après correction**. Ils figurent aussi dans la campagne complète décrite plus bas et ne constituent pas 34 tests supplémentaires à additionner.

### Une demande conservée, un reçu pour chaque tentative

Six agents à consigne utilisent désormais une acquisition exclusive liée au run. La simulation lit la consigne sans la réserver ni la supprimer. En mode réel, l’armement SQL précède tout effet ou création d’approbation ; les arrêts et l’autonomie sont revérifiés après cette attente. La perte d’un accusé de réception ne permet pas de rejouer librement une opération possiblement validée.

Une erreur avant armement, un résultat mock ou une consigne sans action proposée conserve une entrée récupérable lorsque les preuves de clôture le permettent. L’absence de consigne évite l’appel au modèle et se termine en `skipped`. Les reprises d’une consigne sont bornées à **trois tentatives** ; un effet possible ou une situation ambiguë impose une réconciliation. Un résultat vide n’est pas présenté comme une mission accomplie.

`loadApprovalContinuation` reste l’unique admission de reprise. La comparaison de l’action déjà résolue reste indépendante du contexte mutable du modèle. Pour un agent à `pendingBriefKey`, une reprise d’approbation suspend le cycle avant de consommer une autre consigne : le transfert durable de l’ascendance de l’ancienne consigne vers cette reprise reste à réaliser. Les parents comportant d’autres effets incertains et les reprises de reprises demeurent refusés.

**Le patch historique `aether-pr20-brief-integration.patch` de la section précédente ne doit plus être appliqué à cette version.** Il reste conservé comme proposition datée du lot précédent ; son rapprochement a maintenant été réalisé explicitement dans les sources et vérifié avec leurs dépendances.

### Déléguer avec une origine cohérente

Une copie bornée de l’origine est créée avant le contexte métier et le modèle, puis recopiée pour chaque effet. Les approbations conservent cette origine. Le destinataire reçoit le motif de délégation utile, tandis que les champs métier ne peuvent pas se présenter comme des faits serveur de reprise.

La délégation interdit l’auto-délégation, une lignée cyclique et une profondeur supérieure à trois. Une origine historique absente n’est pas convertie en nouvelle chaîne. Les traces des délégations sont minimisées ; les paramètres nécessaires à l’exécution restent dans leur chemin autorisé. Ces contrôles ne constituent pas une certification de chiffrement de bout en bout ni un audit des journaux internes de tous les fournisseurs.

### Budget réservé, coût inconnu explicite, annulation conservée

Les réservations CHEF sont liées à la mission, à la tâche, au worker, à la tentative et au jeton de génération. Le cas « deux tâches estimées à 60 sous un budget de 100 » admettait auparavant les deux tâches ; la deuxième reste maintenant en attente tant que la première occupe l’enveloppe nécessaire.

Un coût non fourni reste `null`. Pour une dimension plafonnée, l’absence de réconciliation conserve la réservation et empêche de déclarer le travail validé. Un reçu tardif peut régler sa propre tentative sans valider une autre génération. Les métriques déjà finalisées ne sont pas réécrites ni comptabilisées une seconde fois dans les totaux de la mission et de la tâche. Un zéro avant lancement du driver reste une observation certaine, distincte d’une consommation inconnue après exécution.

Un signal déjà annulé empêche le lancement du processus direct. Des contrôles après les attentes empêchent aussi une réponse tardive du driver, du vérificateur ou de la dernière preuve de rétablir un succès après perte d’autorité. Les trois défauts principaux ont été reproduits avant correction ; les **92 cas ciblés CHEF passent ensuite**, déjà inclus dans la campagne complète.

Les réservations contrôlent l’admission selon des estimations : elles ne garantissent pas un plafond absolu de facture fournisseur. Une consommation inconnue peut suspendre l’admission jusqu’à réconciliation fiable. Le rattrapage historique vise les générations actives `claimed/running/verifying` ; un mélange ambigu de coûts historiques provoque un refus transactionnel de la migration. Les tests d’annulation ne prouvent pas l’arrêt de tous les descendants possibles d’un processus.

### Migrations cohérentes dans un même schéma

| Numéro final | Fonction | Provenance |
| --- | --- | --- |
| 018 | Acquisition, aperçu, armement et clôture des consignes | PR #20, contenu exact. |
| 019 | Garde du parent avant effet approuvé | Inchangée depuis le lot précédent. |
| 020 | Empreinte durable de la demande | Inchangée depuis le lot précédent. |
| 021 | Origine conservée dans une approbation | SQL d’origine #21 renommé, contenu exact. |
| 022 | Réservations et réconciliation des budgets CHEF | SQL #21 ; seuls deux diagnostics internes sont renommés de 018 en 022. |

Le test `briefDatabaseCycle` applique la vraie migration d’origine de `creator_agents`, puis **001 à 022 dans l’ordre**, et exerce le cycle réel de consigne, le journal et les déclencheurs SQL. Ses **8 cas passent**. Les tests de consigne et d’origine vérifient aussi les réapplications prévues. Il s’agit d’une base PGlite locale vierge avec authentification minimale ; cette preuve ne qualifie ni toutes les autres migrations Supabase ni une mise à niveau de données de production.

### Dépendances et parcours du site

Les surcharges npm corrigent la compatibilité d’OpenTimestamps et de sa chaîne HTTP sans modifier les dépendances directes déclarées. L’installation depuis le lock exact est rejouée hors réseau dans un répertoire isolé puis dans le checkout. Le contrôle de compatibilité passe de **1/5 à 5/5**. Il vérifie notamment le chargement, les preuves en mémoire, les hôtes de calendrier et les contrats HTTP simulés ; aucun ancrage réel ni service payant n’est testé. Les fonctions Deno qui épinglent leurs propres paquets ne sont pas qualifiées par ce lock racine.

La campagne qualité finale du site passe **31/31**, dont **26 parcours navigateur et 5 contrôles purs**, avec Playwright 1.59.1 et Chromium 147.0.7727.0. Le site et ses vrais composants/hooks s’exécutent localement, avec réponses Supabase interceptées. Les parcours couvrent navigation, erreurs et données nulles, redirections de paiement simulées, suivi du bon run, états actifs et finaux, réponses tardives, demandes étrangères et limite d’attente.

Deux défauts du banc ont été corrigés : la surveillance Vite épuisait le quota partagé de fichiers ; `watch: null` est désormais affecté après `mergeConfig`, qui ignore autrement cette valeur. La configuration résolue est contrôlée. Le scénario des états intermédiaires garde maintenant chaque statut serveur jusqu’à son observation, au lieu de le faire disparaître au nombre de requêtes. Toutes les assertions et limites sont conservées ; aucun retry ni skip n’est ajouté.

### Résultats et portée des preuves

| Contrôle | Résultat de cette campagne |
| --- | --- |
| Ensemble KARTA | **1019/1019**, 71 fichiers uniques, zéro échec final ni test ignoré ; couverture vérifiée par les noms exacts et les hashes. |
| Organisation KARTA | 50 fichiers sans PGlite dans un processus, puis 21 fichiers SQL chacun dans un processus distinct. Les 13 groupes déjà confirmés sont conservés ; les 9 groupes incomplets ou en échec sont repris séparément sur les mêmes sources. Les résultats antérieurs ne sont pas additionnés. |
| TypeScript KARTA et compilation | **PASS**, sorties 0, sources inchangées pendant la campagne. |
| TypeScript site et construction Vite | **PASS**, sorties 0. |
| Contrats Supabase générés contre le catalogue SQL versionné | **PASS**, sortie 0. |
| Compatibilité des dépendances | **5/5 PASS**, sortie 0. |
| Qualité du site | **31/31 PASS**, zéro flaky, skip ou échec final, sortie 0. |
| Schéma combiné 001–022 et cycle de consigne | **8/8 PASS** dans la suite KARTA. |
| Contrôle des changements | `git diff --check` PASS ; empreintes des sources conservées dans le reçu. |

La première tentative KARTA unifiée est arrêtée à sa deadline globale de 240 secondes sans rapport final et reste **NON CONCLUANTE**. Une première campagne SQL ciblée avait aussi été interrompue pendant une forte pression mémoire. La première partition échoue sur un cas d’isolation de conversation par timeout de cinq secondes, puis l’épuisement de l’espace disque empêche l’écriture de son rapport global. Les résultats incomplets restent conservés ; la reprise garde les mêmes assertions et délais. La version exacte du runner exécuté et les rapports acceptés sont identifiés dans le reçu. Aucune de ces durées ne mesure la latence du produit.

Les impacts GitNexus ont été recherchés avant les modifications. Les types partagés ont un impact classé CRITICAL déjà signalé ; les appels indirects et les cibles SQL non résolues sont traités comme limites du graphe. Un miroir isolé contient le même arbre source43, les mêmes 772 fichiers suivis et les douze instructions inchangées. L’extraction globale des parcours reste PARTIELLE : 753 candidats d’entrée et 1 370 appels sont omis, avec douze parcours coupés par leur budget. Les réponses de changement non tronquées ne rendent pas ce graphe exhaustif ; ses liens par homonymie et ses symboles de test ne prouvent pas un appel produit réel. Le verrou d’un autre analyseur n’a pas été supprimé. Le contrôle final du staging et la publication sont consignés dans la note de continuité ; `main` n’est pas inventée dans ce checkout isolé.

### Conditions restantes pour une mise en service dans ONE

Le runtime ONE, son checkout actuel et les parcours authentifiés avec ses vrais services restent **BLOQUÉS / NON TESTÉS dans cette session**. Les deux interfaces Mac interrogées renvoient une erreur interne sur le chemin connu ; cela ne nie pas les accès rapportés dans d’autres conversations.

Avant mise en service, l’intégrateur doit identifier la version réellement utilisée par ONE et réconcilier les autres branches. L’exploitation doit qualifier les migrations, permissions, données historiques et scénarios concurrents sur PostgreSQL natif et Redis. Les anciens workers doivent être drainés avant le changement de contrat. L’historique réel des numéros et des checksums doit être contrôlé, notamment si des migrations de #21 ont déjà été appliquées sous leurs anciens numéros. Les reçus restent conservés lors d’un retour arrière.

Les effets des connecteurs réels, l’ascendance de plusieurs approbations, les reprises de briefs partiels, les mesures de charge/latence et les autres capacités AETHER restent à qualifier dans leur périmètre propre. Aucun déploiement, aucune migration réelle, fusion dans `main` ou activation de fournisseur ne découle de cette campagne.
