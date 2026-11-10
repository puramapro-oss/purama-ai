# Conservation et reprise des consignes KARTA

## Périmètre

Ce protocole concerne les six agents statiques pilotés par une consigne dans
`karta_agent_memory`, clé `pending_brief` : campagnes par courriel, prospection à
froid, newsletter, publicités, planification d'appels et réservation.

KARTA reste le moteur d'exécution, `karta_runs` son journal et BullMQ sa file de
livraison. `karta_brief_claims` conserve les données nécessaires à une tentative
et à sa reprise. Cette table ne remplace ni la mémoire générale, ni SMARANA, ni
le planificateur existant.

**État du parcours produit :** le code audité ne contient pas de formulaire ou
de service qui dépose effectivement cette clé depuis « Mes employés IA ».
`karta-trigger` transmet le type d'agent, sans consigne. Le présent correctif
sécurise le consommateur et sa persistance ; il ne certifie pas un parcours de
saisie utilisateur de bout en bout.

## Problème reproduit

La version de base lisait le texte puis appelait `setMemory(..., null)` pendant
`buildContext`, avant l'inférence. Le test de régression exécuté sur `1daf6314`
avec la vraie définition Newsletter et la vraie boucle montre que le texte
n'est plus disponible après une panne du modèle. Une extraction atomique par
`DELETE ... RETURNING`, déjà proposée dans PR3, évite une double lecture mais
ne suffit pas à préserver la consigne après une panne.

## Acquisition et exécution

1. Le journal ouvre un run appartenant à l'utilisateur et à l'agent. Une
   livraison déjà connue renvoie son résultat et ne prend aucune consigne.
2. Pour une définition avec `pendingBriefKey`, un run réel appelle
   `karta_claim_pending_brief`. Le RPC verrouille le run, vérifie son identité,
   son mode et son état, puis reprend un reçu disponible ou déplace le texte
   de la mémoire vers un reçu privé dans **une même transaction**.
3. Les lectures concurrentes utilisent des verrous de lignes. Une relecture
   après perte de réponse retourne le même reçu pour le même run ; elle ne
   prend pas une deuxième consigne.
4. En simulation, `karta_peek_pending_brief` lit un aperçu sans réservation,
   suppression ni tentative supplémentaire. Sans consigne, la boucle se
   termine en `skipped` sans appeler le modèle.
5. Le contexte reçoit le texte préparé dans son troisième argument. Le
   constructeur de contexte ne lit ni ne supprime lui-même la mémoire. Un
   champ similaire dans le déclencheur ne vaut pas acquisition.
6. Avant un premier outil réel ou la création d'une approbation,
   `karta_arm_pending_brief` enregistre `effect_started`. Le moteur vérifie de
   nouveau les arrêts et le niveau d'autonomie après cette attente.
7. Le déclencheur SQL de clôture règle le reçu **dans la transaction qui ferme
   le run**. Il n'existe pas de seconde écriture de restitution susceptible
   d'écraser une nouvelle consigne.

Chaque RPC du client possède au plus deux tentatives avec les mêmes arguments.
Ces tentatives de transport ne représentent pas deux traitements métier. Les
erreurs publiques ne reprennent ni texte SQL, ni contenu de consigne.

## États et conséquences

| État du reçu | Signification | Acquisition par un nouveau run |
|---|---|---|
| `claimed` | Texte réservé, aucune barrière d'effet confirmée | Interdite tant que le run n'est pas clos |
| `ready` | Run clos sans effet possible selon le protocole | Autorisée, en priorité sur un nouveau texte en mémoire |
| `transferred` | Le reçu suivant possède la consigne ; lien vers ce run conservé | Interdite sur cet ancien reçu |
| `effect_started` | Un effet ou une approbation peut commencer, ou son accusé est incertain | Interdite |
| `awaiting_approval` | Une approbation durable est en attente | Interdite ; résolution par le chemin d'approbation existant |
| `completed` | Run réel clos avec des actions exécutées et aucune approbation non exécutée | Interdite |
| `reconciliation_required` | Effet incertain, traitement partiel, trace incohérente ou limite atteinte | Interdite ; vérification requise |

Une erreur d'inférence, un arrêt avant la barrière, une décision mock ou une
décision sans outil conservent le texte. Un cycle réel sans action proposée est
`skipped`, et ne présente pas la mission comme réussie.

Une barrière enregistrée empêche la remise automatique de la consigne en
attente. Le retour à `ready` exige que la transaction de clôture constate
l'absence de barrière et de toute approbation ; un armement retardé ne peut
ensuite passer sur ce run déjà clos. Une erreur réseau seule ne prouve donc
jamais que la consigne peut être libérée. Un processus interrompu sans clôture
reste réservé : aucune expiration ne permet de rejouer aveuglément un effet.
L'état `completed` atteste le protocole et les
résultats des outils du cycle ; il ne prouve pas à lui seul la qualité du
contenu produit ou l'accomplissement de toute l'intention métier.

