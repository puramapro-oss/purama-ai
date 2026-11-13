# IAO : modèle choisi, réflexion, vitesse et recherche connectée

Réception initiale du 12 novembre, raccordement R2 du 13 novembre 2026.
**PASS pour le code et la qualification locale décrite ci-dessous ; PARTIEL pour la mise en service.**
Cette contribution prolonge la sélection de compétences CHEF de la PR68, elle-même
basée sur la consolidation PR45. Elle ne remplace ni KARTA, ni son registre de
capacités, ni SMARANA, ni les autorisations et budgets existants.

## Besoin et continuité

La vidéo fournie présente Perplexity, Firecrawl et Bloxks. Elle exprime le besoin
de recherche, de lecture de pages et de création d'applications ; ses affirmations
commerciales ne sont pas une mesure de performance. Le canon PURAMA v109 a été
rapproché : comparaison de modèles du 20 octobre, choix de compétences PR68,
séparation des ressources personnelles/client et réception technique R5.

La sélection de compétences et les outils Tavily/Crossref/Wikidata existent déjà.
Le client Messages, les mécanismes d'annulation et les reçus d'usage sont réutilisés.
La PR71 LM Studio reste un candidat distinct, non recopié ici.

## Correction intégrée à l'exécution des agents

Le choix `creator_agents.model` était enregistré et utilisé par le chat de l'agent,
mais pas chargé dans sa définition KARTA. KARTA pouvait donc choisir son modèle
principal, même si la personne en avait choisi un autre. Le chargement récupère
désormais ce choix et le revalide avec la définition autorisée avant l'inférence.
Les données métier et les textes reçus ne deviennent pas des préférences serveur.

Les préférences `execution_preferences` sont conservées dans la même ligne d'agent,
avec une contrainte SQL. Les contrôles de sa page de réglages concernent l'exécution
de ses tâches. **Ils ne modifient pas le chat textuel Edge ni le chat principal.**
La migration et le runtime doivent être livrés ensemble ; la migration n'est pas
appliquée en production par cette contribution. `temperature` et `max_tokens`
historiques ne sont pas réinterprétés comme des autorisations.

## Trois choix séparés

| Choix | Effet réel dans ce code |
|---|---|
| Modèle | Identifiant exact qualifié par l'hôte ; aucune substitution silencieuse. |
| Réflexion | Standard, approfondie ou maximum du modèle qualifié ; Auto utilise actuellement Standard. |
| Vitesse | Limite le temps d'attente et, pour la consultation, l'étendue des recherches et des avis. |

La vitesse ne remplace pas le modèle et ne diminue pas un effort explicitement
choisi. « Maximum + ultra rapide » conserve l'effort maximum avec un délai plus
court : cela peut se terminer sans réponse exploitable. Aucun temps de réponse,
classement de modèles, absence de bug ou qualité universelle n'est promis.

Le plan indique le modèle, l'effort effectif, le plafond de sortie, le délai et les
plafonds de consultation. Maximum signifie le plus haut effort **qualifié pour
ce modèle**, pas systématiquement le paramètre fournisseur `max`. Le budget manuel
laisse au moins 1024 tokens de sortie et respecte le plafond de sortie de l'hôte.
Un modèle sans réflexion approfondie qualifiée refuse ce réglage.

Le client copie le catalogue à sa construction et la notification de plan ne peut
pas modifier sa requête. Une réponse déclarant un autre modèle que celui demandé
est rejetée avant toute action ; son reçu d'usage est conservé. Les alias doivent
donc être qualifiés avec les identifiants effectivement renvoyés par le fournisseur.

## Catalogue de l'hôte

Sans `KARTA_MODEL_PROFILES_JSON`, seuls les identifiants MAIN/FAST déjà configurés
sont admis, avec le plafond historique de 1024 tokens et sans nouveau mode de
réflexion. Une configuration explicite fournit les capacités exactes du transport :

```json
[
  {
    "model": "identifiant-exact-qualifie",
    "reasoning": "adaptive",
    "maxOutputTokens": 16384,
    "effortLevels": ["low", "medium", "high"]
  }
]
```

