# Essai gratuit : admission atomique et parcours d’abonnement

Périmètre : `purama-ai`, correctif empilé sur la PR 24, commit de départ
`9b066c5b10f6896041aec9359ee21b173c0f5014`. Les réparations TypeScript,
Zod/Router et OpenTimestamps présentes sur cette base sont réutilisées.
Ce document ne certifie ni tous les projets PURAMA ni leur production.

## Défauts reproduits et correction

L’ancienne fonction refuse un compte `free/active`, mais accepte un plan nul.
Sur PostgreSQL natif, deux transactions peuvent chacune obtenir un premier
essai, et une demande d’essai peut écraser un abonnement payant activé après
sa lecture initiale. Les deux contre-exemples sont conservés dans les tests.

La nouvelle migration effectue l’admission avec un seul `INSERT … ON CONFLICT
DO UPDATE … WHERE`. Le prédicat est réévalué sur la ligne verrouillée. Le gagnant
conserve son plan et sa date ; un refus ne modifie aucune donnée. Les plans nuls,
les abonnements payants actifs, les essais en cours et les essais déjà utilisés
sont refusés. L’éligibilité historique d’un abonnement non actif sans essai
consommé reste conservée ; cette modification ne redéfinit pas les règles
commerciales pour tous les statuts Stripe possibles.

La fonction utilise un chemin de recherche fixe et un droit d’exécution réservé
aux utilisateurs authentifiés. Les anciens droits clients `ALL` sur la table
sont remplacés par la lecture seule, y compris le retrait de `TRUNCATE` qui
n’est pas protégé par RLS. Les droits directs de `service_role` sont conservés.
Aucun écrivain frontend direct de cette table n’a été trouvé dans la base revue.

La page des tarifs attend le résultat de la lecture d’abonnement, présente une
erreur avec reprise et bloque une seconde sélection pendant une demande.
Un client dont l’abonnement payant est actif rejoint la facturation pour changer
d’offre. Un essai local déjà consommé conserve l’accès au checkout, y compris
pour son plan courant ; il ne dépend pas d’un portail Stripe inexistant. Un visiteur
déconnecté peut sélectionner l’offre gratuite. Les erreurs du RPC sont lisibles.
Les contrôles du navigateur ne remplacent pas l’admission SQL.

## Vérifications

| Contrôle | Résultat | Portée |
| --- | --- | --- |
| Suite KARTA | PASS — 640 tests, 53 fichiers | Inclut 28 nouveaux cas SQL PGlite ; après ajustement du typage du helper de test, les 28 cas ont été réexécutés |
| Types et build KARTA | PASS | Node 22.23.4, après correction du typage du test |
| PostgreSQL natif | PASS — 6 cas | Deux contre-exemples anciens et quatre vérifications après correction ; transactions réellement distinctes |
| Types frontend et lint des fichiers modifiés | PASS | Vérification des six consommateurs du hook par TypeScript ; lint ciblé sans diagnostic |
| Qualité navigateur et contrats | PASS — 23 cas | 19 parcours Chromium et 4 validations de contrats, 54,4 s ; inclut 6 nouveaux parcours de tarifs et conversion |
| Build frontend final | PASS | Node 22.23.4, Vite 6.4.6, après correction de la conversion d’essai |
| Contrats générés Supabase | PASS | Catalogue existant de 22 tables, pas toutes les fonctions SQL ni toutes les migrations |
| Compatibilité OpenTimestamps | PASS — 5 cas | Dépendances racine inchangées par ce correctif |
| Exécution du workflow GitHub modifié | NON TESTÉ | Les jobs configurés ne constituent pas une preuve d’exécution |
| Production, paiement réel, charge et disponibilité continue | NON TESTÉ | Aucun déploiement ni abonnement réel modifié |

Le fichier `subscription-trials-native-20261110.json` contient les résultats,
les empreintes des quatre fichiers exécutés, les versions et les vérifications
du nettoyage. Exécution native : PostgreSQL 18.4, Node 20.20.2, pg 8.23.0,
cluster Mac temporaire, socket privé, aucune écoute TCP. Le serveur a été arrêté
et son répertoire supprimé, puis l’absence vérifiée indépendamment.
La CI cible Node 22 et pg 8.23.1 verrouillé : cet environnement distant reste à
qualifier. L’ajout de pg est limité aux dépendances de développement de KARTA.

