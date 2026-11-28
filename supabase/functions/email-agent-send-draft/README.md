# Envoi d'un brouillon approuvé : réservation durable

Cette correction borne le défaut de double envoi du seul endpoint
`email-agent-send-draft`. Elle garantit au plus une tentative HTTP d'envoi Gmail
par couple utilisateur/message entrant dans ce protocole. Elle ne promet ni une
livraison exactement une fois chez le destinataire ni une transaction distribuée
entre Gmail et PostgreSQL.

## Comportement

1. Authentifier le JWT et vérifier que le compte affiché par le client correspond
   à l'utilisateur authentifié. `action: preview` fige en base privée le compte
   expéditeur, le destinataire, le sujet, le texte intégral et les références du
   message ; l'aperçu expire après dix minutes. La lecture ne contacte pas Gmail.
   L'interface affiche cette version serveur, en texte, et non un ancien extrait
   de la liste. `action: approve` compare encore cette version au log et à la
   connexion avant d'enregistrer l'approbation sous verrou. Une modification,
   un refus reçu entre-temps, une autre identité ou un aperçu expiré bloque ce clic.
2. `action: send` exige l'identifiant de l'aperçu explicitement approuvé. Réserver
   en base une intention unique, avec un jeton de claim privé et le contenu
   approuvé. Le booléen `user_approved` seul ne permet aucun nouvel envoi. Un claim
   abandonné n'est jamais repris automatiquement. Le reçu d'un ancien envoi ne
   permet pas d'affirmer qu'un texte modifié a été envoyé.
3. Préparer le jeton OAuth sans réécrire des credentials susceptibles d'avoir
   changé entre-temps ; vérifier l'identité réelle via Gmail `users.getProfile`.
4. Pour un brouillon distant, lire son parent et son MIME brut, comparer le
   destinataire, le sujet, le texte et les références avec le snapshot du journal
   réservé, dont l'approbation versionnée et le booléen de révocation sont vérifiés.
   Refuser tout CC/BCC, pièce jointe, MIME multipart, encodage non pris en charge,
   en-tête ambigu, parent différent ou contenu modifié. Les lectures ne déclenchent
   aucun envoi.
   Sans brouillon distant, vérifier également le parent réel, son destinataire
   de réponse et son sujet, puis inclure son Message-ID dans `In-Reply-To` et sa
   chaîne de références dans `References`.
5. Faire la transition transactionnelle `preparing → sending`. Le même jeton ne
   peut gagner cette transition deux fois. Relire à cette frontière l'approbation,
   le log, la version privée de l'aperçu, son expiration, la connexion et les
   exclusions du destinataire.
6. Effectuer un unique POST Gmail. Pour un brouillon, fournir son `id` et exactement
   le `message.raw` précédemment validé ; une modification distante après GET
   ne peut ainsi substituer un autre contenu au POST. Ne pas reconstruire le MIME
   ni retirer une pièce jointe présente dans le snapshot lu : elle entraîne un
   refus. Une modification ajoutée dans Gmail après cette lecture peut être
   remplacée lors de l'envoi du snapshot ; aucune transaction ne couvre les
   modifications faites directement dans l'interface Gmail.
7. Enregistrer le reçu Gmail et le compteur dans une seule transaction. Marquer
   le log comme envoyé seulement si son contenu et son compte correspondent
   toujours au dispatch. Une modification pendant le POST conserve le nouveau
   brouillon ; une approbation retirée ou un feedback plus récent reste intact.
   Répondre HTTP 200 seulement si le reçu est effectivement persisté avec le statut
   `sent` et un booléen `matches_current_preview` calculé sous verrou.

Le client vérifie `ok`, `status: sent`, le reçu durable et la présence du booléen
`matches_current_preview`. S'il vaut `false`, l'interface confirme l'envoi du
contenu approuvé et précise que le brouillon courant est différent. Les statuts
`preparing`, `sending`, `unknown`, `blocked` et `failed` reçoivent HTTP 409,
jamais 202. Une indisponibilité avant réservation donne 503. Une nouvelle requête
sur un envoi déjà confirmé avec la même version retourne le même reçu sans
réaccéder à Gmail. Si le contenu courant diffère, elle reste bloquée ; la commande
de réconciliation peut confirmer séparément l'ancien reçu.

Un timeout, une réponse Gmail inexploitable ou une perte d'accusé SQL ne permet
jamais de renvoyer. Si Gmail a retourné un identifiant mais que la transaction
de finalisation échoue, le finaliseur peut conserver ce reçu en statut `unknown`
pour réconciliation ; cela ne déclenche pas la réussite de l'interface. Si la
transaction `sent` a réellement été committée avant la perte d'accusé, la relecture
retrouve son reçu sans doubler le compteur.

## Migration et mise en service coordonnée

Les migrations associées, dans cet ordre, sont
`20261122004000_email_agent_send_reservations.sql` puis
`20261122020000_email_agent_draft_approvals.sql`. Aucun déploiement, aucune base
réelle et aucun appel Gmail réel ne sont exécutés par cette correction.

Avant une mise en service autorisée :

1. Mettre en pause les producteurs et routes capables d'appeler l'ancienne
   version ; drainer leurs requêtes en vol. Les anciens handlers ne connaissent
   pas le ledger : une migration seule ne peut pas les rendre idempotents.
2. Sauvegarder et appliquer la migration. Le premier passage met en quarantaine
   tous les anciens brouillons et logs `auto_reply`, indépendamment de leur date.
   L'ancienne version pouvait envoyer avant de persister l'approbation : même
   `user_approved IS NULL` ne prouve pas qu'un ancien brouillon n'a jamais été envoyé.
