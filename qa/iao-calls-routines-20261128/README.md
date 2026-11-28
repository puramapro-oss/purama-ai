# Réception des appels et routines IAO — 28 novembre 2026

Base : `f95c4f472621fbf0335763b594add58d79175195` (PR128, qui conserve PR126).
Branche : `feat/iao-calls-routines-20261128-3eae`. Périmètre approuvé : `scope.json`.

## Résultat avant publication

| Contrôle | Résultat | Preuve |
| --- | --- | --- |
| Serveur, transports, horaires, proxy et régressions KARTA ciblées | PASS — 489 tests, 17 fichiers | `karta-tests-final.log` |
| SQL 040 dans PostgreSQL/PGlite | PASS — 38 cas, inclus dans les 489 | `sql-final.log` et suite finale |
| React/client, notifications et déclenchement personnalisé | PASS — 104 tests, 4 fichiers | `frontend-tests-final.log` |
| Déclenchement Node et autorisations chat | PASS — 115 tests | `trigger-after.log` |
| Routines dans Chromium, vrais composants/hooks | PASS — 8 scénarios | `browser/results.json` |
| Régression notifications dans Chromium | PASS — 12 scénarios, 0 erreur de page, 0 requête externe | `notifications-browser/results.json` |
| Captures ordinateur/mobile, thèmes clair et sombre | PASS — examen visuel effectué | captures dans `browser/` |
| Typage complet KARTA | PASS | `karta-typecheck-final.log` |
| Typage frontend | PASS | `frontend-typecheck-final.log` |
| Typage du handler Edge avec types web | PASS | `edge-typecheck.log` |
| Lint des sources et tests modifiés | PASS — zéro erreur, zéro avertissement | `lint-final.log` |
| Compilation du site et du serveur | PASS | `frontend-build-final.log`, `karta-build.log` |
| Concurrence PostgreSQL native | NON TESTÉE localement — 4 scénarios prêts pour CI | `karta/test/routineDatabase.native.mjs` |
| Prestataires réels et déploiement | NON TESTÉS | aucune activation ni aucun envoi effectué |

Les cohortes intermédiaires ne s’additionnent pas aux cohortes finales. Les 489 tests incluent les 38 SQL et les 81 tests du proxy. La recette frontend inclut les 31 tests propres au client/hook de routines. Les captures montrent des comptes et des données synthétiques.

La compilation du site et du serveur a réussi. Les journaux `frontend-build*.log` et `karta-build.log` conservent aussi la première tentative frontend interrompue par la limite mémoire. La réception de l’arbre publié et les résultats hébergés sont ajoutés à la proposition de changement après exécution ; une réussite locale ne les préjuge pas.

## Ce qui change

Routines quotidiennes, hebdomadaires, ponctuelles et événementielles, aperçu dans le fuseau choisi, heures calmes, pause et annulation, canaux indépendants ou ordonnés, journal de livraison durable, numéro Auth vérifié, plafond de minutes et un seul appel non résolu par compte. Les bilans distinguent simulations, exécutions signalées réussies et validations attendues. Les demandes explicites recueillies au téléphone sont enregistrées pour confirmation.

La nouvelle migration porte le numéro 040 afin de préserver 039 de la PR129. Le centre de notifications, le scheduler KARTA et les paramètres existants sont réutilisés. Le rapport quotidien historique corrige le double comptage des simulations et continue les autres destinataires après un échec ; il respecte les préférences et cède la place aux routines récurrentes personnalisées.

Le démarrage inspecté ne fournit pas l’autorité de session, la mémoire et les ports canoniques nécessaires à l’exécution de nouvelles tâches depuis un appel. Ce lot ne fabrique pas cette autorité. L’état `pending_confirmation` décrit une demande conservée, pas une tâche exécutée.

## Contrôles et corrections

- Les événements sont détectés avant réduction à 3/5/10 éléments affichés ; leurs minutes sont non chevauchantes, avec comparaison des frontières de bilan à la microseconde.
- Le reçu manuel utilise une identité stable. Une réponse perdue ne déclenche pas un nouvel appel.
- Un arrêt pendant une lecture lente est revérifié avant réservation et transmission ; le chemin manuel reçoit la durée de vie du serveur.
- La transition SQL retourne son résultat réel. Un message refusé, un reçu mal formé ou une transition non appliquée ne deviennent pas un succès.
- Les callbacks rapprochent l’appel et son occurrence. Le token est revérifié après les lectures lentes ; seule une instruction explicite est conservée, jamais une transcription exécutée.
- Les appels inconnus restent non rejouables. Le rapprochement terminal reste possible après annulation. Un reçu push prouvant zéro envoi permet le repli ; une issue réseau ambiguë ne le permet pas.
- Le banc des déclenchements existants a reproduit un refus de nouvel import. Seuls ses ports de routines sans rapport avec le test ont été déclarés inertes ; la liste d’imports fermée et les assertions restent actives.

## Historique des tentatives

