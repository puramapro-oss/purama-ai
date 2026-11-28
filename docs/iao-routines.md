# Appels et routines IAO — fonctionnement et activation

## Périmètre de cette livraison

Cette version ajoute les routines à la page existante `/notification-settings`, au serveur KARTA et à son cycle de planification. Elle réutilise le journal `karta_runs`, les préférences de notifications et le centre de notifications existants. Les résultats de recette sont conservés dans `qa/iao-calls-routines-20261128/`.

La base exacte est `f95c4f472621fbf0335763b594add58d79175195`, tête de la PR 128, qui conserve la PR 126. La branche de travail est `feat/iao-calls-routines-20261128-3eae`. La migration porte le numéro **040** : le numéro 039 est déjà utilisé par la proposition parallèle de l’API développeurs IAO (PR 129). Aucune fusion de ces travaux parallèles n’est implicite.

### Parcours utilisateur

1. Choisir une routine ou partir du bilan du matin, du bilan du soir ou d’une alerte de décision.
2. Choisir une cadence quotidienne, certains jours de semaine, une date unique ou un événement du journal : réussite réelle, blocage, décision attendue.
3. Régler l’heure et le fuseau, les heures calmes, les agents concernés, la longueur et la consigne de présentation.
4. Choisir appel, message dans l’application, notification push ou email. Le mode parallèle traite chaque canal indépendamment ; le mode de repli respecte l’ordre affiché.
5. Vérifier les trois prochaines échéances avant activation. Modifier un réglage invalide cette prévisualisation. Les routines événementielles n’affichent pas de dates inventées.
6. Enregistrer, mettre en pause, reprendre ou demander un bilan immédiat. Consulter ensuite l’historique et le reçu de chaque canal.

Les canaux non configurés sont signalés ; ils ne sont pas annoncés disponibles. Une routine peut être conservée en pause sans fournisseur actif. Le numéro présenté à l’écran est masqué ; la destination réelle est exclusivement l’identité téléphonique confirmée de Supabase Auth.

Les messages de cette version sont les messages dans l’application et les emails sélectionnés. L’adaptateur SMS/WhatsApp n’est pas inclus. La consigne influence la présentation par l’agent vocal ; le bilan écrit demeure une restitution déterministe du journal. Cette version ne traduit pas une phrase libre en une nouvelle automatisation sans paramètres vérifiés.

## Autorités et données

Le navigateur appelle `iao-routines`. Ce proxy vérifie le bearer avec `auth.getUser`, puis le revalide pour le même compte avant toute mutation. Le serveur interne reçoit le propriétaire dans le chemin protégé par `KARTA_ADMIN_TOKEN` ; un champ `userId` dans le corps est refusé.

La migration 040 crée quatre registres privés : routines, occurrences, livraisons et demandes vocales. Les clients authentifiés peuvent lire uniquement leurs propres lignes. Les mutations passent par les fonctions SQL réservées au serveur. Les schémas JSON sont contrôlés côté interface, proxy, service et SQL ; les modifications utilisent une révision attendue pour refuser les écrasements concurrents.

Le rapport appartient à une occurrence stable. Les canaux partagent ce rapport, sans recommencer une inférence ou recalculer des résultats divergents à chaque envoi. Une requête manuelle conserve un UUID jusqu’à réception certaine ; sa répétition retrouve le reçu enregistré.

## Planification et plages horaires

Le planificateur KARTA existant vérifie les routines toutes les dix secondes lorsqu’elles sont activées. Les occurrences sont réservées en SQL et non dans un timer du navigateur. L’arrêt du runtime invalide les nouvelles admissions et attend les opérations déjà engagées.

Pour les cadences calendaires, les dates sont calculées dans le fuseau choisi. Lors d’un passage à l’heure d’été, une heure locale absente est déplacée au premier instant local valide ; lors du retour à l’heure d’hiver, une heure répétée ne crée qu’une occurrence. Une échéance dans une plage calme est déplacée à la fin de cette plage. Une date unique entièrement passée pendant une pause ne déclenche pas un rattrapage inattendu.

