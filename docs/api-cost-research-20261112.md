# PURAMA / IAO — réduire les coûts API sans abaisser la qualité

**Date de recherche : 12 novembre 2026 — Europe/Paris.**

**Statut : PASS pour les sources documentaires consultées ; PARTIEL pour l'inventaire des comptes ; NON TESTÉ pour les gains financiers et la qualité sur le trafic réel.** Ce document constitue une recherche et des propositions d'intégration. Il ne prouve ni déploiement, ni économie réalisée, ni activation de crédits.

## 1. Cadre conservé

Les optimisations doivent respecter l'architecture retenue **IAO → KARTA → OmniRoute**. Le raccordement complet de cette chaîne reste à qualifier : le client KARTA examiné utilise encore directement le SDK Anthropic. Elles ne créent pas une seconde passerelle. Le calcul local et les services Hostinger/Cloudflare existants restent les cibles à examiner ; aucun achat, abonnement, cloud Vercel ou remplacement de fournisseur métier n'est proposé comme action automatique.

Les offres **199 €/mois et 499 €/mois gardent les mêmes exigences de qualité**. Les différences de quota restent distinctes des capacités du modèle. Le quota mensuel est délivré au paiement/renouvellement, expire en fin de période et ne se cumule pas. Les économies d'infrastructure ne modifient pas ces règles commerciales.

« Zéro facture de tokens » peut désigner une réponse servie depuis un cache autorisé, une opération déterministe ou une inférence locale. Cela ne signifie pas gratuité totale : matériel, énergie, exploitation, stockage, transferts et maintenance restent à comptabiliser.

## 2. Priorités selon coût, qualité et risque

| Priorité | Proposition dans l'existant | Effet attendu sur le coût | Condition de qualité |
|---|---|---|---|
| P0 | Mesurer usage et facturation par utilisateur, tâche et fournisseur | Rend les dépenses attribuables ; aucun gain présumé | Mesures réconciliées avec les factures |
| P0 | Supprimer doublons, fusionner appels identiques simultanés | Évite des exécutions supplémentaires | Même périmètre d'autorisation et même demande |
| P0 | Stabiliser préfixes et utiliser le cache fournisseur | Réduit le prix de certaines entrées | Modèle et contenu nécessaires conservés |
| P1 | Réutiliser les résultats applicatifs stables et valides | Peut éviter l'appel entier | Expiration, versions, confidentialité respectées |
| P1 | Traiter les travaux différables en batch | Remise publiée, selon fournisseur | Délai compatible avec la fonctionnalité |
| P2 | Cibler le contexte, borner recherches et reprises | Réduit tokens et outils inutiles | Preuves utiles et informations essentielles préservées |
| P2 | Router vers un modèle local ou économique qualifié | Gain dépendant du taux d'escalade | Évaluations comparatives avant activation |

Un petit modèle suivi systématiquement d'un grand modèle peut coûter davantage qu'un seul appel adapté. La confiance autodéclarée d'un modèle ne constitue pas une validation. La sélection doit utiliser des résultats vérifiables et conserver une route experte pour les tâches qui l'exigent [S7].

## 3. Cache fournisseur : tarification et limites

Le cache de préfixe réutilise le traitement d'une entrée stable ; il ne remplace pas la génération de sortie. Placer les instructions et outils stables avant les données variables. Les horodatages, modifications d'historique et changements de paramètres peuvent empêcher la réutilisation.

| Fournisseur | Situation documentaire au 12/11/2026 | Précaution |
|---|---|---|
| OpenAI, GPT-5.6+ | Écriture à 1,25× pour 30 min ; 2,5× pour 12 h. Lecture généralement 0,1×, ou 0,05× pour GPT-6.1 Sol/Terra. Minimum 1 024 tokens visibles [S1]. | Les écritures ont un coût ; paramètres différents sur anciens modèles. |
| Claude | Écriture 1,25× pour 5 min, 2× pour 1 h ; lecture généralement 0,1×, avec exceptions. Minimum variable selon modèle [S2]. | Placer `cache_control` à la fin du préfixe stable. |
| Gemini | Cache implicite sur modèles 2.5+ ; minimum variable. Interactions/Gemini 4 ne prennent pas en charge le cache explicite [S3]. | Un préfixe commun ne garantit pas un cache touché. |
| xAI | Préfixe exact ; identifiant de conversation stable avec `prompt_cache_key` ou `x-grok-conv-id` [S4]. | Éviction possible ; vérifier les tokens effectivement réutilisés. |

