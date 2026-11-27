# Recette des notifications

Cette recette monte les vrais composants `Notifications`, `NotificationSettings`,
`NotificationCenter` et `DashboardHeader`, le vrai hook `useNotifications`, React,
React Query, Radix et Sonner. Elle complète les tests unitaires et les tests natifs
du handler ; elle ne contacte ni Supabase, ni un fournisseur d'email, ni la production.

## Isolation

Les seuls adaptateurs remplacés sont l'authentification, le transport Supabase,
le profil, l'abonnement et la liste d'agents. Les données sont synthétiques.
Le transport en mémoire conserve les callbacks de canaux supprimés pour pouvoir
injecter explicitement des événements tardifs. Il permet aussi d'échouer ou de
retenir une réponse puis de la libérer après un changement de compte.

Chaque scénario utilise un contexte Chromium neuf. Le serveur statique écoute
sur une adresse loopback et un port éphémère. Les requêtes du navigateur autres
que les lectures de cette origine et tous les WebSockets sont bloqués et font
échouer la recette. Les polices sont servies localement. Les vrais styles Tailwind
du produit sont compilés ; aucun composant de notification n'est réimplémenté.

## Les 12 scénarios

| N° | Résultat observable attendu |
| --- | --- |
| 1 | Une notification du propriétaire courant et son lien interne sûr sont visibles ; captures bureau 1365 × 900 et mobile 390 × 844. |
| 2 | Une panne de lecture de la page est explicite, distincte d'une liste vide ou entièrement lue ; le vrai bouton Réessayer récupère les lignes valides et écarte les lignes étrangères ou mal formées. |
| 3 | Les liens historiques `javascript:` et les URL commençant par `//` disparaissent du DOM rendu. |
| 4 | Le centre de notifications affiche l'erreur, propose Réessayer, récupère les données et neutralise une URL dangereuse. |
| 5 | Un vrai toast Sonner privé disparaît lors du passage de A à B ; tous les canaux utilisent `purama_ai` et des noms distincts. |
| 6 | La déconnexion efface le toast privé et retire les abonnements. |
| 7 | Après A → B → A, le callback du premier abonnement A reste ignoré ; celui du nouvel abonnement A fonctionne. |
| 8 | Les événements Realtime étrangers ou de type invalide sont ignorés ; une notification valide munie d'une URL dangereuse n'affiche aucune action Voir. |
| 9 | Les préférences enregistrées à `false` restent désactivées ; une activation demandée est confirmée et un seul upsert porte le bon propriétaire. Captures bureau et mobile. |
| 10 | Un enregistrement échoué conserve la valeur confirmée ; une nouvelle tentative réussit. |
| 11 | Une panne initiale de préférences n'affiche pas de valeurs activées éditables inventées ; le vrai bouton Réessayer restitue les valeurs `false`. Capture de l'erreur. |
| 12 | Une réponse de liste A libérée après le passage à B ne remplace jamais la liste B visible. |

## Exécution dans un navigateur réel

Depuis la racine du dépôt, avec les dépendances déjà installées et un Chromium
disponible :

```bash
PLAYWRIGHT_EXECUTABLE_PATH=/opt/google/chrome/chrome \
NOTIFICATIONS_BROWSER_EVIDENCE=/tmp/notifications-quality/browser \
node tests/notifications/browser/run.mjs
```

Sans `PLAYWRIGHT_EXECUTABLE_PATH`, le runner utilise le binaire attendu par le
Playwright installé. Il n'installe aucun navigateur. Le workflow séparé
`.github/workflows/notifications-quality.yml` orchestre cette exécution en CI.
Node 24.22.3 est la version utilisée pour la préparation locale.

Le résultat `PASS` exige 12 scénarios réussis, aucune erreur de page, aucune
tentative de requête externe et des empreintes source inchangées pendant la
recette. Le dossier de preuves contient `results.json`, les versions, les
empreintes SHA-256 du produit et du bundle ainsi que les captures réussies ou
d'échec. Toute absence de binaire ou tout scénario échoué produit un code de
sortie non nul. Une compilation seule n'est jamais qualifiée de test navigateur.

## Contre-épreuve DOM sans moteur navigateur

Le runner peut préparer le même bundle, puis `dom-probe.mjs` exécute les vrais
composants dans jsdom. Ce contrôle vérifie uniquement les trois chemins
erreur → Réessayer → récupération. Il exige une erreur explicite, aucune fausse
liste vide, aucun switch pendant une panne de préférences, puis l'effacement de
l'erreur et la restitution des données. Il ne vérifie ni le rendu visuel, ni un
moteur navigateur, ni les 12 scénarios complets.

```bash
NOTIFICATIONS_BROWSER_BUILD_ONLY=1 \
NOTIFICATIONS_BROWSER_EVIDENCE=/tmp/notifications-quality/precompiled \
node tests/notifications/browser/run.mjs

node tests/notifications/browser/dom-probe.mjs \
  /tmp/notifications-quality/precompiled \
  /tmp/notifications-quality/dom-results.json
```

Le 27 novembre 2026, la contre-épreuve finale a réussi **3/3** sous jsdom 26.1.0
avec Node 24.22.3. Les reçus conservés dans
`qa/notifications-20261127/browser-dom-before.json` et `browser-dom-after.json`
distinguent les défauts observés avant correction et les résultats après
correction. Le bundle final contrôlé porte l'empreinte
`c5a8f62bea6909b731b41c0f1f7cd5e5ca6d9785d02f79f422091c6ea5018526`.

Le contrôle navigateur local reste **NON TESTÉ** : le wrapper Chromium présent
pointait vers un binaire absent ; l'unique installation dans un cache isolé a été
refusée par le réseau (HTTP 403). `browser-local-attempt/results.json` indique
zéro scénario exécuté ; `browser-install-attempt.log` conserve le refus. Les
preuves DOM ne remplacent pas l'exécution Chromium prévue en CI.

## Exécution transportable sans recompilation

Le mode `BUILD_ONLY` écrit `bundle.js`, `style.css`, `run.mjs`, les polices locales
et `manifest.json`. Cet artefact peut être transféré vers un environnement qui
possède déjà Chromium et `@playwright/test`. Le runner y vérifie l'empreinte de
chaque fichier, y compris son propre code, avant d'exécuter les mêmes scénarios :

```bash
NOTIFICATIONS_BROWSER_PREBUILT=/tmp/notifications-precompiled \
NOTIFICATIONS_BROWSER_DEPENDENCIES=/chemin/projet-avec-playwright \
NOTIFICATIONS_BROWSER_EVIDENCE=/tmp/notifications-quality/browser \
PLAYWRIGHT_EXECUTABLE_PATH=/chemin/chromium \
node /tmp/notifications-precompiled/run.mjs
```

Le reçu transportable identifie les empreintes du produit à la compilation et
vérifie la stabilité de l'artefact à l'exécution. Il indique explicitement que les
sources distantes ne sont pas inspectées (`sourceUnchanged: null`). Ce mode ne
nécessite ni esbuild ni Tailwind sur l'environnement d'exécution.

Les gros bundles, styles compilés et polices recopiées sont reproductibles et ne
doivent pas être ajoutés au dépôt. Conserver les recettes et les petits reçus
JSON ; archiver les captures et bundles comme artefacts de CI si nécessaire.