Les premiers processus PostgreSQL, compilation et graphe ont été interrompus par pression mémoire. La SQL finale a ensuite passé les 38 cas complets dans l’exécuteur principal, avec une borne de tas et une compilation WASM limitée ; aucune assertion n’a été retirée.

Le premier passage navigateur a révélé deux sélecteurs de test ambigus entre un titre et les libellés d’accessibilité. Les sélecteurs utilisent désormais le rôle de titre exact. Le passage suivant a rencontré une capture expirée et un crash de page. Le troisième passage avec le binaire Chromium disponible a passé les 8 scénarios, sans allongement des délais ni retrait de contrôle. Les journaux et le reçu de la deuxième tentative sont conservés.

Les erreurs de typage initiales ont été corrigées sans modifier les options globales : ordre `abortSignal` avant `single`, compatibilité ES2020 du contrat partagé, types du hook et du rapport, et chargement isolé du code Deno dans les tests Node. La cible Edge reste vérifiée séparément avec les types DOM.

## Analyse d’impact

GitNexus 1.6.12 a été utilisé avant les modifications des symboles existants et lors de la revue finale. Le rapport quotidien et le handler HTTP présentaient un risque LOW sur les liens résolus. Le démarrage, l’écran chargé dynamiquement et le banc de déclenchement restent UNKNOWN dans le graphe ; leurs références ont été retrouvées dans les sources et couvertes par les régressions. Le dernier contrôle de style a également analysé le validateur partagé (`text`, CRITICAL, 1 appelant direct et 16 flux), la projection des textes (`plainText`, LOW, 2 appelants directs) et la commande téléphonique (UNKNOWN, raccordement confirmé dans `handleRoutinePhoneRoute`). La correction correspondante ajoute uniquement quatre commentaires ESLint locaux justifiant le rejet volontaire des caractères de contrôle ; les expressions et le comportement ne changent pas.

L’index final est volontairement limité au lot et à ses points de raccordement : 1514 nœuds, 4029 arêtes, 54 groupes, 98 flux. Il signale des branches non explorées et des appels omis ; il ne prouve pas l’absence de dépendance dans l’ensemble de PURAMA. La recherche plein texte est indisponible. Les commandes et résultats se trouvent dans `impact/` et `gitnexus-*.log` ; le contrôle final des changements et la comparaison historique sont conservés avant publication. Le contrôle staged constate 833 symboles et 98 flux, classés CRITICAL, sur les 112 fichiers alors indexés pour commit. Les raccordements attendus sont le serveur, le scheduler, les routines, les préférences et le proxy. La comparaison à `origin/main` est CRITICAL (3 870 fichiers, 1 165 symboles du graphe ciblé), avec liste plafonnée : cette revue historique est PARTIELLE et dépasse ce lot. Les sorties CLI affichent seulement les premiers symboles et flux, même quand le calcul n’est pas plafonné. Le contrôle de whitespace des sources est PASS ; les journaux bruts conservent leurs espaces et lignes vides de sortie. Une revue indépendante des deux workflows, du script PostgreSQL natif et du gel Vercel n’a relevé aucun blocage ; le script natif passe aussi `node --check`. Cette revue statique ne remplace pas l’exécution CI.

## Reproduction

Depuis `karta/`, la suite ciblée est composée des fichiers `routine*.test.ts`, `dailyReportRoutines.test.ts`, `iaoRoutinesEdge.test.ts`, `providerHttp.test.ts`, `coreSchedulerDrain.test.ts`, `staticAgentScheduler.test.ts`, `staticAgentSchedulerCron.test.ts` et `runtimeApiReadiness.test.ts`. La configuration des tests interdit les accès fetch non simulés.

Depuis la racine :

```sh
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.app.json
node node_modules/typescript/bin/tsc -p tests/routines/edge-tsconfig.json
node --experimental-vm-modules --test --test-concurrency=1 tests/karta-trigger-custom.test.mjs tests/creator-chat-authorization.test.mjs
node node_modules/vitest/vitest.mjs run src/lib/iao-routines-client.test.ts src/hooks/useIaoRoutines.test.tsx src/hooks/useNotifications.test.tsx src/hooks/useCreatorAgentKarta.trigger.test.tsx
node tests/routines/browser/run.mjs
node tests/notifications/browser/run.mjs
```

Les scripts navigateur acceptent `PLAYWRIGHT_EXECUTABLE_PATH`. La qualification native exige un PostgreSQL local jetable, une base vide préfixée `iao_routines_test_` et `IAO_ROUTINES_NATIVE_DATABASE_URL`. Le script refuse les autres destinations et exige des PID distincts et des verrous réellement observés.

Fonctionnement, configuration et limites : `docs/iao-routines.md`. Paramétrage du prestataire vocal : `docs/iao-phone-agent.md`. La migration distante, le fournisseur téléphonique, l’OTP Auth, les emails/push réels, la qualité audio et la charge restent des qualifications distinctes. Le déploiement automatique Vercel est désactivé pour cette branche.