Pour un préfixe utilisé `N` fois avec une seule écriture, multiplicateur d'écriture `w` et de lecture `r`, son coût relatif est `(w + (N−1)r) / N`. Il devient inférieur au coût sans cache lorsque `N > (w−r)/(1−r)`. Exemple purement calculé : avec `w=1,25` et `r=0,1`, deux utilisations suffisent. Les sorties, outils, stockages, expirations et nouvelles écritures restent à ajouter. Ce calcul n'est pas une mesure PURAMA.

Le cache applicatif doit distinguer organisation/utilisateur autorisé, modèle/version, paramètres, instructions, documents et versions de permissions. Les actions à effets réels, réponses périmées et données privées ne doivent pas être mutualisées arbitrairement. Un résultat en erreur ou tronqué n'est pas un succès réutilisable.

## 4. Traitements différés et maîtrise des boucles

Les documentations annoncent **50 % de réduction** pour les traitements batch concernés chez OpenAI, Claude et Gemini. Les fenêtres ou délais cibles vont jusqu'à 24 heures selon le service ; les demandes peuvent expirer. Gemini décrit actuellement ce mécanisme pour `generateContent`. Chez xAI, la remise publiée est **20 % pour les modèles listés** ; image et vidéo restent au tarif normal [S5].

Candidats : indexation, embeddings, traductions de catalogue, évaluations et synthèses programmées. Une conversation, une notification urgente ou une décision demandée immédiatement ne doit pas attendre ce traitement pour obtenir une remise.

KARTA doit également centraliser les limites d'étapes, tentatives et durée. Une seule couche pilote les reprises pour éviter leur multiplication entre SDK, routeur et tâche. Après une réponse ambiguë à une mutation, rechercher l'état existant avant de répéter l'action. Les résultats d'outils volumineux doivent être filtrés sans retirer les preuves utiles. Une compaction peut casser le cache : comparer le coût total avant/après, pas seulement le taux de cache.

## 5. Crédits inclus, abonnements et quotas

OpenAI documente désormais des crédits API pour abonnements éligibles : Pro 100/200/500 dollars donne respectivement 100/200/500 dollars mensuels. L'activation demande une liaison avec une organisation API possédée, la même adresse e-mail et un abonnement payant d'au moins sept jours. Premier versement proratisé, crédits expirants, limites API applicables ; Codex via clé API est exclu. **Le compte de Matiss et l'activation effective ne sont pas vérifiés.** Les crédits achetés peuvent prendre le relais après épuisement : ne pas activer de recharge automatique par cette recherche [S6].

Claude Pro indique une facturation API séparée. Les pages xAI sont discordantes : la FAQ comptes parle de facturation Grok/API distincte, alors que la FAQ Grok affiche API parmi les catégories du pool hebdomadaire. Vérifier les droits du compte avant toute conclusion [S8].

Les quotas Gemini sont par projet, pas par clé. Les conditions demandent des **Paid Services pour une application proposée aux utilisateurs de l'EEE, de Suisse ou du Royaume-Uni**. Le quota gratuit ne constitue donc pas une solution de production présumée pour PURAMA en France [S9].

## 6. Modèles locaux : qualification requise

MLX-LM et llama.cpp sont des moteurs candidats documentés ; whisper.cpp est une piste de transcription locale [S10]. Réutiliser d'abord les installations déjà présentes. **Un essai complémentaire a effectivement exécuté le client KARTA candidat avec Ollama sur le Mac, sans API cloud : Qwen3-Coder 30B réussit les deux cas synthétiques ; Devstral 24B réussit l'appel d'outil mais échoue au format texte exact.** Les données, versions, latences et limites figurent dans [les preuves d'exécution](../qa/api-cost-20261112/README.md). Aucun déploiement ni test de capacité multi-utilisateur n'en découle ; Hostinger reste non testé.

