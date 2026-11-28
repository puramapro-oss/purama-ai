# API natives dans le Conseil IAO

## Périmètre et continuité

Cette intégration prolonge le Conseil existant de `audit/reliability-oauth-20261110`, base `a18e6a0ed78a891827b2fb76ce44b97fb110a854`. Elle conserve le catalogue de profils, la politique d'assistant, les autorisations CHEF, les réservations, les reçus privés et le panneau Conseil. Elle ne crée ni orchestrateur, ni ledger, ni écran, ni tâche de veille supplémentaire.

Les travaux mémoire, atelier, compagnons natifs, vérification observée et Conseil déjà consolidés restent dans cette lignée. Les modifications des PR 121 et 125 restent séparées : `consultation.ts`, `consultation-store.ts`, `iaoRoutes.ts`, `ChatbotWidget.tsx` et les fichiers d'essai scientifique ne sont pas remplacés par ce lot.

## Capacités réellement raccordées

| Surface | Route et comportement |
| --- | --- |
| Anthropic | Chargeur natif et client Messages existants conservés. La qualification PTC historique reste propre à Anthropic. |
| OpenAI | Catalogue `/v1/models`, génération `/v1/responses`, texte, raisonnement explicitement qualifié et propositions d'appels de fonctions client. |
| xAI | Catalogue `/v1/language-models`, génération `/v1/responses`, texte, efforts qualifiés et propositions d'appels de fonctions client. |
| Google | Catalogue paginé `/v1beta/models`, génération `generateContent`, texte, budgets ou niveaux de réflexion qualifiés et propositions d'appels de fonctions client. |
| Conseil | Le même parcours de proposition, critique et synthèse peut utiliser plusieurs fournisseurs. Une seule table modèle/fournisseur détermine découverte, sélection, estimation, réservation et exécution. |
| Recherche | Les connecteurs de recherche existants restent sous leur autorisation et leur budget propres. Les outils hébergés de recherche des autres fournisseurs ne sont pas activés implicitement. |

Le Conseil actuel utilise des appels de texte sans outils client. Les adaptateurs savent traduire et valider des propositions d'appels client, mais ne les exécutent pas : les autorisations et l'exécution appartiennent toujours à KARTA. Le sous-ensemble JSON Schema validé réutilise `validateProgrammaticToolParams`. Un schéma ou un résultat non pris en charge est refusé.

Une connexion n'accorde pas les fonctionnalités des applications commerciales ChatGPT, Claude, Gemini ou Grok. Ce lot ne qualifie pas automatiquement images, vidéo, audio temps réel, outils hébergés, computer use, fichiers, recherche native, ni programmes PTC chez les nouveaux fournisseurs. Ces capacités doivent être raccordées à leur surface réelle et vérifiées dans les parcours IAO concernés avant d'être annoncées dans l'interface.

## Catalogue et mises à jour

`KARTA_CONSULTATION_POLICY_JSON` reste la source d'autorité. Ses lignes `models` acceptent désormais :

| Champ | Rôle |
| --- | --- |
| `model` | Identifiant exact transmis au fournisseur. Le préfixe de ressource Google `models/` est reconnu sans créer deux choix équivalents. |
| `provider` | `anthropic`, `openai`, `google` ou `xai`. L'absence conserve Anthropic pour les politiques historiques. |
| `maxInputTokens`, `maxOutputTokens`, `maxCostMicros` | Limites existantes, établies par la politique financière de l'hôte. La présence au catalogue n'alloue aucun budget. |
| `reasoning` | `none` par défaut pour les nouvelles routes ; `adaptive` pour les efforts explicitement qualifiés ; `budget` uniquement pour Anthropic/Google. `none` signifie absence de réglage avancé qualifié, pas garantie d'absence de raisonnement interne chez le fournisseur. |
| `effortLevels` | Sous-ensemble qualifié des efforts du profil. OpenAI/xAI n'acceptent pas le réglage Anthropic `max`. Google utilise les niveaux natifs, dont `xhigh` lorsque qualifié. |
| `responseModels` | Snapshots supplémentaires explicitement acceptés pour un alias. La réponse conserve son identité réelle dans le reçu ; une identité inattendue bloque la décision. |

Les plafonds, la version et l'expiration de la politique restent obligatoires. Les identifiants sont uniques entre fournisseurs ; deux routes Google vers le même identifiant sont refusées. Les données avec accesseurs, proxies, champs inconnus ou tableaux ambigus sont refusées avant découverte.

Le cache partagé existant expire après 60 secondes. Chaque fournisseur dispose de 4 secondes sous l'enveloppe globale de 5 secondes du host. Une route absente ou en panne est omise ; elle n'empêche pas les autres routes qualifiées de fonctionner. La découverte Google est bornée à cinq pages de mille modèles ; une pagination incomplète n'est pas publiée.

