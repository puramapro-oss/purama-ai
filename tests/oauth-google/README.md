# Google / Gmail : admission et cycle de vie OAuth

Ce lot réutilise les connexions et les primitives de requête existantes. Aucun
compte Google, paiement, email ou secret de production n'est utilisé par ces
bancs. La qualification réelle des permissions Google et de l'environnement
Supabase reste distincte des tests décrits ici.

## Comportement

L'endpoint `oauth-google` accepte des POST authentifiés : `authorize`, `callback`
et `refresh`. L'acteur est vérifié par `auth.getUser` avant l'accès privilégié et
avant tout échange Google. Il est revérifié avant l'écriture des jetons. La
connexion rafraîchie appartient à cet acteur ; un `userId` différent est refusé.

Les deux parcours partagent le registre privé `oauth_connection_states`.
L'état aléatoire de 32 octets est lié à l'acteur, au service et à l'usage prévu.
Seul son SHA-256 est conservé en base. La durée de dix minutes est calculée par
SQL et la consommation est unique. Aucun ancien état Base64 choisi par le
navigateur n'est admis. Les destinations de retour sont fixes.
La vérification d'expiration a lieu après l'acquisition du verrou de ligne :
une attente longue ne prolonge pas la validité de l'état.

Le retour Google de l'agent Gmail est relayé au callback navigateur par son
endpoint existant. Ce GET n'échange aucun code. Le callback commun compare
l'état conservé dans le navigateur et l'acteur courant, puis effectue un POST
authentifié vers le bon endpoint. Un nonce seul n'autorise pas une connexion
dans un autre navigateur ou compte.

Les clés du navigateur sont :

- `oauth_state` : état opaque.
- `oauth_context` : `{state,userId,provider,purpose,expiresAt}`.

`purpose` vaut `google_connections` ou `email_agent_gmail`. Une ancienne réponse
ne peut pas effacer le contexte d'une connexion plus récente. Changement de
compte, démontage et annulation invalident les requêtes et leurs navigations.
Le démarrage est dédupliqué dans son composant ; une panne ne laisse pas un
verrou permanent. Une réponse 200 dépourvue du reçu de succès attendu échoue.

Le délai total Edge Google est de 15 secondes, celui du client de 30 secondes.
Ils réutilisent `createRequestDeadline`, y compris pour un transport qui ignore
l'annulation. Les corps JSON sont bornés ; les redirections de transport ne
peuvent pas emporter les identifiants vers une autre origine.
Le client conserve le contrat de la gateway Supabase : `apikey` contient la
clé publique configurée, distincte du jeton utilisateur dans `Authorization`.
Une configuration absente est refusée avant l'appel réseau.

Les pages de l'agent Gmail réutilisent aussi `useRequestScope` pour leurs
chargements et réglages. `ProtectedRoute` isole déjà leur état lors d'un
changement de compte ou de page ; la garde supplémentaire empêche les anciennes
promesses de publier des notifications globales après ce démontage. Elle ne
prétend pas annuler une écriture distante déjà lancée.
L'ancien paramètre `gmail=connected` est nettoyé sans afficher de succès : seul
le reçu validé du callback confirme la connexion. Le retour `gmail=error`
conserve son message d'échec.

Un état est consommé **avant** l'effet fournisseur. Si cet effet ou sa
persistance est interrompu, le parcours demande de recommencer ; il ne rejoue
pas automatiquement le code. Cela ne transforme pas les opérations Google et
PostgreSQL en transaction distribuée.

Le callback Google exige un nouveau refresh token pour l'accès hors ligne. La
table historique ne contient pas de sujet Google permettant de prouver que
l'ancien jeton appartient au même compte externe : il n'est donc pas mélangé
avec une nouvelle connexion ambiguë. Le refresh d'une connexion existante
conserve son jeton quand Google ne le renouvelle pas, avec contrôle de la ligne
avant écriture. Les réponses et la requête de métadonnées de l'interface ne
transportent plus ces jetons.

