# Régression d’identité et d’historique UI

Ces neuf scénarios montent les pages de réglages partenaires, email, comptabilité et le chat juridique réels, sous le composant `ProtectedRoute` réel. Les helpers de données et le hook vocal sont également ceux du produit. Seuls le contexte d’authentification et le transport Supabase sont remplacés par des fixtures déterministes. Aucun compte ni fournisseur réel n’est utilisé ; les requêtes hors de l’origine locale, les WebSockets et les service workers sont bloqués.

## Exécution

Depuis la racine du dépôt, avec les dépendances du verrou déjà installées :

```sh
PLAYWRIGHT_EXECUTABLE_PATH=/chemin/vers/chromium node node_modules/@playwright/test/cli.js test --config tests/ui-state/playwright.config.ts
node node_modules/typescript/bin/tsc --noEmit -p tests/ui-state/tsconfig.json
node node_modules/eslint/bin/eslint.js src/components/auth/ProtectedRoute.tsx src/pages/LegalAgentChat.tsx tests/ui-state --max-warnings 0
```

Le serveur Vite de fixture utilise exclusivement `127.0.0.1:4197`, avec un worker et sans réutilisation d’un serveur préexistant. `UI_STATE_OUTPUT_DIR` et `UI_STATE_REPORT` permettent de déplacer les reçus de Playwright. Aucun téléchargement de navigateur ni installation n’est effectué par la recette.

## Contrats observés

Pour chacun des trois formulaires :

- Le compte A est chargé, puis remplacé par B pendant que la lecture de B reste suspendue. Le test essaie de sauvegarder si l’ancien bouton est encore accessible et capture le **véritable payload produit par le helper** : aucun paramètre de A ne doit être envoyé sous l’identité de B.
- Le formulaire de B devient utilisable après sa propre lecture. Une nouvelle identité d’objet d’authentification avec le **même `user.id`** préserve la saisie en cours, puis la sauvegarde transmet cette saisie sous B.
- Une lecture de A qui termine après celle de B ne doit pas remplacer le formulaire de B ni sa prochaine sauvegarde.

Pour le chat juridique : une lecture de l’historique A terminant après la sélection et le chargement de B est ignorée ; le même historique ne remplit pas une nouvelle conversation. La fixture délivre les réponses tardives même après invalidation : la protection du composant est donc réellement sollicitée. Une neuvième régression vérifie également qu’une réponse à un message envoyé en A ne rejoint pas B ou une nouvelle conversation et que son ancien bloc `finally` ne libère pas un envoi plus récent.

## Correctif et portée

La frontière existante `ProtectedRoute` remonte son sous-arbre seulement lorsque `user.id` change. Cela s’applique à toutes les routes qui utilisent cette frontière ; les trois pages de réglages ne nécessitent aucune garde copiée. Les redirections et l’état de chargement existants sont conservés.

`LegalAgentChat` réutilise `createRequestScope` pour invalider la lecture d’historique précédente lors du changement de conversation ou du démontage, avant affichage. Le transport de lecture n’accepte pas de signal : le correctif empêche l’application d’une réponse devenue obsolète, sans prétendre interrompre la requête distante. La propagation du signal vocal de PR30 reste intacte.

Ces tests vérifient le comportement des composants et des payloads avec un transport contrôlé. Ils ne constituent pas une qualification de l’authentification hébergée, des politiques RLS, de l’envoi au fournisseur juridique ou d’un déploiement de production. Les preuves RED et GREEN de l’intégration sont conservées dans le dossier de qualification, séparément du code.