Pour chaque modèle/version/quantification : vérifier licence des poids, qualité en français, extraction, respect des formats, appels d'outils, contexte utile, mémoire maximale, latence et débit sous concurrence. Un modèle tenant en mémoire n'a pas nécessairement le débit requis. Comparer un même jeu représentatif au fournisseur actuel, inclure échecs et escalades, puis n'autoriser que les familles de tâches qualifiées. Aucune équivalence universelle avec les meilleurs modèles distants n'est acquise.

## 7. Familles d'API complémentaires

Toutes les lignes suivantes sont des **propositions ; fournisseurs actifs, contrats et capacités restent à confirmer**. Les catégories multimédias peuvent elles-mêmes utiliser de l'IA.

| Famille | Économie à examiner | Capacité à préserver |
|---|---|---|
| Voix | Détection de parole, transcription locale qualifiée, réutilisation audio autorisée | Langues, accessibilité, latence, droits des voix |
| Vidéo/image | Réutilisation des médias, montage/transcodage existants, rendu final après validation | Résolution finale, qualité et droits ; génération spécialisée conservée si nécessaire |
| Cartes | Cache conforme et données locales autorisées | Fraîcheur, attribution, navigation ; serveurs OSM publics non illimités [S11] |
| Recherche | Index propre, requêtes ciblées, cache avec durée adaptée | Couverture, citations et actualité |
| Paiements | Webhooks, rapprochement, idempotence et suppression du polling inutile | Prestataires, authentification, contrôles et traitement fiable [S12] |
| Notifications | Déduplication, regroupement pertinent, canaux disponibles | Livraison des alertes et sécurité de l'authentification |
| Signature | Réutilisation des dossiers, événements plutôt que consultations répétées | Identité, intégrité, preuves et niveau de signature requis |
| Infrastructure | Compression, cache, transferts incrémentaux, rétention adaptée | Sauvegardes, disponibilité, restauration et isolation |

## 8. Mesure et critères d'acceptation

Calculer `coût = tokens ordinaires × tarif + lectures cache × tarif + écritures cache × tarif + sorties × tarif`, divisé par un million si les tarifs l'exigent, puis ajouter outils, médias, stockage, transferts et infrastructure. Les catégories de tokens doivent être disjointes ; ne pas compter deux fois cache ou raisonnement déjà inclus dans les totaux du fournisseur.

Comparer coût par tâche réussie, qualité, latence médiane/p95, taux de reprise, cache réellement touché, escalades et erreurs. Tester l'isolation entre utilisateurs, l'invalidation, la concurrence, les expirations et les reprises ambiguës. Les réductions ne s'additionnent pas mécaniquement. L'équipe IAO porte l'intégration et les preuves ; le propriétaire habilité des comptes vérifie crédits et contrats. **Aucun pourcentage d'économie réelle n'est annoncé avant ces mesures.**

## Sources officielles consultées

