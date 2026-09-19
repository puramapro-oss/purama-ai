# Correctifs IAO / KARTA — 19 septembre 2026

Base examinée : `e11d6c6c266b31c24e96dac195ed3e918e3cdd22`.
Ces changements sont préparés pour revue. Aucune fusion, migration de production, publication ni action auprès d'un fournisseur réel n'a été exécutée.

## Corrections

- Le cycle distingue réussite, erreur, attente d'approbation, simulation, arrêt et résultat partiel. Un outil inconnu ou un résultat explicite `ok:false` / `success:false` / `error` ne compte plus comme une réussite.
- Le mode mock n'exécute plus d'actions réelles et ne crée pas d'approbations exécutables.
- L'arrêt global et l'autorisation de l'agent sont relus avant chaque action, sans le cache de cinq secondes. Une action déjà envoyée à un fournisseur peut toutefois avoir pris effet.
- L'approbation réserve l'action en PostgreSQL avant l'appel fournisseur. Sa résolution et la mise à jour du journal parent sont atomiques. Une panne de finalisation laisse une réservation à réconcilier, jamais une action librement rejouable.
- Une clé durable identifie chaque livraison BullMQ. Une redélivraison du même job ne rejoue pas un cycle déjà réservé. Les erreurs survenues après un effet possible ne déclenchent pas les reprises automatiques de BullMQ.
- Les écritures Supabase appliquent le propriétaire dans le prédicat UPDATE. L'insertion d'un identifiant appartenant à un autre utilisateur échoue au lieu de réattribuer la ligne.
- La lecture des factures Stripe de la plateforme exige `KARTA_PLATFORM_OWNER_USER_ID`, configuré côté serveur. L'absence de cette valeur refuse l'accès. Elle ne fournit pas un accès Stripe multi-client.
- Les clients ne peuvent plus modifier `public.connect_accounts`. Les lectures personnelles et les écritures `service_role` restent disponibles. La provenance des anciennes associations compte/utilisateur doit être vérifiée avant activation.
- L'API administrative valide strictement les booléens et le JSON, limite les corps et les délais, compare le token avec `timingSafeEqual`, et masque les erreurs internes.
- Le flux Anthropic exige `message_stop` avant `[DONE]`. Une erreur sous HTTP 200, un JSON invalide ou une fin prématurée échoue. Les délais, annulations, tailles de trames et la consommation progressive sont contrôlés.
- Le parseur navigateur exige aussi `[DONE]`; ChatbotWidget réutilise ce parseur et n'enregistre pas une réponse tronquée comme complète.
- Les dépendances KARTA et les mises à jour compatibles du site ont été actualisées. Vite passe de 5 à 6.4.3, compatible avec le plugin React SWC déclaré.

## Validation exécutée

| Contrôle | Résultat |
| --- | --- |
| KARTA, SQL et streaming : Vitest | 107 tests réussis |
| TypeScript KARTA | Réussi |
| Compilation KARTA | Réussie |
| Vérification TypeScript isolée des deux parseurs de flux | Réussie |
| Construction Vite du site | Réussie |
| npm audit KARTA | 0 vulnérabilité connue signalée, contre 9 avant |
| npm audit site | 9 signalements restants : 8 modérés, 1 faible; contre 20 avant |
| TypeScript global du site | 103 diagnostics, identiques sur les sources d'origine avec le même arbre de dépendances |
| Recherche ciblée de formats de secrets | Aucun des formats recherchés dans les 595 fichiers texte suivis examinés; aucun contenu secret affiché |

Les tests SQL exécutent les migrations et fonctions PL/pgSQL réelles dans PGlite, un moteur PostgreSQL WebAssembly à un seul backend. Ils vérifient notamment les demandes d'approbation concurrentes, les retours arrière, l'unicité des clés et les privilèges. Ils ne certifient pas les verrous entre plusieurs connexions PostgreSQL natives. Les fournisseurs externes sont simulés; l'API HTTP est testée sur un serveur local réel.

GitNexus a été utilisé avant les modifications. Les types partagés ont un impact critique; les consommateurs KARTA compilent. La journalisation parent et l'arrêt global ont un impact élevé. Le parseur navigateur et ChatbotWidget ont un impact faible dans le graphe résolu. Les trois points d'entrée Deno ont été inspectés manuellement, le graphe n'identifiant pas leurs appelants HTTP. L'index présente des limites de traçage et n'est pas une preuve d'exhaustivité.

## Intégration

1. Rapprocher cette branche des modifications non publiées des terminaux Codex/GLM. Ce travail n'a pas accès à leurs processus locaux.
2. Arrêter/drainer les anciens workers KARTA pour éviter une coexistence avec une version sans réservation durable.
3. Appliquer `karta/migrations/006_execution_claims.sql` avant le nouveau moteur.
4. Vérifier les associations Stripe existantes puis appliquer `supabase/migrations/20260919160000_connect_accounts_server_writes.sql`. Le code du client ne doit pas écrire ces identifiants ou statuts.
5. Configurer l'UUID du propriétaire Stripe si cette fonction est utilisée; conserver le mode simulation jusqu'aux essais de préproduction.
6. Tester les interruptions avec PostgreSQL natif, Redis/BullMQ, Supabase/PostgREST, Deno et les comptes sandbox fournisseurs.
7. Pour une action restée `executing`, rechercher la preuve chez le fournisseur avant toute reprise. Ne pas remettre automatiquement son statut à `pending`.
8. Déployer ensuite le moteur, les trois fonctions de chat et le navigateur ensemble après validation.

Une clé de livraison ne déduplique pas deux demandes métier distinctes. La réconciliation automatique de chaque fournisseur et les clés d'idempotence propres à ceux-ci restent à compléter.

## Points restant ouverts

- L'audit du site conserve des alertes concernant React Router et la chaîne OpenTimestamps (`request`, `elliptic`, `bn.js`, dépendances indirectes). Aucune rétrogradation artificielle vers OpenTimestamps 0.0.0 n'a été appliquée pour faire disparaître le compteur.
- Le mobile conserve 34 signalements sur son verrouillage d'origine, dont 2 critiques. Son manifeste mélange Expo 54, des modules Expo 55 et des versions React incompatibles. Une tentative de mise à jour compatible a été annulée après échec de `npm ci`; aucun verrouillage mobile non installable n'est livré.
- La vérification TypeScript globale du site reste bloquante; les types de plusieurs tables, les usages de ces données et certaines interfaces doivent être rapprochés du schéma réellement déployé.
- Les essais Playwright n'ont pas pu démarrer : aucun navigateur préinstallé et téléchargements Chromium en échec réseau. Pas de validation visuelle ou de session utilisateur authentifiée.
- Les 40 fichiers binaires du dépôt n'ont pas été récupérés localement. Ils restent inchangés dans l'arbre Git d'origine; le build JavaScript réussi ne certifie pas les médias déployés.
- Aucun scan antivirus des appareils ou serveurs, test d'intrusion de production, certification de toutes les applications, ou preuve d'absence de compromission passée n'a été réalisé.

## Références techniques

- [Anthropic — événements de streaming et erreurs](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [PostgreSQL — INSERT et gestion des conflits](https://www.postgresql.org/docs/current/sql-insert.html)
- [Vite — migration de la version 5 vers 6](https://v6.vite.dev/guide/migration)
- [OWASP — sécurité des agents IA](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html)
