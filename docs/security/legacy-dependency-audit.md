# Audit des dépendances legacy de production

Date de référence : 2026-10-03. Base auditée : `1275a87406660f4cc9a09d56b10bc2889843fe52`.

## Résultat

L'audit npm de départ signalait 14 entrées : 1 faible, 8 modérées et 5 élevées. Il ne
s'agissait pas de 14 failles indépendantes, mais de trois chaînes de dépendances :

| Chaîne | Avis npm initiaux | Exposition réelle | Traitement |
| --- | ---: | --- | --- |
| `opentimestamps -> bitcore-lib/request/request-promise/elliptic/bn.js` | 7 | Le client web mort n'avait aucun appelant. Le code Edge reste décrit ci-dessous. | Dépendance et modules frontend inutilisés supprimés. |
| `tailwindcss -> chokidar/fast-glob/micromatch/braces` | 5 | Outils de compilation uniquement, absents du serveur et du bundle navigateur. | `tailwindcss-animate` reclassé en dépendance de développement pour isoler toute la chaîne. |
| `react-router-dom -> react-router` | 2 | Routeur SPA réellement exécuté dans le navigateur. | Non forcé : le correctif publié exige React Router 7 et une migration majeure. |

Après ces changements, `npm audit --omit=dev` ne conserve que les deux avis modérés
React Router. Un `npm audit` complet signale aussi des avis dans la chaîne de build et de test
(Tailwind, Vite, Vitest et leurs dépendances transitives). Ces paquets sont absents de
l'installation de production `--omit=dev` et demandent des migrations majeures coordonnées.

## OpenTimestamps encore utilisé par les fonctions Edge

Deux fonctions Deno importent toujours explicitement `npm:opentimestamps@0.4.9` :

- `supabase/functions/contracts-ots-stamp/index.ts` produit une preuve à partir d'un hash de
  PDF calculé côté serveur. Les calendriers sont choisis par la bibliothèque, pas par la requête.
- `supabase/functions/contracts-ots-verify/index.ts` charge la preuve depuis la base à partir
  d'un identifiant de contrat. La requête ne fournit ni URL de calendrier ni preuve arbitraire.

La chaîne Edge contient donc encore `request` (avis SSRF), `elliptic` et `bn.js`, mais elle est
hors du graphe `package-lock.json` du frontend. L'exploitabilité SSRF actuelle est réduite : les
URLs et preuves ne sont pas directement contrôlées par l'appelant. Elle n'est toutefois pas
nulle si une preuve stockée est compromise ou si la bibliothèque interprète une attestation
réseau malveillante.

Une correction complète nécessite de migrer ces deux fonctions vers un client OpenTimestamps
maintenu ou vers un petit service d'horodatage isolé, avec liste blanche stricte des calendriers,
timeouts, limites de taille de preuve et vérification Bitcoin indépendante. Ce changement doit
être testé avec les preuves historiques avant retrait de `opentimestamps@0.4.9`; le remplacer
aveuglément ou réécrire le format binaire ici risquerait de rendre les preuves existantes
invérifiables.

## React Router

La version verrouillée est `react-router-dom@6.30.6`. Les avis courants demandent une version
7 corrigée. L'application utilise largement les API v6 (`BrowserRouter`, `Routes`, `Route`,
`Navigate`, `Link`, `useNavigate`, `useLocation`, `useParams`, `useSearchParams`). Une surcharge
forçant seulement `react-router@7` sous `react-router-dom@6` créerait un couple non supporté.

La migration requise est donc une montée coordonnée vers React Router 7, avec validation de
toutes les redirections et de l'hydratation. En attendant, aucune donnée de route sérialisée par
un serveur React Router n'est utilisée : l'application est une SPA Vite, ce qui rend l'avis
d'injection SSR/hydratation non applicable au déploiement actuel. L'avis de redirection reste
pertinent pour toute navigation construite depuis une entrée non fiable ; les destinations
doivent rester internes ou explicitement validées jusqu'à la migration.

## Commandes de vérification

```sh
npm ci
npm run typecheck
npm run build
npm run test:unit
npm audit --omit=dev
npm audit
```
