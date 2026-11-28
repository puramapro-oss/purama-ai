# Agent téléphonique IAO — contrat de raccordement

Version de travail du 28 novembre 2026. Le code local et ses tests ne prouvent pas qu’un compte, un agent, un numéro ou un appel réel sont actifs.

## Un seul mandat IAO

KARTA conserve les routines, les occurrences, les préférences, les droits et les preuves. L’adaptateur `karta/src/routines/phone.ts` ne planifie rien et n’exécute aucune instruction issue d’une transcription. Il émet un appel puis rapproche son reçu ; la suite appartient aux routes et à l’autorité IAO existantes.

Un `external_id` Bland permet une recherche, mais n’empêche pas deux appels portant le même identifiant. La réservation durable d’une occurrence doit précéder le POST. Après timeout ou résultat ambigu, rapprocher l’appel existant, sans refaire automatiquement le POST. Une réponse acceptée indique une mise en file ; `completed` peut désigner un répondeur et ne prouve pas une écoute.

## Configuration serveur préalable

Le composant attend une activation explicite, une clé API d’organisation, l’UUID du Bland Agent, un secret de signature et une URL HTTPS publique. Les noms de variables d’environnement sont définis par la composition serveur. Le secret de signature doit correspondre à celui configuré dans le compte Bland.

La version `production` du Bland Agent doit déjà être publiée, ses appels autorisés et sa voix française qualifiée. Le présent travail ne crée pas de compte, ne publie pas l’agent, n’achète pas de numéro ou de crédits et n’active pas de recharge.

Le POST utilise les paramètres suivants :

| Paramètre | Contrat |
| --- | --- |
| `agent_id`, `agent_version` | Agent configuré, version `production` explicite |
| `phone_number` | Numéro vérifié par l’application, format E.164 |
| `language` | `fr` |
| `max_duration` | 1 à 10 minutes ; défaut de l’adaptateur : 2 |
| `record` | `false` |
| `block_interruptions` | `false` |
| `voicemail` | Seulement `{ "action": "hangup" }`, sans message ni SMS |
| `external_id` | Identifiant de l’occurrence réservée |
| `metadata` | `occurrence_id`, `routine_id` |
| `request_data` | `briefing`, `instruction`, `occurrence_id`, `routine_id` ; contexte de capture optionnel décrit ci-dessous |
| `webhook` | Endpoint HTTPS de réception configuré côté serveur |

La requête n’envoie ni `task`, ni `tools`, ni autre sélecteur : les instructions et les outils proviennent de l’agent enregistré. Les données de contexte ne contiennent aucun droit ou secret permanent.

La consigne respecte la limite de 4 000 points de code Unicode du contrat de routine et du stockage. La désactivation des nouveaux appels bloque le POST ; une recherche GET reste possible avec une configuration valide pour rapprocher les appels déjà transmis.

Lorsque la capture de demandes est raccordée, le serveur peut fournir `commandContext` à l’adaptateur : `occurrenceId`, `token` et `expiresAt`. L’adaptateur exige la même occurrence que l’appel, un jeton de 64 caractères hexadécimaux et une date UTC future au format `YYYY-MM-DDTHH:mm:ss.sssZ`. Il les transmet uniquement dans `request_data`, sous `command_occurrence_id`, `command_token` et `command_expires_at`. Sans ce contexte, le contrat de création d’appel reste identique.

Ce jeton éphémère permet seulement de déposer une demande à confirmer. Le serveur le signe en liant le propriétaire, la routine, l’occurrence et son expiration ; il conserve l’autorité sur leur association et limite sa durée. Ce jeton et les secrets permanents ne doivent apparaître ni dans les messages d’historique, ni dans les journaux, ni dans les résumés parlés.

## Configuration du Bland Agent

Le prompt de l’agent doit annoncer qu’il s’agit d’IAO, utiliser `{{briefing}}` comme contenu factuel et `{{instruction}}` comme objectif du bilan. Il doit recueillir les nouvelles demandes et annoncer uniquement le résultat réellement renvoyé par IAO. Il ne peut pas déduire d’une conversation qu’une modification, un paiement ou un envoi est terminé.

Pour un outil de réception des demandes :

