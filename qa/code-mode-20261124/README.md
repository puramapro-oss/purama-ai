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

## Suite corrective — paramètres d'outils et fichiers PDF

Périmètre `PRET_A_CODER`, au titre de la demande de continuation du 24 novembre : corriger les défauts reproductibles dans l'architecture IAO existante, sans second moteur, changement de modèle, suppression de données ou nouvelle infrastructure. Le parent coordonne les sources produit ; deux revues séparées couvrent les paramètres et le transport PDF.

Le raccordement à `04ff79cf8c5d1061e04cf631efac21601978433e` reprend l'admission par arrêt global de la PR 110. Le seul conflit est l'ajout simultané de branches dans `vercel.json` ; les deux interdictions de déploiement sont conservées.

Critères de réception de ce complément :

1. Les arguments et règles hérités ne satisfont pas un schéma d'outil ; les clés explicitement déclarées, objets sans prototype et valeurs optionnelles admises restent compatibles.
2. Une décision dont la seconde action est invalide n'exécute ni ne met en approbation la première ; les diagnostics publics ne recopient pas les valeurs privées.
3. Un nom PDF ne permet ni traversée de dossier, ni changement de bucket, ni divergence entre la destination d'upload et le lien rendu. La validation précède le rendu et le transport.
4. Le parcours PDF valide produit un document lisible avec le SDK installé ; une erreur de stockage reste une erreur et aucune donnée privée n'est reprise dans le diagnostic de nom.
5. Analyses d'impact avant édition, régressions rouges puis vertes, typecheck/build, revue indépendante, détection des changements et CI sur la tête finale.

L'index ciblé de quatorze fichiers inclut tous les appelants directs du validateur et les entrées principales ; il ne couvre pas tout l'écosystème. Son analyse classe `validateToolParams` CRITICAL (cinq appelants directs, six processus) ; ce risque a été signalé avant édition. Les accès dynamiques à l'outil PDF restent UNKNOWN dans le graphe et sont complétés par la recherche des registres et agents consommateurs. Les paramètres d'indexation et empreintes seront conservés avec les reçus de ce complément.

La nouvelle sonde Desktop Commander a aussi échoué par absence de réponse du Mac ; les deux connexions MacDevBridge retournent une erreur interne. Aucun contrôle de volume, bucket actif, sauvegarde ou serveur de production n'est déclaré réussi sur cette base. Le caractère public ou privé du bucket PDF n'est pas modifié par ce correctif de chemin.

### Réception locale du complément

- Validateur : 32 échecs reproduits parmi 76 cas avant correction ; les mêmes 76 passent après correction, sans modifier les attentes.
- PDF : 34 échecs reproduits parmi 39 cas avant correction ; les mêmes 39 passent après correction. Le PDFKit, le lecteur PDF et le SDK Supabase sont réels, le transport HTTP est simulé.
- Matrice de dix-huit fichiers : 351 assertions réussissent dans seize fichiers. Deux workers SQL (`approvalContinuation` et `approvalParentGuard`) sont interrompus par SIGKILL, laissant 90 assertions non exécutées et un code de sortie 1. Le champ `success: true` du reporter JSON ne qualifie pas cette commande comme réussie.
- Le build de production passe. Le typecheck complet local est interrompu (137) ; le lint local ne démarre pas faute de dépendances racine. Les gates équivalentes doivent réussir dans la CI finale avant intégration.
- Revue indépendante des cinq fichiers du complément : aucun blocage identifié, empreintes identiques à la sortie de revue. Elle ne remplace ni le typecheck complet, ni les contrôles en production.
- Détection staged : huit symboles attendus dans trois fichiers runtime, neuf flux, risque HIGH. Deux symboles de `server.ts` proviennent de la consolidation PR110 ; les autres concernent ce correctif. Comparaison avec `main` : CRITICAL, incluant la consolidation antérieure et limitée au graphe déclaré.