Si Google déclare les permissions accordées dans `scope`, le handler vérifie
le scope demandé par égalité exacte. Un consentement limité à un autre service
ne peut pas devenir un reçu de connexion complet. Les réponses de renouvellement
qui omettent ce champ restent compatibles avec leur contrat existant.

## Installation coordonnée

Appliquer `20261110233000_oauth_connection_states.sql` avant les deux fonctions
OAuth, puis livrer le client correspondant. Le déploiement n'est pas exécuté par
ces tests. Les anciens retours en cours doivent redémarrer le consentement.

`GOOGLE_OAUTH_REDIRECT_URI` permet de configurer le retour du parcours Google
général ; son défaut historique est conservé. Cette URL HTTPS doit correspondre
exactement à celle autorisée chez Google. Le parcours Gmail conserve son URI
fournisseur côté serveur. Aucun réglage de console Google ou de DNS n'est modifié
par le lot.

Le stockage existant des credentials n'est pas remplacé par ce lot. Les droits
et la configuration réels du déploiement demeurent une qualification séparée.

## Bancs reproductibles

```sh
node --test --test-concurrency=1 tests/oauth-google/handler.test.mjs
node --test --test-concurrency=1 tests/oauth-google/state-sql.test.mjs
node tests/oauth-google/browser/run.mjs
node node_modules/@playwright/test/cli.js test --config tests/ui-state/playwright.config.ts email-lifecycle.spec.ts
deno check --no-config --no-lock --cached-only --node-modules-dir=manual supabase/functions/oauth-google/index.ts
```

Le banc Node charge les vrais handlers et helpers TypeScript ; seuls les ports
d'identité, de base et de fournisseur sont remplacés. Les doubles ne prouvent
pas la concurrence SQL native. `state-sql.test.mjs` exécute la migration réelle
sous PGlite, dont les requêtes concurrentes passent par une seule connexion.
Le banc natif de `qa/reliability-audit-20261110/oauth-native/` vérifie séparément
les connexions PostgreSQL distinctes, les verrous et les droits.

Le banc navigateur compile les vrais composants, hooks et `getGmailOAuthUrl`.
Les réponses peuvent être livrées dans le désordre et ignorer l'annulation.
Les sorties HTTP autres que le serveur éphémère local, WebSocket et service
workers sont bloqués. Par défaut Playwright choisit son navigateur installé ;
`PLAYWRIGHT_EXECUTABLE_PATH` permet de sélectionner un navigateur autorisé.
`OAUTH_BROWSER_EVIDENCE` déplace les preuves sans changer les assertions.
Les scénarios `email-lifecycle` étendent le banc `ui-state` existant, avec les
vraies pages et la vraie frontière `ProtectedRoute`. Ils délivrent les réponses
de chargement, sauvegarde et déconnexion après un cycle A → B → A, et vérifient
que le résultat courant reste visible. Les horloges des scénarios OAuth de
deadline sont installées avant le montage du composant.
Le scénario du paramètre de succès legacy inspecte aussi l'historique réel de
Sonner : la disparition visuelle d'un toast ne constitue pas une preuve de son
absence d'émission.

Les résultats réels et les limites des tentatives sont dans `evidence/`. Le
premier essai Chromium local a échoué avant tout cas avec une interdiction de
socket ; il ne constitue pas une contre-épreuve fonctionnelle. La suite initiale
Node échoue sur six contre-exemples et sur le nouveau contrat d'état opaque,
avant correction du handler. Les nombres de familles recouvrantes ne doivent
pas être additionnés en un total de scénarios distincts.

## Références de conception

- [Google : OAuth pour les applications Web serveur](https://developers.google.com/identity/protocols/oauth2/web-server)
- [RFC 9700 : sécurité OAuth 2.0](https://www.rfc-editor.org/rfc/rfc9700.html)
- [React : synchronisation et nettoyage des effets](https://react.dev/learn/synchronizing-with-effects)