1. Créer un **webhook tool** POST vers la route IAO prévue pour recevoir la commande.
2. Stocker un secret dédié à cet outil dans les secrets Bland et le référencer dans l’en-tête `Authorization: Bearer …`. Ce secret permanent reste distinct de la signature des webhooks et du jeton éphémère. Ne pas utiliser la clé API générale IAO ou un secret dans le prompt.
3. Laisser `call_id`, `command_occurrence_id`, `command_token` et `command_expires_at` comme variables fixes du contexte de l’appel. Leur correspondance avec les champs de la route doit être configurée dans le builder et vérifiée sur un appel de qualification. Ne pas les déclarer comme variables remplies par le modèle. Seul le texte de la demande est une entrée conversationnelle ; la transcription complète ne constitue pas cette demande.
4. La route retrouve le propriétaire et les droits à partir de son association durable. Elle vérifie le secret de l’outil, le HMAC lié à l’occurrence et sa date limite, puis compare `call_id` au reçu enregistré ou à une recherche vérifiée chez le prestataire. La demande est enregistrée en `pending_confirmation`, sans exécution. La reprise passe par l’autorité IAO existante.
5. Sélectionner les champs de sortie nécessaires pour que le tool attende sa réponse. Pour un POST, le corps retourné se trouve sous les champs `rest_api_post_*` du builder ; vérifier leur sélection après enregistrement.
6. Tester le vrai agent avec une demande sans effet externe avant d’ouvrir son utilisation.

Le corps JSON de cet outil contient exactement ces cinq champs :

| Champ HTTP | Valeur configurée dans l’outil |
| --- | --- |
| `call_id` | Identifiant fixe de l’appel courant fourni par Bland |
| `occurrence_id` | Variable fixe `command_occurrence_id` |
| `token` | Variable fixe `command_token` |
| `expires_at` | Variable fixe `command_expires_at` |
| `instruction` | Texte de la demande recueillie, seule entrée remplie par le modèle |

La variable conversationnelle utilisée pour ce dernier champ doit rester distincte de la variable `instruction` de présentation du bilan. L’outil ne demande aucun `request_id` au modèle : IAO calcule sa clé de déduplication à partir de l’appel et du texte normalisé. La répétition d’une même demande pendant cet appel retrouve donc la capture existante.

L’autorité de `karta/src/api/iaoRoutes.ts` exige une session serveur valide, courte et liée à l’utilisateur. Le jeton utilisé pour créer une routine ne constitue pas une session valable le lendemain. Si la composition ne sait pas fournir l’autorité vérifiée au moment de la commande vocale, la demande reste à confirmer dans IAO : aucune identité ou session de production ne doit être inventée pour déclencher son exécution.

## Réception et réconciliation

`verifyPhoneWebhook` vérifie le HMAC-SHA256 hexadécimal de `X-Webhook-Signature` sur les octets bruts. Le handler HTTP doit limiter le corps, vérifier cette signature avant son traitement, puis rapprocher l’appel et dédupliquer durablement. La signature n’établit ni une fraîcheur ni une autorisation métier.

La documentation actuelle indique que le webhook final ordinaire n’est pas rejoué automatiquement après erreur. La récupération GET par `call_id` ou `external_id` reste nécessaire. L’adaptateur vérifie l’identifiant recherché et refuse une association contradictoire dans les métadonnées. Le stockage appelant doit encore comparer le reçu à son occurrence exacte.

La transcription éventuelle est bornée à 16 000 caractères et signale sa troncature. Elle est une donnée du prestataire, pas une commande autorisée. Les erreurs de transport, de schéma et de taille ne rendent pas les diagnostics du fournisseur. Une limite totale de 10 secondes couvre les en-têtes, le corps et le décodage ; aucun redirect ni retry automatique n’est effectué.

## Qualification restante

Les tests du module emploient le vrai code et des réponses HTTP synthétiques. Restent à qualifier avec les accès et autorisations applicables : l’agent publié, les variables de contexte, le secret reçu, un appel réel en français, les interruptions, le répondeur, la réception après coupure et la continuité vers une mission réellement autorisée. Aucune qualité audio ou exécution de production n’est déduite de ces tests.

## Références officielles consultées

- [Envoi avec un agent](https://docs.bland.ai/api-v1/post/calls-agent)
- [Sélecteurs, contexte et paramètres](https://docs.bland.ai/api-v1/post/calls)
- [Détails et recherche d’un appel](https://docs.bland.ai/api-v1/get/calls-id)
- [Signature des webhooks](https://docs.bland.ai/tutorials/webhook-signing)
- [Webhooks de fin d’appel](https://docs.bland.ai/tutorials/post-call-webhooks)
- [Outils d’agent](https://docs.bland.ai/agents/tools)
- [Intégration d’une API](https://docs.bland.ai/tutorials/tools/custom-api)
- [Secrets](https://docs.bland.ai/tutorials/secrets)
