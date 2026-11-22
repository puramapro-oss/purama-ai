# Agenda des appels : instants et connexion Calendar

## Périmètre reçu

Le chemin existant `planificateur-d-appels → calendar_create_event` crée un
événement Google Calendar. Ce lot corrige ses instants et son raccord OAuth ; il
n'émet aucun appel téléphonique et n'ajoute aucun opérateur ni moteur parallèle.

La base locale est `d1d2f732ab07630c53e79fa3989346a6753e2eb9`, arbre
`7eaa1db545956e18b47e2bff3017287cb3d15dd2`, identique à la PR86 publiée sur
`25fc534db7b4e794e0fc826f000a70dbee1a9088`.

## Défauts corrigés

- Une date sans décalage, une date normalisée par `Date.parse` ou un décalage
  inconnu ne peut plus être transmis implicitement au fournisseur. Le contrat
  accepte les secondes et au plus trois chiffres de fraction, sans seconde
  intercalaire ni heure `24:00:00`.
- Le planificateur d'appels exige un fuseau IANA explicite. Les champs d'heure
  locale et le décalage doivent correspondre à ce fuseau aux deux bornes. Une
  heure sautée au changement d'heure est refusée ; une heure répétée doit être
  désambiguïsée par son décalage. Aucun décalage n'est choisi automatiquement.
- Le début d'un rendez-vous d'appel doit rester futur avant préparation et juste
  avant le POST, après OAuth et la relecture de connexion. Un créneau dépassé
  exige une nouvelle planification ; il n'est pas déplacé automatiquement.
- Les paramètres scalaires validés sont copiés avant les attentes. Une mutation
  de l'objet appelant ne remplace pas le créneau ou l'invité envoyé.
- L'outil utilisait le jeton `email_agent_config`, alors que le consentement Gmail
  ne demande pas Calendar. Il utilise maintenant la connexion existante
  `user_connections(provider=google_calendar)` créée par `oauth-google`, sans
  nouveau consentement, nouveau stockage ou augmentation des permissions.
- Le renouvellement reprend les paramètres et le contrôle de version de la
  connexion canonique : propriétaire, fournisseur, identifiant, refresh token et
  `updated_at`. Une révocation ou reconnexion concurrente empêche la persistance
  de l'ancien accès. Le reçu écrit et la connexion sont contrôlés avant l'effet.
- Lectures de connexion et requêtes Google bornées à 15 secondes par opération ;
  réponses limitées à 64 Kio avant décodage, redirections refusées, flux annulé au
  délai et corps d'erreur fournisseur non recopié dans les exceptions.

L'identifiant d'événement dérivé de l'opération, le chemin de relecture après
409 et la correction des adresses d'invités de PR86 sont conservés. Les rendez-vous
génériques restent possibles sans fuseau nommé si leur instant possède un décalage
explicite. Les contraintes de retard propres aux appels ne bloquent pas un
enregistrement historique générique.

## Vérification exécutée

- Avant correction des dates : **38 tests, 26 échecs reproduits, 12 réussites**.
- Composition finale du lot : **134/134 tests, cinq fichiers, zéro test en attente**.
- TypeScript KARTA complet : **PASS, code 0**.
- Lint ciblé : **six fichiers, zéro erreur, zéro avertissement, zéro suppression**.
- Aucun calendrier, email, appel ou connexion OAuth réel n'a été créé. Les
  transports et le stockage sont doublés dans les tests ; les conditions SQL du
  renouvellement sont vérifiées dans les appels au client, sans preuve de
  concurrence PostgreSQL native supplémentaire.

Depuis `karta` :

```sh
node node_modules/vitest/vitest.mjs run test/calendarTool.test.ts test/calendarSchedule.test.ts test/googleCalendarConnection.test.ts test/actionAgentsMock.test.ts test/loopBriefLifecycle.test.ts --maxWorkers=1 --no-cache
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

GitNexus : reconstruction exacte arrêtée avec code 1 avant graphe exploitable.
L'index historique `812830f` est réutilisé à son emplacement d'origine ; les
impacts de l'exécution calendrier et du rôle sont **UNKNOWN**, aucun flux résolu
ne prouve l'absence de consommateur. Les consommateurs connus comprennent le
planificateur, la réservation intelligente et le registre d'outils personnalisés.
Les nouveaux validateurs et le raccord Calendar sont hors graphe. Le clone garde
les métadonnées d'origine de sa copie d'index. Les commandes `detect_changes`
préparée et contre `main` ont été exécutées et refusées car le clone n'est pas
enregistré ; aucun résultat PASS n'en est déduit. La composition doit refaire
le contrôle d'impact sur son dépôt.

## Limites avant exploitation

- Le fuseau doit venir de la demande autorisée. Son format et son accord avec
  l'instant sont vérifiés ; cette validation ne prouve pas à elle seule sa
  provenance métier.
- L'admission opérateur, les consentements et oppositions téléphoniques, les
  quotas partagés, les jours fériés et les plages légales restent distincts de
  la création d'un événement. Aucun de ces contrôles n'est déclaré implémenté
  chez un opérateur par ce lot.
- La connexion historique ne possède pas d'identifiant de sujet Google. Les
  tests de mauvais compte portent sur le propriétaire PURAMA et le fournisseur ;
  l'identité Google réellement consentie et les permissions effectives restent
  à qualifier avec l'intégration OAuth existante.
- Une révocation après la dernière relecture ne peut pas annuler atomiquement
  un effet Google déjà engagé. Une requête peut arriver chez Google après l'heure
  vérifiée localement. Ces contrôles ne garantissent pas l'heure d'un appel réel.
- Une reprise après le début du créneau est refusée pour le planificateur ; elle
  nécessite de rapprocher l'événement existant ou de convenir d'un autre créneau,
  sans créer automatiquement un événement tardif.
- Le déploiement coordonné, les scopes effectivement accordés, la disponibilité
  continue et la réception de l'invitation sont **NON TESTÉS** sur comptes réels.

Sources officielles : [événements Calendar](https://developers.google.com/workspace/calendar/api/v3/reference/events),
[insertion](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert),
[renouvellement OAuth Google](https://developers.google.com/identity/protocols/oauth2/web-server#offline).