Les événements sont agrégés par minute UTC terminée, selon une fenêtre `[début, fin[`. Plusieurs passages du planificateur dans la même minute utilisent la même identité. La recherche d’événements porte sur toutes les lignes validées reçues, même si le rapport n’en détaille que trois. Les événements observés pendant les heures calmes ne déclenchent pas d’appel ; cette version ne constitue pas une file exhaustive d’événements différés.

Une occurrence calendaire reste transmissible pendant trente minutes ; un événement pendant quinze minutes. Un tick de plus de deux minutes n’admet pas de nouveaux bilans. Ces bornes privilégient la pertinence du contact et évitent un afflux d’anciens appels après un arrêt. Elles ne constituent pas un engagement de livraison à la seconde ou une preuve de capacité sous charge.

## Ce que le bilan prouve

Le rapport utilise les cycles du compte et, si demandé, des agents sélectionnés. La fenêtre commence après la précédente occurrence admise, dans une limite de sept jours ; sans précédente occurrence, elle couvre vingt-quatre heures ou sept jours pour une routine hebdomadaire. Les données terminées après la clôture sont reportées au bilan suivant.

Les simulations et décisions mockées sont distinguées des exécutions réelles. Un résultat `success` est présenté comme une exécution **signalée réussie** ; le résumé de l’agent ne devient pas une preuve indépendante du résultat. Les erreurs et demandes de validation sont prioritaires dans la présentation. Le nombre de lignes sources est borné à 500, avec une mention explicite si la sélection est incomplète. Les versions express, standard et détaillée montrent respectivement au plus 3, 5 et 10 éléments.

La source actuelle est le journal KARTA. Elle ne constitue pas un état exhaustif de tous les projets ONE, de SMARANA ou d’applications non raccordées. Le rapport écrit est limité à 5 000 caractères. La notification de verrouillage reste générique et renvoie vers IAO, sans exposer le détail des projets.

## Livraisons et résultats incertains

Une livraison est réservée avant l’appel externe. La SQL revérifie propriétaire, révision, activation, pause, heures calmes, préférences, arrêt global et budget. Une seconde vérification serveur précède l’envoi. Il subsiste une frontière normale : une pause ne rappelle pas un effet déjà transmis à un service externe.

| État | Sens |
| --- | --- |
| `pending` | Canal en attente de réservation |
| `sending` | Tentative réservée ; effet externe possible |
| `accepted` | Reçu du prestataire obtenu ; aucune preuve de lecture |
| `completed` | Fin technique confirmée ou message enregistré |
| `failed` | Échec déterminé |
| `unknown` | Résultat non confirmé ; aucune relance automatique |
| `skipped` | Canal non transmis, désactivé ou devenu inutile |

Un appel accepté peut encore être en file ou en train de sonner. La fin technique peut correspondre à un répondeur. Le mode de repli attend un résultat déterminé ; une fin sur répondeur permet le canal écrit suivant. Une fin signalée humaine clôt le repli, mais `heardConfirmed` reste faux : cela ne prouve pas l’écoute du bilan.

Les reçus téléphoniques sont rapprochés par GET et par webhook signé, sans nouveau POST. La signature est calculée sur les octets bruts ; les associations appel/occurrence sont rapprochées avec la réponse du fournisseur. Une transcription ne déclenche jamais une commande. L’annulation arrête les envois encore en attente ; un appel déjà transmis peut continuer et conserve ses possibilités de rapprochement terminal.

Le plafond est exprimé en minutes réservées, pas en euros : chaque tentative réserve la durée maximale choisie. Le total est partagé par compte sur le mois UTC et comparé au plafond de la routine courante. Une erreur ne provoque pas de remboursement automatique de cette réservation conservatrice. Les tarifs et coûts réels doivent être lus chez le fournisseur. Aucune tarification client ni dépense d’activation n’est créée par le code.

Un seul appel non résolu par compte est admis à la fois. Un appel dont le résultat demeure inconnu doit être rapproché avant d’en envoyer un autre. Les autres canaux indépendants peuvent aboutir. Une issue email ou push ambiguë n’est pas rejouée automatiquement.

## Demandes formulées pendant l’appel