Le catalogue ne devine pas des capacités à partir d'un nom. OpenAI expose principalement l'identité des modèles ; les profils restent qualifiés par l'hôte. Les métadonnées xAI et Google peuvent réduire une qualification, jamais l'élargir arbitrairement. Un `thinking:false` Google exclut la route si le profil exige ce réglage.

Les mises à jour du catalogue sont donc automatiques pour les routes déjà qualifiées. Un nouveau modèle ou une nouvelle API ne devient pas automatiquement une autorisation de dépense ou une fonctionnalité disponible. Un alias dont la réponse change vers un snapshot non qualifié est bloqué, avec son reçu de consommation conservé.

## Comptes et confidentialité

Les clés restent exclusivement côté serveur. Le host utilise :

- Anthropic : la configuration Anthropic existante.
- OpenAI : `OPENAI_API_KEY`.
- Google : `GEMINI_API_KEY`, puis `GOOGLE_API_KEY`, puis `GOOGLE_AI_API_KEY`.
- xAI : `XAI_API_KEY`, puis `GROK_API_KEY`.

Une carte `apiKeys` explicitement injectée isole les comptes ; elle ne récupère pas les autres clés de l'environnement. Le transport fixe les origines officielles, interdit les redirections, borne les requêtes/réponses et réutilise la borne monotone du runtime. Il n'effectue aucune relance automatique. OpenAI et xAI reçoivent `store:false`. Cela ne constitue pas une garantie générale sur les règles de conservation du fournisseur.

Le résultat public expose le choix et le nom du fournisseur dans les réglages techniques existants. Il ne contient ni clés, ni reçus privés, ni options natives de réflexion. Les parties de raisonnement des fournisseurs ne deviennent pas le texte final. Les refus, troncatures, outils inattendus, arguments invalides et identités incohérentes ne deviennent pas des actions exécutables.

## Reçus et base de données

Appliquer `karta/migrations/038_native_model_usage.sql` après la chaîne existante, avant d'activer les nouvelles routes dans un environnement. La migration étend les validateurs existants ; elle ne remplace pas les données historiques ou les autorisations. Elle est testée sur la fondation réelle et la chaîne KARTA 001 à 037, puis appliquée deux fois pour vérifier l'idempotence.

| Format | Compatibilité et comptage |
| --- | --- |
| v1 | Anthropic/compatible conservé. Entrée, lecture de cache et création de cache restent distinctes. |
| v2 | Chaîne PTC Anthropic conservée. Un reçu natif v3 ne peut pas y être introduit. |
| v3 OpenAI | `openai_responses` / `openai`. Les entrées incluent le cache ; les sorties incluent le raisonnement. |
| v3 xAI | `xai_responses` / `xai`. Le cache est inclus dans les entrées ; le raisonnement est observé séparément des sorties visibles. |
| v3 Google | `gemini_generate_content` / `google`. Entrées, cache, sorties, pensées et entrées d'outils restent identifiables. |

Le reçu est enregistré avant validation de la décision, y compris lorsqu'une réponse consommée est refusée. Les compteurs absents restent inconnus (`null`) ; un zéro explicitement déclaré reste zéro. Le total déclaré sert à vérifier la cohérence sans reconstruire artificiellement les données manquantes. Le modèle demandé et le fournisseur doivent correspondre à la réservation.

Les reçus ne constituent pas des factures. Tant que le coût réel n'est pas rapproché, le circuit existant conserve la réservation financière. En particulier, la documentation xAI indique que `max_output_tokens` borne les sorties visibles, sans borner le raisonnement ni les appels de fonctions : ce paramètre n'est pas présenté comme une garantie de coût global.

## Activation et vérification

L'intégration de code et le déploiement sont des états distincts. L'activation requiert la migration, une politique hôte valide, une provision utilisateur existante, un compte fournisseur utilisable, la sortie du mode simulation et le respect de l'arrêt global. Ne pas modifier les clés ou les budgets d'un autre chantier pour contourner un refus.

Les tests doivent couvrir : catalogue → host → réservation → transport natif → reçu → SQL → résultat public, ainsi que les erreurs et annulations. Les suites ajoutées portent sur les catalogues, les transports, les reçus et la migration ; les tests historiques Anthropic/PTC et Conseil restent exécutables. Les limites des contrôles réels de cette livraison sont consignées dans `docs/qa/iao-connected-providers-20261127.md`.

## Références de contrat

- [OpenAI Responses](https://developers.openai.com/api/reference/resources/responses/methods/create) et [function calling](https://developers.openai.com/api/docs/guides/function-calling).
- [xAI Responses](https://docs.x.ai/developers/rest-api-reference/inference/responses.md) et [modèles](https://docs.x.ai/developers/rest-api-reference/inference/models).
- [Google generateContent](https://aistudio.google.com/api-reference/generate-content/generate-content), [modèles](https://aistudio.google.com/api-reference/models) et [réflexion](https://aistudio.google.com/docs/thinking).