### Limite des reprises

Une même consigne peut être acquise par **trois runs réels au maximum**. Au
troisième run clos sans action, elle reste conservée en
`reconciliation_required`. Cette borne évite qu'une consigne durablement
inexploitable entraîne une inférence à chaque passage du planificateur ; les
agents de rendez-vous sont planifiés toutes les quinze minutes dans la base
auditée.

Les deux tentatives réseau d'un même RPC ne consomment pas deux acquisitions.
La simulation par aperçu n'en consomme aucune. Une décision mock découverte
après une acquisition réelle compte comme cette acquisition, tout en
conservant la consigne et en interdisant tout effet. Les autres consignes
restent indépendantes de cette limite.

### Approbations

La création d'une approbation constitue déjà une opération durable. Une réponse
perdue ne permet donc pas de créer automatiquement une seconde approbation,
y compris pour les agents sans `pendingBriefKey`.

La migration `019_karta_approval_parent_guard.sql` exige aussi, avant
l'admission, un parent correctement lié et une entrée de journal unique pour
l'action, son outil et son état `pending`. Une approbation orpheline, par
exemple après une réponse d'insertion perdue, est ainsi refusée **avant** un
effet plutôt que seulement lors de sa finalisation. Les charges utiles restent
intactes pour la réconciliation. Un journal issu d'une simulation ou d'un mock
n'autorise pas une action réelle ; le rejet d'une entrée valide reste possible.

La résolution d'une approbation peut faire évoluer le reçu vers `completed` si
la totalité des actions journalisées est exécutée. Si le cycle comporte des
actions différées ou un résultat partiel, le texte reste à réconcilier. Ce
correctif ne transforme pas une approbation en reprise automatique du reste de
la mission.

## Confidentialité et autorisations

Les RPC vérifient l'association run/utilisateur/agent, l'état actif et le mode.
Ils sont exécutables par `service_role` seulement, avec `SECURITY INVOKER` et
un `search_path` fixé. Les rôles `anon` et `authenticated` ne peuvent lire ni
modifier la table de reçus, même lorsqu'ils connaissent un identifiant.

Le texte brut reste dans le stockage privé de travail. Il n'est ajouté ni à
`input_summary`, ni à une autre colonne de `karta_runs`. Tout cycle à consigne
active la politique de traces minimales existante, y compris pour les erreurs,
notifications, paramètres des outils et résultats historiques renvoyés.
Les charges utiles nécessaires aux outils et aux approbations restent intactes.

Les reçus conservent le texte pour les vérifications et les reprises ; ce lot
n'ajoute pas de purge périodique ou d'interface d'administration des reçus.
Les consignes déjà supprimées par un ancien worker ne sont pas reconstruites.

## Mise en service

La migration `018_karta_brief_claims.sql` dépend des tables KARTA existantes,
dont `karta_runs`, `karta_agent_memory` et `karta_pending_actions`. La migration
019 complète le contrôle d'admission des approbations de la migration 006.

1. Suspendre les déclenchements et terminer ou réconcilier les runs en cours.
2. Arrêter les anciens workers qui utilisent la lecture puis suppression.
   Ils ne participent pas au nouveau protocole de réservation et ne doivent
   pas coexister avec lui sur les mêmes consignes.
3. Appliquer les migrations 018 et 019 et vérifier les fonctions, droits et déclencheur
   dans l'environnement cible.
4. Déployer les workers de cette révision, vérifier un cycle en environnement
   de test, puis reprendre les déclenchements.

Si le RPC ou la migration manque, le cycle échoue avant l'inférence et avant
les outils. Un retour à l'ancien worker nécessite d'abord la réconciliation
des reçus ; ne pas supprimer leur table pour rendre les consignes disponibles.

## Vérifications

Les tests couvrent la vraie boucle et les six définitions, les réponses perdues
des RPC, les transitions SQL, les permissions, les interruptions et les
approbations. Le reçu de campagne dans `test/evidence` précise les commandes,
comptes de tests, empreintes et limites réellement vérifiés.

PGlite exécute les instructions PostgreSQL et les déclencheurs dans les tests.
Il ne remplace pas un essai de charge avec plusieurs connexions PostgreSQL,
plusieurs workers BullMQ et les fournisseurs réels. Aucun déploiement, appel
payant ou niveau de performance en production n'est attesté par ces tests.

Références : [verrous de lignes PostgreSQL](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)
et [transaction des déclencheurs](https://www.postgresql.org/docs/current/trigger-definition.html).
