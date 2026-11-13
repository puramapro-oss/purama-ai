# Atelier IAO : création de sites et d’applications

L’atelier relie l’interface à CHEF : une demande authentifiée crée une mission durable,
un consommateur réservé au projet exécute les tâches et des vérifications indépendantes
conditionnent le résultat. Les animations de génération fictive ont été retirées.

## Parcours livré

- Route protégée : /dashboard/atelier ; accès depuis le menu et l’accueil.
- Historique par compte, reprise après reconnexion, erreurs explicites.
- Une tâche de réalisation puis deux contrôles indépendants en lecture seule.
- Exécution parallèle bornée par la configuration de l’hôte et les verrous CHEF.
- Arrêt demandé distinct de l’arrêt confirmé ; aucune libération de dossier sur une simple expiration de bail.
- SHA et nombre de preuves issus du moteur, sans fausse réussite ou faux aperçu.
- Archive ZIP des sources et aperçu HTML optionnel, chargés depuis le commit vérifié.
- Contrôle de la propreté, du HEAD et de la branche avant et après les vérifications, y compris en lecture seule.
- L’interface ne reçoit ni chemins, ni commandes, ni clé de service, ni diagnostic brut.

L’atelier exécute des projets **préenregistrés par leur propriétaire technique**. Il ne
provisionne pas un environnement arbitraire pour chaque visiteur. Une offre publique
multiutilisateur demande un environnement isolé par client. Les travaux existants dans
Origin et la sélection des capacités de la PR68 restent distincts et ne sont pas remplacés.

L'adaptateur Codex direct refuse explicitement une demande portant une sélection de
capacités avant tout lancement. Le catalogue qualifié, son application réelle par
la CLI et son reçu doivent être raccordés avant d'exposer ces choix dans l'atelier.
Une liste ajoutée au prompt ne constitue pas cette qualification.

## Configuration de l’hôte

1. Utiliser un checkout de confiance comportant les migrations CHEF 008–029, puis 030_chef_capability_selection.sql.
2. Appliquer ensuite karta/migrations/031_chef_workshop.sql dans la base existante, selon le processus de migration de l’installation. Le fichier atelier portait le numéro 030 dans le candidat PR74 non déployé ; le numéro 031 évite le doublon avec la sélection des capacités. Une installation ayant appliqué l'ancien candidat doit rapprocher son historique avant toute exécution, sans rejouer la création des tables.
3. Définir le même CHEF_WORKSHOP_PROJECTS_JSON pour l’API KARTA et le consommateur.
   Adapter workshop-projects.example.json : identifiant utilisateur Supabase réel,
   dépôt, worktree dédié et profils de vérification existants. Le fichier fourni est
   un exemple, sans compte réel et sans activation automatique.
4. Fournir au consommateur les variables serveur SUPABASE_URL et
   SUPABASE_SERVICE_ROLE_KEY. Elles ne sont jamais transmises au processus Codex.
   Utiliser un compte système réservé au projet et une session Codex autorisée.
5. Exécuter dans karta : npm run chef:workshop:check.
   Ce contrôle vérifie configuration, Git, commandes, authentification locale Codex
   et accès aux tables. Il ne lance aucun modèle et n’annonce pas une génération testée.
6. Lancer npm run chef:workshop sous le superviseur de services existant.
   Un seul consommateur détient le bail d’un projet. Un second est refusé.
7. Déployer la fonction chef-workshop avec SUPABASE_URL, SUPABASE_ANON_KEY,
   KARTA_INTERNAL_URL et KARTA_ADMIN_TOKEN côté serveur ; déployer l’API et le frontend.
   Le client appelle uniquement la fonction authentifiée.
8. Qualifier une mission complète dans cet environnement avant d’ouvrir le projet aux utilisateurs.

Aucun changement de fournisseur, achat, déploiement Vercel ou modification des autres
worktrees n’est nécessaire. Le dépôt et les profils doivent être propres et dédiés. `workdir` doit être le chemin canonique
retourné par `realpath` : les alias sont refusés avant admission pour conserver la même
identité de dossier entre l’API, les workers et les verrous SQL.
Ne pas donner au worker le dépôt actif d’une autre équipe ou des accès de production.

## Enregistrement Git

Codex reste dans son sandbox read-only ou workspace-write. Il n’effectue pas git add/commit.
Après une réponse completed, le serveur contrôle les chemins et crée un commit local
avec un index privé, sans hooks, signature ni filtres. La mise à jour de la branche utilise
le SHA initial comme condition ; un changement concurrent provoque un refus. Aucun push
ou déploiement n’est exécuté par ce chemin.

L’enregistrement automatique refuse les liens symboliques modifiés, les sous-modules,
les changements de .gitattributes/.gitmodules, plus de 256 fichiers, plus de 10 Mio par
fichier et plus de 25 Mio au total. Les filtres Git locaux ne sont pas pris en charge
par cet adaptateur ; un projet qui en dépend nécessite un adaptateur qualifié.

## Récupération des créations