L’outil vocal reçoit un contexte fixe signé, court et lié au compte, à la routine et à l’occurrence. Le texte de la demande est sa seule entrée conversationnelle ; la clé de déduplication est calculée par le serveur. Le serveur vérifie l’expiration avant et après les lectures lentes, le reçu de l’appel et le consentement actuel. La SQL contrôle à nouveau l’autorisation à l’insertion.

La demande est enregistrée avec l’état **`pending_confirmation`** et visible dans les réglages. Cette version n’exécute pas une tâche nouvelle depuis le téléphone : la composition de démarrage inspectée ne fournit pas encore l’autorité IAO canonique requise pour reprendre la mission avec identité, mémoire et ports de calcul. Cette autorité n’est pas remplacée par une session inventée ou par le secret du prestataire. La reprise automatique sera qualifiée avec ce raccordement canonique.

Le paramétrage de l’agent téléphonique et de son outil est détaillé dans `docs/iao-phone-agent.md`.

## Activation coordonnée

Les drapeaux restent désactivés dans l’exemple de configuration. Les étapes suivantes concernent un déploiement séparé, après réception des preuves du lot :

1. Appliquer `karta/migrations/040_iao_routines.sql` sur le schéma `purama_ai` après ses fondations existantes. Relancer le même fichier est prévu par la migration ; ne pas renuméroter les migrations d’autres lots.
2. Déployer la fonction Edge `iao-routines` avec `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `KARTA_INTERNAL_URL`, `KARTA_ADMIN_TOKEN` et l’origine HTTPS autorisée (`CORS_ALLOWED_ORIGIN` ou `APP_URL`). L’authentification applicative reste obligatoire même si `verify_jwt=false` au niveau de la passerelle.
3. Déployer KARTA avec le planificateur et les routes. Vérifier l’arrêt global, les préférences et la disponibilité de la base avant de définir `IAO_ROUTINES_ENABLED=true`.
4. Pour l’email, utiliser le service Resend déjà configuré et une adresse Auth confirmée. Pour le push, qualifier le sender VAPID existant et les abonnements avant `IAO_ROUTINES_PUSH_ENABLED=true`.
5. Pour le téléphone, configurer l’agent Bland publié, `BLAND_API_KEY`, `BLAND_AGENT_ID`, `BLAND_WEBHOOK_SECRET`, `IAO_PHONE_WEBHOOK_URL` et un `IAO_PHONE_COMMAND_SECRET` dédié d’au moins 32 caractères. Qualifier l’outil avec les cinq champs documentés, puis activer `IAO_CALLS_ENABLED`.
6. Qualifier un appel consenti vers un numéro Auth confirmé : conversation française, interruption, non-réponse, répondeur, message de repli, retour signé et demande vocale en attente de confirmation. Aucun appel réel ne peut être déclaré qualifié par les fixtures locales.

Le parcours de vérification du numéro doit être fourni par l’autorité Auth configurée. La présence d’un numéro dans un profil modifiable ne suffit pas. Cette livraison ne configure ni le prestataire OTP de Supabase ni un abonnement téléphonique payant.

L’origine autorisée doit correspondre au domaine réellement utilisé. La branche de livraison désactive ses déploiements Vercel automatiques. Aucune migration distante, publication Edge, ouverture commerciale ou activation de fournisseur n’est incluse dans une réussite CI.

## Recette reproductible

Les commandes exactes et les résultats finaux sont dans `qa/iao-calls-routines-20261128/README.md`. Les tests des fournisseurs utilisent des doubles fermés ; les tests SQL exécutent la migration et ses fonctions dans PostgreSQL/PGlite. Les tests navigateur utilisent les vrais composants, le client et les hooks, avec un service synthétique et sans requêtes externes. Les suites CI existantes restent actives ; la recette des routines est ajoutée à la CI notifications.

Sources fournisseur consultées le 28 novembre 2026 :

- [Création d’appel avec un agent](https://docs.bland.ai/api-v1/post/calls-agent)
- [Reçu et détails d’appel](https://docs.bland.ai/api-v1/get/calls-id)
- [Outils et variables fixes](https://docs.bland.ai/agents/tools)
- [Signature des webhooks](https://docs.bland.ai/tutorials/webhook-signing)
- [Webhooks de fin d’appel](https://docs.bland.ai/tutorials/post-call-webhooks)