Les commandes, sorties et empreintes sont conservées dans `boundary-evidence.zip` ; `boundary-verification.json` en donne le manifeste et les limites. Les comptages sont non additifs. Le résultat de CI sur le commit final sera consigné dans la description de la PR, sans produire un nouveau commit uniquement pour actualiser le compte rendu.

Les noms de fichiers contenant un chemin, `%`, `?`, `#`, des contrôles ou des blancs périphériques sont désormais refusés explicitement avant rendu/envoi. Les noms usuels français, le propriétaire serveur, le bucket, l'absence d'écrasement et le contrat de retour `{ url }` sont conservés. L'objet de paramètres est capturé avant l'attente du rendu, empêchant une mutation du nom entre validation et upload. La publicité du bucket et les URL précédentes ne sont pas modifiées ; leur qualification active reste nécessaire.


## Continuation du 24 novembre — lectures programmatiques natives

État de conception : `PRET_A_CODER`, fondé sur la demande explicite de cette conversation d'intégrer Code Mode à IAO puis de terminer le fonctionnement, et sur la trajectoire documentée ci-dessus. Base de travail : consolidation `9ab7e16`, PR109 fusionnée. Identité IAO/KARTA, catalogue, permissions, mémoire et moteur conservés.

Périmètre attribué : le parent tient les types/capacités, la validation stricte locale, les reçus multi-réponses, leur migration et les preuves ; un agent intervient uniquement sur le transport Anthropic et ses tests ; un autre sur l'exécuteur KARTA partagé et ses tests. L'inventaire Mac/Hostinger reste séparé, en lecture seule.

Critères de réception définis avant les contrôles :

1. Activation explicite, route Anthropic native et modèle exact qualifié ; mode direct, mock, local et catalogues mixtes inchangés. Les modèles et budgets de sortie/réflexion existants ne sont pas remplacés. La continuation a une limite supplémentaire explicite de huit réponses, seize lectures, 64 Kio par résultat et 256 Kio de résultats au total, sous le délai global existant.
2. Catalogue non vide entièrement composé de lecteurs qualifiés (`knowledge_search`, `web_search` initialement) ; aucune mutation exposée à PTC. `sensitive:false` ne suffit pas à autoriser un outil.
3. Un exécuteur KARTA partagé, avec utilisateur serveur, droits frais, arrêt global, autonomie, armement du brief et journal. Refus en simulation, après révocation ou si une approbation devient nécessaire. Aucun rappel fournisseur après arrêt constaté.
4. Historique/conteneur/identifiants suivis ; validation du paquet avant exécution, doublons et fins incomplètes refusés, résultats textuels complets, aucune exécution de code dans Node. Réponses tardives et erreurs ne deviennent pas des succès.
5. Chaque réponse reçue conserve ses compteurs, y compris en échec. Migration additive au reçu v1 historique ; aucune réinterprétation d'un reçu unique en somme de plusieurs appels, aucune modification des politiques d'accès.
6. Tests du protocole avec le SDK réel et transport HTTP simulé ; tests de l'exécuteur, des droits, des arrêts, des branches historiques et de la migration SQL. Typecheck/build et CI avant fusion. Une qualification auprès du fournisseur reste distincte de ces tests.

L'index GitNexus de ce lot couvre 28 fichiers du cœur et leurs entrées principales. `normalizeModelCatalog` est CRITICAL (6 appelants directs, 8 processus), `loadAnthropicModelCatalog` HIGH (1 appelant direct, 4 processus), `createRealClaudeClient` LOW (2 appelants directs, 2 processus), `runAgentCycle` LOW dans ce graphe (worker direct). Les risques élevés ont été signalés avant édition ; l'index est ciblé et ne constitue pas un audit de tout PURAMA.

### Reprise du 25 novembre — livraison privée complète

L'environnement a été indisponible avant publication du lot. À sa reprise, les empreintes des cinq fichiers moteur/transport et tests correspondants sont identiques à celles enregistrées avant l'interruption. La branche reçoit ensuite par fast-forward la consolidation `795d7db` (PR112–115) ; aucun fichier du cœur de ce lot ne recoupe ce delta. L'exclusion Vercel propre à ce lot est réappliquée en conservant toutes les exclusions précédentes.