Exemple de forme uniquement, pas une configuration active. Modes disponibles :
`none`, `budget` et `adaptive`. La qualification doit vérifier le contrat, le
modèle renvoyé, la qualité, les coûts et la compatibilité de l'instance. Le choix
historique Sonnet 4 de l'interface n'est pas ajouté implicitement au catalogue
MAIN actuel : le qualifier ou proposer un modèle disponible. Aucun alias ancien
n'est remplacé silencieusement.

Le catalogue n'est ni un contrat d'abonnement, ni une réservation de dépense, ni
une autorisation de partage. Les quotas de période et l'absence de dégradation
artificielle par abonnement restent inchangés. Les contrôles réels de ressources
et de budget par compte doivent être qualifiés avant ouverture des nouveaux modes.

## Connexions de recherche

`createConnectedResearchClient` ajoute deux transports facultatifs : Search API
Perplexity et Scrape API Firecrawl. Origines fixes, clés distinctes fournies par
l'hôte, absence de relance automatique, délais et corps bornés, contrôle des URL,
réponses malformées refusées et erreurs minimisées. Un transport encore actif
après expiration garde son verrou local jusqu'à sa fin. Ce verrou n'est pas une
limite globale entre processus.

Les extraits de recherche et les pages markdown sont distingués. Les résultats
gardent leurs références et dates de récupération ; ils sont non vérifiés et leur
coût facturé reste inconnu. Aucun secret n'est placé dans les prompts ou résultats.
Le contrôle d'URL est syntaxique. Il ne confine ni les résolutions DNS ni les
redirections opérées à distance par Firecrawl. Un changement d'URL déclaré est
détecté après récupération ; ce n'est pas une prévention distante garantie.

Aucun compte ni clé réelle n’a été créé. Lors de R2, un test réel minimal du compte
Anthropic existant a été tenté : requête refusée pour crédit insuffisant, sans relance.
Les deux services de recherche restent NON TESTÉS sur des comptes réels. Bloxks reste une référence de produit : sa documentation examinée
décrit des intégrations dans les applications créées, sans fournir dans ces pages
un contrat vérifié permettant à IAO de piloter son créateur. Aucun faux connecteur
Bloxks n'est déclaré disponible.

## Consultation entre modèles

`runModelConsultation` exécute une tâche bornée : recherches publiques explicitement
demandées, propositions indépendantes, critiques si le profil l'autorise, puis
synthèse par le modèle principal choisi. Les modèles consultés forment une liste
exacte ; aucun compte ou modèle supplémentaire n'est sélectionné à l'insu du demandeur.
Des implémentations de `ClaudeClient` peuvent fournir les routes compatibles ;
cela ne livre pas des adaptateurs natifs OpenAI/Gemini ni ne qualifie leurs comptes.

Chaque appel a une réservation et un reçu distinct, y compris en cas d'échec ou
d'incertitude. Le client exige trois ports serveur : `claim`, `reserve`, `settle`.
Ils doivent utiliser le registre durable existant, avec identité réelle, unicité,
permissions, destinations, droits de partage, budget complet et rapprochement.
Une fonction retournant simplement `true` ne constitue pas une implémentation de
production. Aucune autorisation n'est tirée du texte d'un modèle.

Les modèles ne reçoivent aucun outil exécutable dans cette consultation. Les avis
ne sont pas des décisions d'action. La synthèse est un objet validé : réponse,
références de sources présentes, désaccords et incertitudes. Des références
inventées sont rejetées ; cela ne prouve pas que les sources étayent chaque phrase.
Un accord entre modèles n'est jamais promu en preuve.

Les sources sont projetées par liste de champs, les titres/extraits sont bornés,
le texte total des extraits est limité à 32000 caractères et le contexte JSON
complet à 256 Kio. Les abrégements sont indiqués. Ces limites ne remplacent pas
la mesure du tokenizer ou du contexte du modèle. Une requête modifiée pendant
l'attente n'altère pas la copie acceptée. L'annulation bloque les appels suivants ;
les coûts d'une requête déjà partie ne sont pas présumés nuls. Le résultat retourné
est une copie stable et la reprise automatique n'est pas effectuée.