Les scénarios navigateur utilisent Chromium 147 et des réponses Supabase/Stripe
simulées sur un serveur local. Ils ne prouvent pas le fonctionnement de PostgREST,
de l’authentification Supabase ou de Stripe en production.

Analyse d’impact avant commit : 12 fichiers, 39 symboles et 13 processus sur le
delta préparé, risque élevé. La comparaison avec `origin/main` couvre 259 fichiers,
1 054 symboles et 364 processus, risque critique : elle inclut les travaux hérités
de la chaîne de PR. L’analyse du hook identifie six consommateurs directs ; le
SQL non indexé a été revu manuellement puis exécuté. La proposition reste en
brouillon, sans fusion automatique de cette chaîne dans la branche principale.

Un lancement simultané de l’indexation, du typage et du navigateur a subi un
blocage de l’environnement ; il a été interrompu sans allonger les délais des
tests. La qualification finale se fait séquentiellement. Cet essai interrompu
ne compte pas comme un résultat PASS.

## Reproduire

Depuis `karta`, `npm test -- test/subscriptionTrial.test.ts` exécute les cas SQL
PGlite. `npm test`, `npm run typecheck` et `npm run build` qualifient le sous-projet.
Depuis la racine, `npm run typecheck`, `npm run test:dependencies`,
`npm run check:database-contracts` et `npm run test:quality` qualifient le frontend.
Le navigateur local peut être fourni via `PLAYWRIGHT_EXECUTABLE_PATH`.

Le test natif s’exécute avec `npm run test:subscriptions:postgres` depuis `karta`.
Il requiert un cluster PostgreSQL **temporaire vide**, avec ces variables dédiées :
`PURAMA_TRIAL_TEST_PG_HOST`, `PURAMA_TRIAL_TEST_PG_PORT`,
`PURAMA_TRIAL_TEST_PG_USER`, `PURAMA_TRIAL_TEST_PG_PASSWORD` si nécessaire,
et `PURAMA_TRIAL_TEST_PG_DATA` égal au vrai répertoire de données.
Il refuse un serveur inattendu ou les schémas/rôles Supabase déjà présents.
Le workflow crée son propre conteneur PostgreSQL éphémère pour ce contrôle.

La barrière par verrou consultatif n’existe que dans le test. Elle bloque les
deux transactions juste avant l’insertion et permet d’observer le défaut ancien
de façon déterministe ; aucun délai arbitraire ne décide du gagnant.

## Conditions avant intégration et déploiement

1. Réconcilier la chaîne des PR avec le commit de base testé. Ne pas fusionner
   automatiquement les autres branches Aether, CHEF ou commerce : elles ont
   leurs propres modifications et migrations.
2. Vérifier le schéma cible réel et son historique : janvier crée
   `public.subscriptions`, tandis que juillet exige `purama_ai.subscriptions`.
   Le transfert entre les deux n’est pas présent dans les migrations examinées.
   La fixture fournit explicitement le schéma requis pour les tests ; elle ne
   résout pas cette lacune et ne constitue pas une migration complète à vide.
3. Confirmer l’absence d’écrivains clients externes et de privilèges de colonnes
   spécifiques non versionnés avant de réduire les ACL. Les intégrations de
   confiance doivent utiliser le service approprié, pas rétablir les droits `ALL`.
4. Réconcilier aussi la politique d’essai avec `create-checkout/index.ts` : ce
   chemin historique ajoute encore `subscription_data.trial_period_days: 14`
   à Stripe indépendamment du flag local. La garantie d’un essai unique démontrée
   ici porte sur le RPC local, pas sur l’ensemble des canaux de facturation.
   Les tests de conversion vérifient la navigation vers checkout simulé ; ils ne
   prouvent pas un paiement immédiat ni l’absence d’un nouvel essai Stripe.
5. Qualifier en préproduction le vrai parcours connexion → RPC → RLS → lecture
   actualisée, puis les webhooks et changements d’abonnement avec les services
   de test. Vérifier les journaux et l’état effectif de GitHub Actions.
6. Mesurer séparément la charge, la latence et la disponibilité sur la durée.
   Ces résultats locaux n’établissent pas une garantie 24 h/24.

## Références techniques

- [PostgreSQL : INSERT et prédicat ON CONFLICT](https://www.postgresql.org/docs/18/sql-insert.html)
- [PostgreSQL : fonctions SECURITY DEFINER](https://www.postgresql.org/docs/18/sql-createfunction.html)
- [Image PostgreSQL officielle et PGDATA](https://github.com/docker-library/docs/blob/master/postgres/README.md)
