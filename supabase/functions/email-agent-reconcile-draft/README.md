# Rapprocher un envoi Gmail sans le répéter

Cette route authentifiée complète `email-agent-send-draft`. Elle relit une
réservation existante et recherche la preuve du message dans le compte Gmail
réservé. Elle n'effectue aucun envoi Gmail, aucune suppression de réservation
et aucune remise à zéro d'un état inconnu.

## Parcours

L'action « Vérifier le résultat dans Gmail » envoie seulement `{ log_id }` à
`email-agent-reconcile-draft`. Un identifiant de message ou une preuve fournie
par le navigateur est refusé. Les deux RPC sont privées au rôle de service ;
l'utilisateur provient du JWT vérifié, jamais du corps de la requête.

Le serveur vérifie le compte réel, le parent du message, le fil, l'expéditeur,
le destinataire unique, l'objet, le texte et les références MIME. Il exige le
label Gmail `SENT` et refuse `DRAFT`. Les mêmes contrôles MIME étroits que pour
l'envoi sont réutilisés. Les pièces jointes et formats non comparables ne sont
pas silencieusement ignorés.

- Si le reçu du POST Gmail a été conservé, son message exact est relu.
- Si ce reçu manque, le fil d'origine est parcouru dans une réponse bornée.
  Au plus cinq candidats marqués `SENT` sont lus. Un résultat incomplet, aucun
  candidat vérifié ou plusieurs correspondances conserve l'incertitude.
- Sans reçu connu, un candidat antérieur au départ enregistré n'est pas retenu
  (tolérance de cinq secondes entre horloges). La date interne d'un message
  importé peut différer de son envoi : l'absence de candidat n'est jamais une
  preuve de non-envoi.
- Un historique ne permettant plus de prouver le compte et le départ reste
  `historical_connection_unverified`. La connexion actuelle n'est pas supposée
  être celle du passé.

La confirmation signifie **message correspondant observé dans les Envoyés de
Gmail**. Elle ne prouve ni la réception ni la lecture par son destinataire, ni
l'absence d'un autre producteur de courrier.

Un état déjà confirmé rejoue son reçu durable sans une nouvelle lecture Gmail.
`provider_check_performed` distingue cette réponse de la vérification fournisseur
effectuée pendant la requête courante ; un reçu rejoué n'est pas présenté comme
une observation fraîche du contenu actuel de la boîte.

## Persistance et concurrence

Les transitions partagent le verrou propriétaire et l'ordre de verrouillage
configuration → log → réservation de l'envoi. La version de réservation et la
connexion sont relues à la finalisation. Deux confirmations concurrentes et une
confirmation concurrente de la fin d'envoi ne comptent qu'une fois. Le reçu déjà
confirmé est conservé ; un autre événement ne peut réutiliser ce même reçu.

Le log n'est marqué envoyé que si son contenu correspond encore au snapshot.
Une édition ultérieure reste un brouillon distinct, et un refus ultérieur n'est
pas transformé en approbation. `matches_current_preview: false` impose à
l'interface d'indiquer que l'ancien envoi est confirmé, sans annoncer l'envoi
du nouveau texte. La preuve conserve une empreinte du MIME et les références
nécessaires, sans dupliquer le corps du message dans un second historique.

HTTP 200 exige un reçu durable, `status: sent` et un booléen explicite
`matches_current_preview`. Les états non confirmés reçoivent 409 ; une
indisponibilité de lecture ou de stockage reste distincte. Après perte d'accusé,
une nouvelle vérification relit l'état ; elle ne renvoie jamais le courrier.

## Livraison et vérification

Appliquer dans l'ordre les migrations de réservation `20261122004000`,
d'approbation `20261122020000` et de rapprochement `20261122021000`, puis livrer
les deux routes, leur runtime commun et l'interface ensemble, après drainage
des anciennes routes. Ne pas revenir à un ancien endpoint qui ignore le
registre. Les RPC doivent être exposées par la configuration PostgREST autorisée.

Les suites du handler utilisent les migrations réelles sous PGlite et des
réponses Gmail simulées. Le harnais PostgreSQL natif charge les quatre fichiers
SQL (schéma historique inclus) et observe les verrous entre connexions distinctes.
Les résultats locaux interrompus ne constituent pas des PASS. La CI du SHA livré
est la preuve à consulter. Les scopes réels, le compte et le fournisseur restent
à qualifier dans l'environnement autorisé.

Sources du contrat fournisseur :

- [Lecture d'un message](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get)
- [Structure Message et portée de sa date interne](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages)
- [Recherche et filtrage](https://developers.google.com/workspace/gmail/api/guides/filtering)
