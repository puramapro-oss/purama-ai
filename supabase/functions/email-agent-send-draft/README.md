# Envoi d'un brouillon approuvé : réservation durable

Cette correction borne le défaut de double envoi du seul endpoint
`email-agent-send-draft`. Elle garantit au plus une tentative HTTP d'envoi Gmail
par couple utilisateur/message entrant dans ce protocole. Elle ne promet ni une
livraison exactement une fois chez le destinataire ni une transaction distribuée
entre Gmail et PostgreSQL.

## Comportement

1. Authentifier le JWT et retrouver le log appartenant à l'utilisateur.
2. Réserver en base une intention unique, avec un jeton de claim privé et le
   contenu du log. Un claim abandonné n'est jamais repris automatiquement.
3. Préparer le jeton OAuth sans réécrire des credentials susceptibles d'avoir
   changé entre-temps ; vérifier l'identité réelle via Gmail `users.getProfile`.
4. Pour un brouillon distant, lire son parent et son MIME brut, comparer le
   destinataire, le sujet, le texte et les références avec le snapshot du journal
   réservé, dont le booléen d'approbation doit être vrai.
   Refuser tout CC/BCC, pièce jointe, MIME multipart, encodage non pris en charge,
   en-tête ambigu, parent différent ou contenu modifié. Les lectures ne déclenchent
   aucun envoi.
   Sans brouillon distant, vérifier également le parent réel, son destinataire
   de réponse et son sujet, puis inclure son Message-ID dans `In-Reply-To` et sa
   chaîne de références dans `References`.
5. Faire la transition transactionnelle `preparing → sending`. Le même jeton ne
   peut gagner cette transition deux fois. Relire à cette frontière l'approbation,
   le log, la connexion et les exclusions du destinataire.
6. Effectuer un unique POST Gmail. Pour un brouillon, fournir son `id` et exactement
   le `message.raw` précédemment validé ; une modification distante après GET
   ne peut ainsi substituer un autre contenu au POST. Ne pas reconstruire le MIME
   ni retirer une pièce jointe présente dans le snapshot lu : elle entraîne un
   refus. Une modification ajoutée dans Gmail après cette lecture peut être
   remplacée lors de l'envoi du snapshot ; aucune transaction ne couvre les
   modifications faites directement dans l'interface Gmail.
7. Enregistrer le reçu Gmail, le statut du log et le compteur dans une seule
   transaction. Répondre HTTP 200 seulement si le reçu est effectivement persisté
   avec le statut `sent`.

L'interface existante considère toute réponse 2xx comme « envoyé ». Les statuts
`preparing`, `sending`, `unknown`, `blocked` et `failed` reçoivent donc HTTP 409,
jamais 202. Une indisponibilité avant réservation donne 503. Une nouvelle requête
sur un envoi déjà confirmé retourne le même reçu sans réaccéder à Gmail.

Un timeout, une réponse Gmail inexploitable ou une perte d'accusé SQL ne permet
jamais de renvoyer. Si Gmail a retourné un identifiant mais que la transaction
de finalisation échoue, le finaliseur peut conserver ce reçu en statut `unknown`
pour réconciliation ; cela ne déclenche pas la réussite de l'interface. Si la
transaction `sent` a réellement été committée avant la perte d'accusé, la relecture
retrouve son reçu sans doubler le compteur.

## Migration et mise en service coordonnée

La migration associée est
`20261122004000_email_agent_send_reservations.sql`. Aucun déploiement, aucune base
réelle et aucun appel Gmail réel ne sont exécutés par cette correction.

Avant une mise en service autorisée :

1. Mettre en pause les producteurs et routes capables d'appeler l'ancienne
   version ; drainer leurs requêtes en vol. Les anciens handlers ne connaissent
   pas le ledger : une migration seule ne peut pas les rendre idempotents.
2. Sauvegarder et appliquer la migration. Le premier passage met en quarantaine
   tous les anciens brouillons et logs `auto_reply`, indépendamment de leur date.
   L'ancienne version pouvait envoyer avant de persister l'approbation : même
   `user_approved IS NULL` ne prouve pas qu'un ancien brouillon n'a jamais été envoyé.
3. Déployer ensemble le wrapper, le handler et la garde du snapshot. Le nouveau
   handler refuse d'envoyer si les RPC ne sont pas disponibles.
4. Vérifier le contrat Deno et l'intégration PostgREST/auth/OAuth en environnement
   de test autorisé. Vérifier les scopes Gmail permettant les lectures du profil,
   du parent et du brouillon en plus de l'envoi.
5. Avant de qualifier l'envoi en production, versionner l'aperçu et l'approbation
   dans l'interface : le booléen existant ne prouve pas que le snapshot réservé
   était exactement le contenu affiché au moment du clic. Cette correction ne
   modifie pas ce contrat UI. Mettre également en place une réconciliation
   opérationnelle des états `unknown` et des historiques à partir des preuves Gmail,
   sans supprimer le ledger ni réimporter un log pour provoquer un nouvel essai.
   Cette correction n'ajoute aucune commande de reprise ou de réémission.
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

- L'approbation UI est un booléen non versionné. La garde compare le MIME avec
  le snapshot du journal réservé, puis le revalide avant `begin`. Elle ne lie
  pas cryptographiquement ou transactionnellement ce snapshot à l'aperçu vu
  par l'utilisateur. Versionner cette approbation et définir la réconciliation
  opérationnelle sont des gates explicites avant production.
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
