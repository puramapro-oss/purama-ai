# Résultats privés de recherche et de simulation

## Ce que ce changement rend utilisable

Les agents créés par un utilisateur peuvent déjà exécuter `knowledge_search` et
`quantum_simulate` dans KARTA. Ce lot leur ajoute un résultat consultable dans
l’interface, puis une sélection explicite pour le chat de cet agent.

Le parcours est le suivant :

1. Le propriétaire active les outils voulus et lance une mission dans son agent.
2. KARTA conserve un résultat privé après l’exécution réelle de l’un de ces deux
   outils. Cela fonctionne aussi après une approbation.
3. Dans **Runs → Résultats privés de cet agent**, le propriétaire consulte les
   20 résultats les plus récents et choisit au plus trois résultats.
4. **Poser une question avec ces résultats** ouvre le chat et place le focus dans
   la question. Le modèle n’est appelé qu’à l’envoi de cette question.
5. Le serveur recharge les résultats à partir de leurs identifiants, vérifie leur
   propriétaire et leur agent, puis les joint au seul appel de chat existant.

La sélection est réinitialisée au changement de compte, d’agent ou de session.
Un envoi réussi retire les pièces utilisées de la sélection ; un échec permet
de réessayer. Le propriétaire peut supprimer un résultat après la fin de son
opération, avec confirmation dans l’interface et confirmation du serveur.

## Stockage et provenance

La migration canonique est `karta/migrations/028_private_tool_results.sql`.
Elle crée `purama_ai.karta_tool_results` et la RPC serveur
`karta_store_tool_result`.

| Élément | Contrat |
| --- | --- |
| Identité | Propriétaire et agent déduits du run existant ; les assertions du moteur doivent correspondre. |
| Opération directe | Identifiant `run_id:index` ; nouvelle insertion seulement pendant un run réel encore ouvert. |
| Opération approuvée | Identifiant de l’action en attente ; nouvelle insertion seulement pendant son état `executing`. |
| Contenu | Projection contrôlée, version 1, au plus 64 Kio en représentation JSONB texte. |
| Idempotence | Une opération ne reçoit qu’un résultat ; un contenu JSONB identique retrouve le même identifiant. Un contenu divergent est refusé. |
| Écriture | RPC réservée au service ; ni l’utilisateur ni le service ne disposent d’un droit DML direct sur la table. |
| Lecture | Le propriétaire courant du run et de l’agent ; les résultats ne deviennent pas publics avec la fiche de l’agent. |
| Suppression | Propriétaire courant, après fin de l’opération. La fermeture empêche une nouvelle insertion après suppression. |
| Conservation | Pas de purge automatique ni de durée de conservation annoncée. Suppression par le propriétaire et cascades lors de suppression du compte, de l’agent ou du run. |

Une réponse de persistance perdue peut être réconciliée par au plus deux appels
identiques à la RPC dans une limite globale de cinq secondes. Cela ne réexécute
pas l’outil. Si la livraison reste indisponible, le moteur signale l’échec ; il
ne présente pas la mission comme réussie.

Un résultat de recherche partiel est conservé **avant** le contrôle de succès de
l’outil. Ses notices restent consultables, tandis que le statut du cycle ou de
l’approbation reste en échec. Une simulation de fonctionnement de l’agent et un
run de modèle factice ne produisent pas de résultat de recherche présenté comme
réel.

## Limites du contenu et du chat

`knowledge_search` conserve des métadonnées de Crossref et Wikidata : notices,
provenance, état de chaque source et éventuels délais de nouvelle tentative.
Les titres et extraits longs sont abrégés explicitement. Ces données ne sont
pas vérifiées, et leur conservation n’implique aucune lecture du texte intégral.
Les liens affichés sont reconstruits à partir d’un DOI ou d’un identifiant
Wikidata ; aucun HTML provenant d’un fournisseur n’est rendu.

`quantum_simulate` conserve les résultats du simulateur local classique :
probabilités, mesures simulées, paramètres bornés et provenance. Son résumé
affiche au plus 16 états de probabilité non nulle. Il ne s’agit pas d’un calcul
sur un processeur quantique physique et aucun avantage quantique n’est annoncé.

Le client transmet seulement `tool_result_ids`, au plus trois UUID distincts.
Le serveur refuse toute sélection manquante, supprimée, étrangère ou invalide.
La propriété de l’agent est revérifiée après les lectures asynchrones, avant
l’envoi des résultats au fournisseur.

Le contexte supplémentaire est un JSON borné à **16 000 octets UTF-8**. Il contient
les identifiants, statuts, résumés et références disponibles, avec des marqueurs
d’abrègement et de sources omises. Les détails complets, par exemple les tableaux
de probabilités, ne sont pas joints automatiquement au modèle. Les données sont
explicitement présentées comme non fiables, et les délimiteurs sont échappés.
Cela réduit les ambiguïtés de contexte ; ce n’est pas une garantie absolue contre
les instructions malveillantes contenues dans une source.

Le simple affichage, la sélection et la suppression n’effectuent aucun appel au
modèle. Une question avec des résultats utilise **un seul appel**, comme le chat
existant. Le contexte ajouté peut augmenter ses tokens d’entrée. Aucun nouvel
écrit automatique dans SMARANA n’est ajouté.

Les journaux KARTA, notifications et retours de file conservent leur mode
`metadata_only`. Les pièces originales ne sont pas recopiées dans les messages
ou runs du chat. En revanche, la réponse produite par le modèle est enregistrée
dans l’historique et le run du chat existants ; elle peut naturellement reprendre
des informations des résultats sélectionnés.

Les corps d’erreur du fournisseur, les erreurs de base de données et les erreurs
de transport ne sont ni renvoyés ni journalisés par le nouveau parcours de chat.
Une réponse incomplète ou arrivée après annulation n’est pas enregistrée comme
une réponse terminée.

## Correction de temporisation des sources publiques

Un `Retry-After` reçu avec HTTP 429 ou 503 est maintenant pris en compte même si
la réponse arrive à la limite du délai ou après l’expiration locale de la
requête. Le résultat reste une expiration ; le corps tardif n’est pas lu et
l’outil n’effectue pas de nouvelle tentative automatique. La porte d’admission
respecte le délai du fournisseur pour la requête suivante.

Cette protection est locale au processus. Elle ne constitue pas un quota global
Redis entre plusieurs workers. Une coordination distribuée reste à qualifier
avec un transport et une politique de réservation adaptés.

## Livraison et validation

Ordre de mise en service : appliquer les migrations de l’agent et KARTA 001–028,
puis livrer le worker KARTA, `creator-agent-chat` et l’interface provenant du
même changement. Sans la migration, le panneau signale son indisponibilité et
le moteur ne prétend pas avoir livré un résultat.

Les preuves du lot sont regroupées dans `qa/iao-private-results-20261112/`.
Les tests couvrent les deux moteurs d’exécution réels avec transports externes
simulés, le SQL exécuté sur PostgreSQL PGlite, le passage d’une projection réelle
à la RPC puis au lecteur partagé, le handler Edge et les composants de l’agent.
Une suite séparée vérifie les verrous avec plusieurs connexions sur PostgreSQL
natif dans la CI. Les statuts d’exécution, le commit et l’arbre effectivement
contrôlés doivent être lus dans le reçu de livraison ; la présence d’un test
dans le dépôt n’est pas une preuve de son exécution.

Ce lot n’effectue pas de migration de production, de déploiement, d’accès à une
base privée tierce ou de soumission à un QPU. Il ne modifie ni le routage des
modèles ni les règles d’approbation de KARTA.
