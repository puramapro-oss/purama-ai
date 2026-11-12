# IAO — intégration locale LM Studio et modèle Heretic

Date : 12 novembre 2026, Europe/Paris. **Statut global : PARTIEL.**

Le client KARTA existant accepte désormais, par option explicite, un modèle déjà chargé dans LM Studio. Le protocole Messages, la validation des décisions, les reçus d'usage et les permissions KARTA sont réutilisés. Aucune nouvelle dépendance n'est ajoutée.

Ce candidat constitue un raccordement logiciel et un banc de qualification. Il ne prouve ni installation de LM Studio sur le Mac, ni téléchargement de poids, ni activation du parcours natif IAO.

## Ce que présente le lien

Le [guide Core Labs](https://corelabs.studio/ressources/outil-ton-ia-debridee-sur-ton-ordi-sans-terminal-en-15-minutes-1mc2e0) associe LM Studio à `bartowski/p-e-w_Qwen3-4B-Instruct-2507-heretic-GGUF`, quantification Q4_K_M. [Heretic](https://github.com/p-e-w/heretic) modifie le comportement des modèles, notamment leurs refus ; son projet actuel décrit aussi des réglages contre la complaisance ou les réponses répétitives. Cela n'établit pas une amélioration générale du raisonnement ou du code.

La [fiche des poids](https://huggingface.co/bartowski/p-e-w_Qwen3-4B-Instruct-2507-heretic-GGUF) déclare Apache-2.0 ; le programme Heretic déclare AGPL-3.0. Aucun code Heretic ni poids ne sont copiés dans IAO par ce lot. Un modèle de 4 milliards de paramètres reste un candidat complémentaire à évaluer ; il ne remplace pas automatiquement Qwen3-Coder 30B ni les routes déjà qualifiées. Aucune supériorité, viralité, économie ou latence n'est déclarée mesurée.

## Contrat du raccordement

L'API [Messages de LM Studio](https://lmstudio.ai/docs/developer/anthropic-compat/messages) permet de réutiliser le SDK Anthropic déjà verrouillé dans KARTA. L'option est un choix de transport explicite du composant serveur :

```ts
const client = createRealClaudeClient({
  lmStudio: {
    model: exactLoadedInstanceId,
    baseURL: "http://127.0.0.1:1234",
    apiKey: optionalLocalToken,
  },
});
```

Le singleton de production `getClaudeClient()` continue à utiliser sa configuration existante. Le navigateur et l'espace hors connexion n'appellent pas LM Studio directement. Aucun environnement de service n'est changé.

| Garantie du composant | Vérification |
|---|---|
| Destination locale explicite | HTTP sur 127.0.0.1 ou ::1 ; localhost normalisé sans résolution DNS ; aucun chemin, utilisateur, requête ou fragment |
| Credentials séparés | Jeton LM Studio uniquement ; clé Anthropic et jeton ambiant exclus de cette route |
| Modèle réellement déclaré chargé | Lecture de `/api/v1/models` avant chaque prompt ; une seule instance correspondante, format GGUF/MLX et type LLM |
| Appels d'outils | Capacité déclarée requise si des outils sont proposés, puis validation complète des paramètres ; aucune exécution par le client |
| Sortie contrôlée | Même limite de 1 024 tokens, refus des décisions tronquées ou incohérentes, reçus d'usage conservés |
| Réseau borné | Aucun téléchargement ou chargement automatique, aucune redirection, aucune reprise automatique ni route de secours dans ce transport |
| Annulation et mémoire | Délai complet existant conservé, réponses limitées à 2 Mio, résultat tardif écarté |
| Concurrence | Une opération en cours par origine et processus, avec refus immédiat d'une deuxième demande |

L'inventaire suit le [contrat officiel LM Studio](https://lmstudio.ai/docs/developer/rest/list). Une ancienne version sans ce contrat échoue avant l'envoi du prompt. L'authentification est décrite dans la [documentation officielle](https://lmstudio.ai/docs/developer/core/authentication).

Ces vérifications reposent sur les métadonnées du serveur local. Elles n'attestent pas à elles seules son comportement réseau, l'intégrité des poids ou l'absence de LM Link. Le contrôle des instances n'est pas une réservation : un autre processus peut décharger un modèle après la vérification. La limite de concurrence ne couvre ni plusieurs processus ni tous les services du Mac. Une connexion HTTP interrompue ne prouve pas l'arrêt du GPU. Le gouverneur matériel et Compute Fabric restent nécessaires pour le parcours natif.

## Qualification reproductible

Les tests unitaires utilisent le véritable SDK, avec transport intercepté. Le banc socket emploie des serveurs HTTP réels sur loopback, avec des réponses synthétiques, sans moteur IA. Les deux vérifient du code et des contrats, pas la qualité des poids.

```sh
cd karta
npm run typecheck
npm run build
npm test -- test/lmStudioTransport.test.ts test/real-claude.test.ts test/claudeTransportCost.test.ts test/claudeTransportDeadline.test.ts test/claudeDecisionCompleteness.test.ts test/claudeUsageTransport.test.ts test/loopModelAdmission.test.ts test/loopModelUsage.test.ts test/loopTracePrivacy.test.ts test/loop.test.ts --maxWorkers=1
npm run test:lmstudio:sockets
```

Le banc réel `npm run qualify:lmstudio` exige `PURAMA_LMSTUDIO_SMOKE=1` et `PURAMA_LMSTUDIO_MODEL` égal à l'identifiant chargé. `PURAMA_LMSTUDIO_URL` et `PURAMA_LMSTUDIO_TOKEN` sont facultatifs ; aucune clé cloud n'est réutilisée. Il vérifie deux cas synthétiques : réponse exacte `42` et préparation d'un outil avec un titre français. Il ne lance aucun agent métier et n'exécute aucun outil. Les échecs ne sont pas masqués ; les réponses et exceptions privées ne sont pas journalisées. Sans sélection explicite, il sort avec le code 1 sans accès au modèle. Ce banc n'est pas une autorisation de contourner un gel d'exécution du Mac.

## Réception et étapes restantes

Les commandes, codes de sortie et empreintes figurent dans `qa/lmstudio-20261112/verification.json`. Les premières erreurs de typage sont conservées dans les journaux de ce dossier, puis corrigées. La revue indépendante a fait corriger un contrôle d'ambiguïté : deux instances homonymes dans la même entrée sont maintenant refusées.

| Gate | Statut |
|---|---|
| Identification de l'outil et contrats officiels | PASS |
| Tests ciblés, transport HTTP synthétique, typage et compilation | Voir le reçu de vérification |
| Modèle Heretic réellement exécuté sur le M4 Max 48 Go | NON TESTÉ |
| État du Mac | PASS pour le contrôle en lecture seule : Ollama répond ; serveur LM Studio absent ; connexion Compute Fabric refusée ; environ 18,78 Gio libres |
| Installation, configuration et empreintes des poids Heretic sur le Mac | NON EFFECTUÉ : disque sous les seuils documentés et pont natif indisponible |
| Interface IAO native sans terminal | PARTIEL : pont existant à raccorder et qualifier |
| Déploiement ou activation pour les utilisateurs | NON EFFECTUÉ |

La [réception hors connexion existante](./offline-reintegration-20261110.md) rapporte un gel d'exécution natif, une incompatibilité RPC/1–v2 et des seuils disque de 40/60 Gio. Le contrôle complémentaire de cette session, via un second accès après l'échec des deux MacDevBridge, confirme qu'Ollama répond avec cinq modèles déclarés et que le socket Compute Fabric refuse encore la connexion. LM Studio n'est trouvé ni dans les deux dossiers Applications habituels ni par Spotlight, et son port par défaut ne répond pas. L'espace libre mesuré est de 18,78 Gio. Ces constats ne constituent pas une nouvelle qualification des empreintes, du protocole ou du gouverneur.

L'équipe propriétaire du pont T01/T03/T06 doit qualifier ces dépendances avant son activation. La route directe de qualification n'est pas activée pour les contourner. Aucun modèle supplémentaire n'est téléchargé sur ce disque et aucun fichier existant n'est supprimé. Les travaux du choix des compétences/connecteurs et de l'espace hors connexion restent séparés de ce delta.

Après rétablissement de l'accès : vérifier l'existant avant installation, privilégier les poids déjà disponibles, qualifier les licences et modèles retenus, mesurer français/code/outils et consommation mémoire sur les mêmes tâches, puis intégrer ce transport sous l'admission matérielle et les autorisations du pont existant. La sélection graphique devra piloter ce pont ; aucune seconde IAO ni deuxième orchestrateur n'est nécessaire.
