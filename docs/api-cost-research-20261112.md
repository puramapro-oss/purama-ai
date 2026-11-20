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