- [S1 — OpenAI : prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [S2 — Claude : prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [S3 — Gemini : caching](https://ai.google.dev/gemini-api/docs/caching)
- [S4 — xAI : prompt caching](https://docs.x.ai/developers/advanced-api-usage/prompt-caching)
- S5 — Batch : [OpenAI](https://developers.openai.com/api/docs/guides/batch), [Claude](https://platform.claude.com/docs/en/build-with-claude/batch-processing), [Gemini](https://ai.google.dev/gemini-api/docs/batch-api), [tarifs xAI](https://docs.x.ai/developers/pricing)
- [S6 — OpenAI : crédits pour abonnés ChatGPT](https://developers.openai.com/api/docs/guides/chatgpt-api-credits)
- [S7 — OpenAI : sélection des modèles](https://developers.openai.com/api/docs/guides/model-selection)
- S8 — Abonnements : [Claude Pro](https://support.claude.com/en/articles/8325606-what-is-the-pro-plan), [comptes API xAI](https://docs.x.ai/developers/faq/accounts), [FAQ Grok](https://docs.x.ai/grok/faq)
- S9 — Gemini : [limites](https://ai.google.dev/gemini-api/docs/rate-limits), [conditions](https://ai.google.dev/gemini-api/terms)
- S10 — Dépôts officiels : [MLX-LM](https://github.com/ml-explore/mlx-lm), [llama.cpp](https://github.com/ggml-org/llama.cpp), [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
- [S11 — OpenStreetMap : politique des tuiles publiques](https://operations.osmfoundation.org/policies/tiles/)
- [S12 — Stripe : requêtes idempotentes](https://docs.stripe.com/api/idempotent_requests)

---

## Complément du 24 novembre 2026 — Code Mode et orchestration économe

**Portée :** recherche et trajectoire d'intégration dans IAO ; lecture du dépôt à partir de `e81129a`. Le contenu du 12 novembre ci-dessus est conservé comme historique. **Aucun PTC, sandbox Cloudflare ou nouveau transport fournisseur n'est déclaré implémenté ou déployé par ce complément.** La qualité, les capacités et les autorisations priment sur l'économie de tokens.

### 9. État observé et point d'intégration unique

Le [registre des agents personnalisés](../karta/src/tools/customRegistry.ts) contient **10 outils** : Supabase lecture/écriture, brouillon/envoi Gmail, calendrier, PDF, recherche web/connaissances, simulation quantique et notification. Ce sous-ensemble n'est ni l'inventaire de tous les outils PURAMA ni une preuve de connexion de leurs comptes. Son volume ne justifie pas à lui seul une nouvelle infrastructure de recherche.

La [sélection CHEF](chef-capability-selection.md) existe déjà : préférences automatiques/manuelles, versions, dépendances, autorisations et sélection bornée depuis un contexte fourni par l'hôte. Sa documentation distingue les tests locaux du raccordement de production restant. Les catalogues, contrôles web, mémoire et caches existants gardent leur responsabilité. **Ne créer ni deuxième catalogue, ni deuxième routeur, ni deuxième ordonnanceur.** Une découverte progressive doit exposer une vue autorisée de ces registres.

Le [client réel](../karta/src/claude/real.ts) utilise le SDK et le protocole Messages Anthropic pour une décision unique, via une route native, compatible ou locale LM Studio selon la configuration. L'hôte actif n'est pas établi par cette lecture. Il expose les outils avec `strict: true`, valide leurs paramètres et n'accepte comme fins que `end_turn` ou `tool_use`. Il rejette les blocs serveur inconnus et ne possède pas de boucle de reprise de programme. Le [validateur local](../karta/src/engine/tool-input.ts) couvre les schémas actuellement définis ; il ne constitue pas un validateur universel de JSON Schema. Ajouter uniquement `allowed_callers` ne rendrait donc pas le client compatible PTC.

### 10. Où se dérouleraient les calculs

L'architecture proposée est hybride. Une API désigne une interface ; elle ne prouve pas que tout le travail quitte l'infrastructure PURAMA.

| Partie | Lieu selon la route retenue | Conséquence |
|---|---|---|
| Inférence distante | Fournisseur du modèle | Facturation et contraintes de ce fournisseur ; aucune GPU locale requise pour cette inférence |
| KARTA, règles métier, permissions, mémoire | Hôte PURAMA existant, cible Hostinger à qualifier | Autorité et contrôles conservés ; ce complément ne vérifie pas l'hébergement réel |
| PTC OpenAI | Runtime V8 hébergé OpenAI | Le programme compose les appels ; les fonctions appartenant à PURAMA restent exécutées par l'application [C3] |
| PTC Anthropic | Conteneur hébergé Anthropic | Python coordonne les fonctions ; l'application fournit les résultats des outils personnalisés [C4] |
| Code Mode Cloudflare | Dynamic Worker chez Cloudflare | Exécution isolée et accès aux outils permis ; service facturable [C2, C6] |
| Mode local/hors ligne | Appareil et moteur local qualifiés | Ni API distante ni sandbox cloud disponibles hors ligne ; ressources locales nécessaires |

`https://mcp.cloudflare.com/mcp` donne accès aux opérations **Cloudflare**. Le connecter n'optimise pas automatiquement Gmail, Supabase et tous les autres outils. Généraliser le principe demande une adaptation de leur exposition, en conservant leurs identités. L'utilisateur continue à utiliser l'interface PURAMA ; le lieu d'exécution reste une décision interne contrôlée, cohérente avec ses choix de confidentialité et de modèle.

### 11. Mécanismes fournisseurs : compatibilités à qualifier

| Mécanisme | Contrat utile | Limite déterminante |
|---|---|---|
| OpenAI Responses PTC | Outil `programmatic_tool_calling`, `allowed_callers` avec `direct`/`programmatic` ; traiter `program`, `program_output`, appels et résultats liés par `call_id`/`caller` | JavaScript hébergé sans Node, réseau direct, système de fichiers général ni état JS persistant ; modèle compatible requis [C3] |
| Anthropic Messages PTC | `code_execution_20260120` ou version compatible documentée, `allowed_callers`, conteneur et résultats d'outils permettant la continuation | `strict: true`, schémas récursifs et outils issus du MCP connector incompatibles ; réponses aux appels programmatiques limitées aux résultats textuels [C4, C5] |
| Cloudflare Code Mode | `DynamicWorkerExecutor` et adaptateurs `@cloudflare/codemode/mcp` ; `createCodeTool` depuis `@cloudflare/codemode/ai` | Fonctionnalité expérimentale : figer et qualifier la version [C2, C12] |

OpenAI accepte des outils MCP programmatiques avec leur politique `require_approval`. Sa recherche d'outils s'effectue avant le programme qui en dépend, pas depuis son JavaScript déjà lancé [C3]. L'incompatibilité Anthropic concerne le **MCP connector natif** : elle ne prouve pas l'impossibilité d'un adaptateur applicatif validé, qui reste à construire et tester. Aucun relais « compatible API » ne doit être présumé transporter ces protocoles, métadonnées et fonctions hébergées sans perte.

Pour Cloudflare, `codeMcpServer()` conserve les types de tous les outils dans sa description ; il réduit les allers-retours sans garantir un petit catalogue. `openApiMcpServer()` sépare recherche et exécution d'une grande spécification. Le serveur Cloudflare actuel documente aussi `docs` et `whoami` : « deux outils » décrit le principe initial, pas un contrat immuable [C1, C2].

`createCodeTool()` exclut les outils dont `needsApproval` vaut `true` ou une fonction et ne suspend pas l'exécution pour demander une approbation. Conserver le parcours direct pour ces opérations, ou qualifier un runtime avec pause, autorisation et reprise, tel que `createCodemodeRuntime()` avec connecteurs. Retirer le marqueur d'approbation pour rendre un outil appelable ne préserve pas la protection [C12].

### 12. Optimisations proposées dans l'existant

**Découverte progressive.** Réutiliser la sélection CHEF et les registres métier pour charger les définitions utiles. Avec Anthropic, `defer_loading` diffère l'entrée dans le contexte, mais les schémas complets restent transmis dans le corps HTTP de chaque requête. Avec OpenAI Responses, noms et descriptions des fonctions individuelles différées restent visibles ; namespaces et serveurs MCP permettent une présentation initiale plus compacte de leurs fonctions internes [C9, C10]. Mesurer séparément taille HTTP, tokens traités et tokens facturés. Cette découverte ne remplace pas les contrôles d'accès. Évaluer le rappel : un outil essentiel absent peut dégrader davantage la tâche que les tokens économisés. Prévoir une recherche élargie bornée et rendre les indisponibilités explicites, sans installer ni autoriser automatiquement un connecteur.

**Composition ciblée.** Garder l'appel direct pour une opération simple. Regrouper les lectures indépendantes, paginations, jointures, calculs et filtrages déterministes lorsque cela évite plusieurs passages par le modèle. Un résultat exigeant un jugement sémantique doit pouvoir revenir à IAO. Le plan doit préciser les bornes, le schéma de sortie et les conditions d'arrêt. La parallélisation ne s'applique pas aux mutations dépendantes d'un même état.

**Recettes paramétrées.** Les enchaînements récurrents peuvent devenir des recettes testées et versionnées dans les supports existants : objectif, outils admissibles, schémas, permissions, limites et critères de succès. Séparer les paramètres du code facilite réutilisation et comparaison. Toute recette conserve ses préconditions ; une nouvelle version de connecteur, une permission révoquée ou des données périmées impose une requalification. Un programme généré une fois avec succès n'est pas automatiquement une recette fiable.

**Résultats par références.** Garder les données volumineuses dans le stockage autorisé et renvoyer un résultat structuré avec référence, provenance, version, comptage, statut de complétude et extraits utiles. IAO doit pouvoir récupérer un passage précis ou la totalité autorisée. Une troncature ne devient jamais une preuve d'absence. Les erreurs, citations et documents finaux doivent survivre au filtrage ; les journaux et sorties de débogage ne doivent pas réinjecter tous les résultats intermédiaires. Le serveur Cloudflare borne lui-même certaines sorties, ce qui ne dispense pas de vérifier leur complétude [C1].

**Même qualité de service.** Le choix automatique reste transparent pour l'utilisateur. Il conserve les modèles experts quand la tâche les nécessite et la route manuelle choisie. Une réduction du raisonnement, une suppression de sources ou un modèle inférieur ne sont pas des économies admises sans qualification. Les optimisations de cache, batch et mémoire des sections précédentes se combinent seulement après mesure de leurs interactions.

### 13. Frontières d'exécution et reprise

Pour une sandbox Cloudflare, `globalOutbound: null` bloque les sorties réseau générales ; les bindings ou une passerelle contrôlée donnent les capacités nécessaires. Les secrets restent dans le superviseur. Des limites CPU et sous-requêtes sont configurables [C7]. Les limites publiées de Dynamic Workers simultanés sont quatre par contexte de requête Worker et dix par Durable Object ; elles ne décrivent pas une capacité globale de quatre ou dix utilisateurs [C8].

Pour IAO, les exigences suivantes doivent être vérifiées sur chaque route :

- Résoudre l'utilisateur et l'organisation depuis une session fiable ; ne jamais accepter le tenant choisi par le programme comme autorité.
- Revalider permission, périmètre, budget et arguments à chaque opération, même dans un script unique ; ne pas assimiler schéma valide et action autorisée.
- Borner durée totale, CPU, appels, concurrence, volume de sortie et tentatives ; propager l'annulation et conserver l'état des effets déjà engagés.
- Réserver les mutations au parcours d'autorisation existant, avec clés d'idempotence et journal durable. Après une interruption ambiguë, rapprocher l'état avant une reprise.
- Traiter documents, pages et résultats externes comme des données. Ils ne peuvent étendre permissions ou destinations ni devenir du code exécuté sans validation.
- Séparer caches, références, traces et secrets entre utilisateurs. Une recette commune ne partage aucun état privé ; les traces restent minimisées et expurgées.

Une sandbox n'autorise pas à exécuter du code arbitraire dans le processus principal de KARTA. Le choix d'un runtime local demanderait une isolation réelle, une qualification distincte et un budget d'exploitation.

### 14. Coût total et preuve de non-régression

Le chiffre Cloudflare **1,17 million vers environ 1 000 tokens** compare l'exposition initiale des définitions de son API ; il ne mesure pas une baisse de 99,9 % de la facture PURAMA [C11]. Anthropic rapporte environ 38 % d'entrées facturées en moins sur un benchmark à 75 outils, précision inchangée ; sur τ²-bench avec un ou deux appels séquentiels, les scores restent stables et le coût augmente d'environ 8 %. Ces résultats ne sont pas des mesures IAO [C4].

Dynamic Workers nécessite Workers Paid. La tarification publiée ajoute, après l'inclusion annoncée, **0,002 dollar par Worker distinct et par jour** ; requêtes et CPU sont aussi comptés. Changer code ou identifiant peut créer une nouvelle unité facturée ; `.load()` sans identifiant compte chaque invocation. Un ID stable avec code identique réduit ce poste sans autoriser le mélange des contextes utilisateurs [C6].

Le critère économique proposé est le **coût total par tâche réussie avec qualité requise**, comprenant échecs, reprises, escalades, modèles, exécution, API et stockage. Comparer à modèle, exigences et données équivalents : chemin actuel, sélection ciblée seule, puis composition. Mesurer latence médiane/p95, qualité finale, exhaustivité des preuves, taux de succès et coût réel ; publier aussi les cas défavorables. Un budget réduit ne doit pas transformer un échec en succès apparent.

Le jeu de qualification doit couvrir lectures simples, nombreuses lectures, gros résultats, choix sémantiques, permissions révoquées, résultats malformés, interruption, concurrence et mutation ambiguë. Les critères sont définis avant comparaison. Une absence de régression observée sur cet échantillon n'est pas une garantie universelle ; le lancement exige ensuite une observation bornée sur le trafic autorisé.

### 15. Trajectoire mécanique et réception

1. **Assainir l'exposition existante :** noms uniques, liste autorisée stable, schémas et sorties documentés ; mesurer les tokens effectivement envoyés. Les changements ciblés doivent conserver l'ordre utile et les validations existantes.
2. **Étendre le transport existant :** déclarer capacités par fournisseur/modèle/route, sans nouveau routeur. Conserver les reçus d'usage pour les réponses rejetées et un budget couvrant toute la continuation.
3. **Implémenter un protocole de continuation qualifié :** le contrat actuel de `real.ts` produit une seule décision. Les programmes suspendus, appels internes, résultats et fin réelle doivent être représentés et repris explicitement. Préserver leurs identifiants et métadonnées ; ne pas considérer un appel intermédiaire comme une décision finale.
4. **Gérer la validation Anthropic :** conserver la route directe `strict`. Une route programmatique distinctement qualifiée doit vérifier côté application tous les schémas qu'elle accepte ; retirer globalement `strict` ou accepter des blocs inconnus n'est pas une intégration recevable.
5. **Qualifier découverte et recettes en lecture seule**, avec vérification de la réponse finale et des preuves ; étendre ensuite aux actions autorisées seulement si reprise, idempotence et audit sont démontrés. Utiliser les vérificateurs CHEF et journaux existants.
6. **Activer progressivement par famille validée**, sous paramètres réversibles. Préserver le chemin antérieur pour un repli technique sûr, sans rejouer une action dont l'effet est inconnu. L'équipe IAO porte code et recette ; l'administrateur habilité qualifie accès, comptes et dépenses nécessaires.

Les tests d'un correctif de déduplication ou de sélection peuvent vérifier les invariants du contrat et le choix de modèle prévu. Ils ne démontrent pas une qualité générative universellement inchangée ; cette dernière demande des évaluations représentatives distinctes. Ne pas présenter ces contrôles mécaniques comme un benchmark complet d'IAO.

| Élément | Nature de l'information | État de ce complément |
|---|---|---|
| Dix outils personnalisés, sélection CHEF, client à décision unique | Faits du dépôt consulté | PASS, lecture du code et documents ; aucune preuve de production déduite |
| PTC et Code Mode chez les fournisseurs | Faits documentaires datés | PASS pour les sources ; accès des comptes non vérifié |
| Découverte commune, recettes et références | Propositions d'intégration dans l'existant | NON TESTÉ dans IAO |
| Compatibilité des continuations et validation PTC | Travail technique restant | BLOQUÉ pour une activation immédiate par le contrat actuel |
| Économies, rapidité et qualité en exploitation | Résultats à mesurer | NON TESTÉ ; aucun pourcentage de gain promis |

### Sources du complément — consultées le 24 novembre 2026

- [C1 — Cloudflare MCP, portée et outils actuels](https://github.com/cloudflare/mcp)
- [C2 — Construire un serveur MCP Code Mode](https://developers.cloudflare.com/agents/model-context-protocol/guides/build-codemode-mcp-server/)
- [C3 — OpenAI : Programmatic Tool Calling](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling)
- [C4 — Anthropic : Programmatic tool calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)
- [C5 — Anthropic : propriétés et incompatibilités des outils](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference)
- [C6 — Cloudflare : tarification Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/pricing/)
- C7 — Cloudflare : [contrôle réseau](https://developers.cloudflare.com/dynamic-workers/usage/egress-control/) et [limites de ressources](https://developers.cloudflare.com/dynamic-workers/usage/limits/)
- [C8 — Cloudflare : limites de concurrence](https://developers.cloudflare.com/dynamic-workers/platform/limits/)
- [C9 — OpenAI : tool search](https://developers.openai.com/api/docs/guides/tools-tool-search)
- [C10 — Anthropic : tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
- [C11 — Cloudflare : mesure de l'empreinte du catalogue](https://blog.cloudflare.com/code-mode-mcp/)
- [C12 — Cloudflare : API Code Mode, createCodeTool et approbations](https://developers.cloudflare.com/agents/tools/codemode/api-reference/)