La revue a identifié une perte de livrable : la minimisation des traces effaçait la synthèse PTC du résultat du cycle sans la conserver dans le magasin privé. La conception est complétée avant implémentation :

- Le parcours PTC est admis uniquement pour un agent personnalisé, un propriétaire et un run avec UUID valides, dans le catalogue fermé des lecteurs publics qualifiés. Les autres parcours gardent leur mode direct.
- La synthèse intégrale est enregistrée sous `programmatic_report` dans la table/RPC existante `karta_tool_results`, avant la clôture du cycle ; ce nom n'est pas ajouté au catalogue d'outils du modèle ni à `tools_enabled`.
- Le texte n'est pas tronqué. Sa taille maximale est de 60 000 unités UTF-16, sous le budget JSON existant avec réserve avant les 64 Kio SQL. Un dépassement ou une livraison non confirmée interdit le succès du cycle.
- La provenance du rapport est fabriquée par le serveur : contenu généré par modèle, non vérifié indépendamment, données non fiables, lectures effectivement réussies. Une conclusion sans lecture garde `read_tools:[]` ; elle ne crée aucune preuve de recherche.
- La migration 034 est additive. Les formats des deux résultats historiques, les contrôles de propriétaire, les verrous, RLS, droits, rapprochements identiques et protections après suppression sont préservés.
- L'interface privée affiche le texte intégral échappé. Le contexte de chat conserve sa projection bornée et son indicateur explicite d'abrègement, avec une branche de provenance propre au rapport ; il ne l'assimile pas à une simulation quantique.

Le sous-graphe de livraison couvre 35 fichiers. `projectPrivateToolResult` et `persistPrivateToolResult` sont CRITICAL (sept dépendants et cinq flux), risque signalé avant édition. Le parseur, l'interface et le formateur Edge sont LOW dans ce graphe. Les fonctions SQL restent hors index et exigent une revue et des tests dédiés.

La réception doit inclure la chaîne réelle moteur → SDK → outil web → projection/persistance privée → parseur utilisateur, avec seulement les ports externes simulés. Elle doit aussi couvrir une réponse sans lecture, une sauvegarde refusée, un accusé de sauvegarde perdu, une révocation et un second appel invalide. Les tests locaux ne prouvent pas l'exécution du véritable sandbox fournisseur.

### Réception locale du lot programmatique — 25 novembre

Les preuves de cette réception sont conservées dans `programmatic-reads-20261125/`. Les heures internes sont en UTC ; la date de cette section utilise Europe/Paris. Elles décrivent l'état avant CI et ne remplacent pas la réception du commit publié.

| Contrôle | Résultat observé | Portée |
|---|---|---|
| Protocole, moteur, intégration, qualification, entrées et reçus | PASS — 231/231 | Six fichiers, SDK réel, ports HTTP/stockage simulés ; aucune inférence réelle |
| Reçus SQL 033 | PASS — 26/26 | PGlite, compatibilité v1 et enveloppe v2 bornée |
| Résultats privés SQL 034 | PASS — 84/84 | PGlite, limites Unicode/JSON, identité, permissions et réconciliation |
| Clôture des briefs SQL 035 | PASS — 18/18 | PGlite, synthèse sans lecture et conservation des transitions historiques |
| Projection et persistance privées KARTA | PASS — 77/77 | Formats historiques et rapport intégral |
| Contexte et autorisation Edge | PASS — 52/52 | Sources réelles, résolution des dépendances TypeScript/Zod déjà installées |
| TypeScript KARTA complet et build | PASS | Production, scripts et tests pour le typage ; compilation de production séparée |
| Revue indépendante des contrats partagés | PASS dans son périmètre | Reproductions négatives et empreintes dans `independent-shared-review.json` |
| Interface et PostgreSQL natif | NON TESTÉ localement | Contrôles déjà présents dans les workflows du dépôt, attendus avant fusion |
| Sandbox fournisseur, coût et latence réels | NON TESTÉ | Aucun appel d'inférence dans cette réception |
| Production et charge | NON TESTÉ | Aucune activation ni migration de production |

