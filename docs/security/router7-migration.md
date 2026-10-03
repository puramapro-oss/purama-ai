# Migration React Router 7

## Portée

`react-router-dom` et `react-router` passent ensemble de 6.30.6 à 7.18.4. Les API utilisées par
la SPA (`BrowserRouter`, `Routes`, `Route`, `Navigate`, `Link`, `useNavigate`, `useLocation`,
`useParams`, `useSearchParams`) restent compatibles ; le typecheck et le build de production
valident tous leurs appels.

La migration élimine les deux derniers avis de l'installation npm de production. Le résultat de
`npm audit --omit=dev` est de zéro avis.

## Destinations dynamiques

- Le retour après login provient de l'état de la route protégée. Il passe désormais par
  `safeInternalPath` avant `navigate`.
- Le retour OAuth est signé côté serveur, limité à un chemin local, puis validé une seconde fois
  côté navigateur. Les formes avec URL absolue, `//`, barre oblique inverse, encodage `%5c`,
  caractères de contrôle ou encodage invalide sont refusées.
- Les redirections Stripe et OAuth externes restantes proviennent de réponses de fonctions
  serveur dédiées ; elles n'utilisent pas `Link` ou `navigate`.
- `notifications.action_url` alimente encore `window.location.href`. Ce flux préexistant n'a pas
  été modifié ici : GitNexus classe `useNotifications` CRITICAL (8 symboles, 7 flux). Il doit être
  durci dans une modification séparée avec tests fonctionnels de tous ses consommateurs.

## Vérification navigateur

La suite Playwright `tests/navigation.spec.ts` a été lancée, mais l'environnement ne contient pas
le binaire Chromium Playwright. Aucun test n'a atteint l'application. Il faut exécuter
`npx playwright install chromium`, puis relancer la suite dans un environnement autorisant le
téléchargement du navigateur.