L’action authentifiée `artifact` accepte uniquement un identifiant de mission. Elle
revérifie l’appartenance actuelle au projet et exige que la réalisation et les deux
revues soient terminées, avec le même commit. Les fichiers viennent des objets Git de
cette version, même si le projet a ensuite changé ; aucun fichier courant n’est substitué.
L’API doit donc accéder au même dépôt dédié que le consommateur.

`exportPaths` permet de limiter les sources distribuées (par défaut `allowedPaths`).
L’archive est bornée à 256 fichiers et 4 Mio. Liens symboliques, sous-modules, traversées
de chemin et emplacements de secrets identifiables sont refusés. Ce filtre de noms
ne remplace pas une revue du contenu : les projets exécutés doivent être sans secrets.
Les sources d’authentification ordinaires, par exemple `src/auth/Login.tsx`, restent exportables.

`previewEntry`, facultatif, désigne un fichier `.html` exporté, UTF-8, non vide, de 200 Kio maximum.
Un fichier vide, binaire ou trop grand reste dans le ZIP sans être proposé en aperçu.
L’aperçu convient à une page autonome ; il ne reconstruit pas les dépendances d’un site
multifichier. Le client vérifie taille, empreinte, mission et commit avant d’exposer le
résultat. L’iframe a une origine opaque et une CSP restrictive ; il ne partage pas la
session de l’éditeur. Cette politique ne garantit pas l’absence de toute navigation
arbitraire déclenchée par du JavaScript. Les URL Blob sont révoquées au changement de
compte ou de mission. L’archive livrée contient des sources, pas une compilation mobile.

Exemple d’ajout au projet déjà configuré :

    "exportPaths": ["index.html", "src", "package.json"],
    "previewEntry": "index.html"

Les exécutables Git, Codex et de vérification doivent être extérieurs au dépôt généré.
Un exécutable de confiance qui lance un script du projet exécute toujours du code non
fiable : l’isolation complète du compte ou du conteneur reste indispensable avant
ouverture à des utilisateurs publics.

## Vérifications et coûts

Les profils sont des commandes de confiance enregistrées sur l’hôte, jamais envoyées
par le navigateur ou choisies par le texte du modèle. Chaque exigence PRODUCT et QUALITY
doit recevoir une preuve de réalisation et une preuve review issue d’une tâche distincte.
Les tests d’acceptation devraient être maintenus hors des chemins modifiables par le modèle.

La réponse `completed` du modèle signifie « prêt pour les contrôles du serveur ».
Elle ne constitue jamais une preuve de réussite. Le modèle indique explicitement les
contrôles qu’il n’a pas pu exécuter dans son sandbox, sans contourner ses restrictions ;
les profils configurés sont ensuite exécutés par le serveur et peuvent refuser le résultat.
Un défaut constaté ou une réalisation incomplète demeure un échec ou un blocage.

tokenBudget et estimatedTokensPerTask utilisent les compteurs réellement rapportés par
Codex. Une estimation n’est pas un plafond strict imposé à une requête du fournisseur :
un tour peut consommer davantage que prévu ; CHEF réconcilie l’usage et bloque les
admissions suivantes lorsque le budget est insuffisant. Dimensionner les estimations
avec les mesures de l’installation, y compris les entrées mises en cache.

Le prix monétaire est inconnu lorsque la CLI ne le fournit pas. Aucun coût nul n’est
inventé. Une configuration costBudgetMicros exige des reçus monétaires qualifiés ;
ne pas lui substituer des estimations présentées comme dépenses réelles. L’exemple
utilise uniquement le budget de tokens et n’engage aucun abonnement supplémentaire.

## Arrêt, reprise et défaillances

- Bail du consommateur : renouvellement périodique ; admission seulement avec heartbeat récent et configuration correspondante.
- Annulation : bloque les nouveaux claims, interrompt les processus via AbortSignal,
  puis attend leurs reçus d’arrêt. L’interface reste en cancelling tant que l’arrêt n’est pas établi.
- Toute génération historique claimée doit posséder une transition de sortie authentifiée.
  Un bail expiré, une ligne modifiée ou un heartbeat absent ne constituent pas cette preuve.
- Arrêt incertain : quarantaine CHEF durable, dossier conservé et pas de relance automatique.
- Perte de la base, du bail ou activation de l’arrêt global : arrêt des cycles, sans nouvelle admission.
- Une mission failed ou bloquée ne devient pas une livraison vérifiée. Le diagnostic interne,
  les vérifications et les fichiers existants doivent être examinés avant une reprise.

## Validation reproductible

Depuis la racine :

    npm run typecheck
    npm run build
    node_modules/.bin/vitest run src/lib/workshop.test.ts src/pages/Workshop.test.tsx
    node_modules/.bin/playwright test --config tests/workshop-state/playwright.config.ts

Depuis karta :

    npm run typecheck
    npm run build
    npm test -- --maxWorkers=2
    node --test test/chefWorkshopConcurrency.native.mjs

Le test PostgreSQL natif utilise uniquement un cluster temporaire privé et les binaires
déjà installés. Les fixtures navigateur sont séparées de l’application distribuée.
Le dossier qa/workshop-20261112 conserve les résultats de qualification et distingue
tests simulant les services, concurrence PostgreSQL réelle et essais du fournisseur.