Les comptes par ligne ne doivent pas être additionnés aux matrices historiques, qui recouvrent certaines de ces assertions. Les rapports individuels précisent les noms et résultats des tests.

Trois défauts trouvés pendant la réception ont été corrigés : le `CASE` de la limite SQL est parenthésé pour éviter une erreur PL/pgSQL 42601 ; la synthèse privée réussie sans lecture termine maintenant le brief via 035 ; les qualifications positives des modèles/outils et l'instantané de reçus refusent les propriétés héritées, tableaux creux et accesseurs. Une erreur de typage du résultat SQL dans un test a également été corrigée avant le passage du TypeScript complet. La correction 035 conserve le déclencheur et les droits existants ; un résultat déjà enregistré ne redevient pas une tâche automatiquement rejouable.

L'index final porte sur 43 chemins : 1 313 nœuds, 3 134 relations et 81 flux. Il est explicitement partiel : 51 points d'entrée classés n'ont pas été explorés, 482 appels ont été écartés par les bornes de branchement et six parcours ont atteint leur budget. `useProgrammaticReads` et `runProgrammaticReads` sont désormais présents, avec un appelant direct dans `createRealClaudeClient.decide` et un risque LOW dans ce sous-graphe. Les analyses CRITICAL précédentes et la revue SQL dédiée restent pertinentes. L'absence d'un flux dans cet index ne prouve pas son absence dans l'application.

La lecture native de l'API Models a reçu HTTP 200 et une page complète de 15 modèles. Les sélections MAIN/FAST ne figurent pas dans la source canonique inspectée : leurs capacités, l'inférence, les crédits et le sandbox restent à qualifier séparément. Le reçu expurgé conserve l'échec antérieur de lecture et l'issue inconnue d'une tentative expirée. Le constat Hostinger montre une persistance locale historique, un ancien backend arrêté et une prévisualisation sans backend qualifié ; une réponse HTTP 200 d'une interface n'est pas une preuve de fonctionnement de bout en bout. Aucun ancien worker n'a été relancé.


## Réconciliation du 25 novembre 2026 avec le conseil et les essais IAO

Le candidat réunit la consolidation `d25f2e72` et PR116 `450cf098` dans l’arbre `88f2832d13d5078512ed08860da26b1dbffaa98b`. La fusion locale est automatique, sans résolution manuelle : les cinq fichiers communs du conseil sont identiques à la consolidation, les 64 fichiers propres au lot programmatique sont conservés, et aucun blob de la fusion ne diffère des deux parents. Le signal GitHub `mergeable=false` observé avant publication ne constitue pas la preuve d’un conflit textuel effectivement rencontré.

La revue indépendante confirme que le conseil n’envoie aucun outil ni pont programmatique, et que l’arrêt, la révocation ou une livraison privée non confirmée empêchent le succès PTC. Le mode reste désactivé par défaut ; aucun service, fournisseur ni migration de production n’est activé par cette réconciliation.

Réception locale du nouvel arbre : **872 tests interface PASS**, TypeScript et build interface/KARTA PASS ; **5 675 tests KARTA PASS sur 5 710**, avec **35 échecs de mise en place des sockets Unix (`listen EPERM`) dans trois fichiers**. La commande globale KARTA reste en échec local ; ces 35 cas ne sont ni ignorés ni déclarés réussis. Les essais Chromium locaux sont bloqués par l’absence du binaire et le téléchargement officiel refusé HTTP403. PostgreSQL natif et navigateur restent attendus dans les workflows existants avant fusion de la PR.

GitNexus a indexé l’assemblage et exécuté les analyses staged et compare-main. Le raccordement du moteur partagé porte un risque **CRITICAL**, examiné par comparaison des versions et tests. Les limites d’extraction des flux et de recherche sont consignées ; aucune exhaustivité du graphe n’est revendiquée. Le reçu courant et les commandes sont dans `reconciliation-20261125/receipt.json`.