## Raccordement R2 au chat et au registre durable

Le widget global conserve sa conversation publique. Un panneau **Consultation IA**
est ajouté pour les comptes authentifiés non anonymes. Il charge le catalogue du
serveur et propose seulement les combinaisons modèle/réflexion/vitesse réellement
qualifiées. Le changement de profil ne retire aucun avis ou recherche à l’insu de
l’utilisateur : les sélections incompatibles sont signalées avant l’envoi.

Le proxy Edge `iao-consultation` vérifie le JWT avec `auth.getUser`, impose l’identité
obtenue, puis appelle l’API interne KARTA avec son jeton serveur. Aucun identifiant
de propriétaire, montant, clé ou URL de fournisseur ne vient du navigateur. Les
quatre actions sont `catalog`, `consult`, `status`, `cancel`. La requête est limitée
à 64 Kio et la réponse à 512 Kio UTF-8 avant décodage. Les résultats privés portent
`Cache-Control: no-store, private` et ne contiennent pas les reçus ni les paramètres
fournisseur. Les délais couvrent le corps complet, les erreurs sont minimisées.

Le catalogue est l’intersection entre la politique opérateur et les modèles actifs
renvoyés par le compte Anthropic. Les capacités de réflexion sont lues dans cette
réponse, sans les déduire du nom. Le SDK de consultation est attaché à la même clé
et à l’origine native Anthropic ; une variable de passerelle ambiante ne peut pas
changer cette destination. Les autres usages du client compatible restent inchangés.
Un catalogue accessible ne prouve pas que le crédit d’inférence est suffisant.

La migration **031** étend les ressources CHEF existantes avec des missions de type
`consultation`, sans dépôt ni identifiant de brief fictif. La clôture des missions
de code ne peut pas fermer une allocation de consultation encore vide. Les tâches
correspondantes ne peuvent pas entrer
dans les workers de développement. Les réservations et les usages restent dans
`chef_budget_reservations` et `chef_usage_events` ; les nouvelles tables privées
conservent demandes, résultats, annulations et reçus, sans second portefeuille.
L’ancien parcours de mission de code est testé après application de cette migration.

L’allocation est explicite, finie, datée et réservée au rôle de service via
`model_consultation_provision`. Un changement de montant ou de période ne réinitialise
pas une allocation existante. Aucun forfait, paiement ou quota client n’est inventé.
Chaque opération réserve son enveloppe complète sous verrou ; chaque sous-appel
vérifie son unicité, son estimation, l’arrêt global et l’annulation avant de partir.
Les verrous sérialisent aussi annulation et création quand ces demandes se croisent.

La réponse reste disponible quand le coût facturé est encore inconnu. Les compteurs
reçus sont rapprochés avec les totaux CHEF ; le coût inconnu garde sa réservation.
`model_consultation_reconcile`, réservé au service, permet ensuite un rapprochement
opérateur/fournisseur avec preuve et identifiant idempotent. Une estimation ne devient
jamais une facture. Une dépense constatée supérieure au budget suspend les admissions.

Le navigateur conserve seulement l’UUID de l’opération par compte dans la session.
La reprise demande son état sans retransmettre la question ni relancer une inférence.
Un changement de compte invalide les requêtes d’affichage. L’annulation est durable,
y compris avant une création retardée ; une perte réseau ne vaut pas confirmation
que rien n’a été consommé. Une opération interrompue après expiration reste à
rapprocher et n’est pas automatiquement réexécutée.

Les extraits persistés sont bornés en octets JSON avant sauvegarde : texte cumulé
16 Kio, maximum 2 Kio par source, titre 128 octets encodés. Les abrégements sont
signalés. La réponse complète, les identifiants cités, les URL canoniques et les
reçus privés sont conservés. Les liens restent limités à 8192 caractères après
canonicalisation. Les modèles reçoivent au plus 32 000 caractères d’extraits, dans
un contexte également borné par l’enveloppe opérateur ; ces plafonds sont distincts.