3. Déployer ensemble le client de l'aperçu, le wrapper, le handler et la garde du
   snapshot. Le nouveau handler refuse d'envoyer si les RPC ne sont pas disponibles.
   L'ancien RPC de réservation à trois paramètres reste fermé ; les anciennes
   implémentations internes sont privées et inexécutables par le rôle de service.
   Les réservations anciennes sans version ne passent pas le nouveau `begin`.
4. Vérifier le contrat Deno et l'intégration PostgREST/auth/OAuth en environnement
   de test autorisé. Vérifier les scopes Gmail permettant les lectures du profil,
   du parent et du brouillon en plus de l'envoi.
5. Qualifier le contrat complet aperçu/approbation sur l'environnement réel,
   notamment les réponses tardives après changement de compte et les modifications
   du brouillon entre aperçu, approbation et départ. Mettre en place une réconciliation
   opérationnelle des états `unknown` et des historiques à partir des preuves Gmail,
   sans supprimer le ledger ni réimporter un log pour provoquer un nouvel essai.
   Aucune commande de réémission n'est ajoutée. L'interface distingue la commande
   explicite de vérification du résultat de celle d'un nouvel envoi ; un reçu
   correspondant à un ancien texte ne valide pas le brouillon actuel.
6. Reprendre les producteurs validés. Les nouveaux logs explicitement approuvés
   restent éligibles à une première émission ; réexécuter la migration ne les
   fait pas entrer dans le backfill historique.

Le ledger est privé au service. Les utilisateurs authentifiés ne peuvent ni le
lire ni le modifier ni appeler directement ses RPC. Il ne dépend pas d'une clé
étrangère vers les logs : supprimer/réimporter un log ne supprime pas la preuve
ou la suppression d'envoi. Ne pas revenir à l'ancien handler lors d'un rollback :
garder l'envoi suspendu et préserver le ledger.

## Vérification locale

`karta/test/emailDraftSendOnce.test.ts` exécute le vrai handler et les migrations
SQL verbatim sous PGlite, avec des fournisseurs simulés et un garde global qui
interdit le réseau réel. Il couvre les requêtes entrelacées, les pertes d'accusé
avant/après commit, les receipts manquants, les droits, l'approbation révoquée,
les changements de compte et de contenu, les historiques et le MIME non approuvé.
Les scénarios de changement ou de retrait pendant le POST vérifient que le reçu
ne réécrit pas un brouillon différent ni la dernière décision de la personne.
La concurrence des appels dans une instance PGlite ne constitue pas à elle seule
une preuve des verrous sur plusieurs connexions PostgreSQL natives.

Depuis `karta` :

```sh
node node_modules/vitest/vitest.mjs run test/emailDraftSendOnce.test.ts --maxWorkers=1 --no-cache
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

Depuis la racine :

```sh
node karta/node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --target es2022 --module esnext --moduleResolution bundler --lib es2022,dom --allowImportingTsExtensions supabase/functions/email-agent-send-draft/handler.ts
deno check supabase/functions/email-agent-send-draft/index.ts
```

Le contrôle TypeScript du handler ne remplace pas `deno check` du wrapper et de
son import Supabase distant. Les doubles de fournisseur ne prouvent ni les scopes
effectivement accordés ni une livraison réelle.

## Limites conservées

- L'approbation utilise un aperçu serveur privé et immuable, un identifiant lié
  à l'utilisateur et au log, une expiration et une comparaison transactionnelle
  avant réservation puis départ. Elle prouve la version soumise par ce client ;
  elle ne prouve pas l'attention ou la compréhension de la personne. Les clics
  concurrents, fermetures et changements de compte n'admettent pas un résultat
  d'une ancienne vue. Un effet fournisseur déjà engagé n'est pas annulable par
  le seul démontage de l'interface.
- Les brouillons approuvés mais non envoyés restent dans la liste et le compteur
  des éléments à traiter ; `user_approved=true` ne signifie pas `sent`.
- `updated_at` est une version conservatrice de la configuration. Une modification
  concomitante, même d'un compteur, peut empêcher un envoi préparé. Le refresh OAuth
  est utilisé en mémoire pour éviter de restaurer une ancienne connexion ; un
  prochain envoi peut donc devoir renouveler à nouveau son jeton.
- Après le commit `sending`, une révocation ultérieure ne peut pas annuler
  transactionnellement un appel Gmail déjà parti. La décision est contrôlée à la
  frontière précédente, sans prétendre une atomicité Gmail/PostgreSQL.
- Le support MIME est volontairement limité au texte simple comparable. Un refus
  `draft_content_unverified` exige une revue ; les pièces jointes présentes lors
  de la lecture sont refusées et le MIME lu n'est pas transformé. Le snapshot lu
  prévaut sur les modifications apportées au brouillon après cette lecture.
- Le rattachement au parent couvre cet endpoint. L'ingestion et les aperçus de
  tous les autres producteurs ne sont pas qualifiés par ces tests.
- Les horaires, quotas intercanaux, autres producteurs d'emails, appels téléphoniques
  et disponibilité 24/7 ne sont pas couverts par ce lot.

Contrat fournisseur vérifié dans les sources officielles Google :

- [Envoi et mise à jour d'un brouillon avec id et message.raw](https://developers.google.com/workspace/gmail/api/guides/drafts#send_drafts).
- [Contrat REST users.drafts.send](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/send).