## Configuration et conditions de mise en service

L’hôte attend `KARTA_CONSULTATION_POLICY_JSON`, objet strict contenant `version`,
`expiresAt` et `models`. Chaque modèle contient son identifiant exact, `maxInputTokens`,
`maxOutputTokens` et `maxCostMicros`. Les deux plafonds facultatifs de recherche sont
`research.searchMaxCostMicros` et `research.scrapeMaxCostMicros`. Les estimations par
appel doivent être qualifiées pour le compte et la période ; aucun prix ni budget
par défaut n’est généré par ce lot. Une politique expirée ferme les nouvelles admissions.

L’Edge réutilise `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `KARTA_INTERNAL_URL` et
`KARTA_ADMIN_TOKEN`. KARTA utilise sa connexion Supabase de service, le compte
Anthropic existant et, seulement lorsqu’elles sont configurées, les clés distinctes
`PERPLEXITY_API_KEY` et `FIRECRAWL_API_KEY`. Une clé de recherche sans plafond
qualifié ne rend pas le service disponible. Aucun secret ne passe dans le catalogue.

L’ouverture demande la livraison coordonnée de la migration, de l’API, de l’Edge et
du site, une allocation opérateur réelle par compte et un fournisseur financé. Le
mode global `KARTA_MOCK_CLAUDE=true` bloque ce nouveau parcours réel ; il n’a pas été
modifié sur le Mac. Son éventuel basculement doit tenir compte des tâches déjà actives.
Les essais de qualification ne provisionnent aucune ressource de production.

## Qualification et limites

Les résultats frais, commandes et versions figurent dans
`qa/adaptive-intelligence-20261112/verification.json` pour R1 et
`qa/consultation-integration-20261113/verification.json` pour R2. Les essais utilisent les
implémentations produit avec réseau, identité ou SQL de test selon leur portée.
Les essais HTTP natifs utilisent des sockets locaux, pas les services externes.
Les assertions du SDK vérifient les requêtes sérialisées, pas la prise en charge
effective des paramètres par un compte fournisseur.

Les deux appels de statut MacDevBridge ont échoué à la lecture initiale. Un autre
accès a ensuite permis une inspection en lecture seule du Mac : le dépôt
`purama-ai` est sur `main` et ne contient pas ce nouveau profil. Les noms de clés
Anthropic sont présents dans `karta/.env` ; aucun nom de clé Perplexity/Firecrawl
n'est déclaré dans les deux fichiers `.env` examinés. Cela ne prouve pas l’absence de clés ailleurs. Lors de R2,
la liste officielle des modèles Anthropic a répondu HTTP 200 ; les modèles MAIN/FAST
configurés sont actifs. Une inférence minimale sur FAST (16 tokens de sortie maximum,
texte public) a répondu HTTP 400 pour crédit insuffisant. La clé est reconnue mais
l’inférence réelle reste BLOQUÉE ; ni achat de crédit ni relance n’a été effectué. Aucun secret n'a été affiché.
Aucun déploiement Hostinger, basculement de données ou changement de configuration
personnelle n'est revendiqué. La branche désactive son déploiement Vercel.
La publication en PR ne signifie pas fusion ou service actif.

## Sources officielles examinées

- [Perplexity Search API](https://docs.perplexity.ai/api-reference/search-post)
- [Perplexity MCP](https://docs.perplexity.ai/guides/mcp-server)
- [Firecrawl Scrape](https://docs.firecrawl.dev/api-reference/endpoint/scrape)
- [Firecrawl MCP](https://docs.firecrawl.dev/mcp-server)
- [Claude : catalogue et capacités des modèles](https://platform.claude.com/docs/en/api/models)
- [Claude : compatibilité des modes de réflexion](https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting)
- [Claude : réflexion avec budget](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
- [Bloxks : documentation des intégrations](https://bloxks.app/docs/integrations)

Ces sources décrivent leurs contrats, pas la qualification de l'intégration PURAMA.
