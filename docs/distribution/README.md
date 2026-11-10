# Distribution des modèles Creator Agent

Ce lot rend un modèle existant consultable par un lien public, puis copiable dans
un espace privé après authentification et action explicite. Il réutilise le
catalogue et le moteur Creator Agent de `purama-ai`.

Il ne constitue pas une nouvelle application publique ni une intégration déjà
admise dans ONE. Capsule/T17, Growth/T23 et leurs contrats restent des travaux
distincts à raccorder par leurs interfaces existantes.

## Parcours livré

1. Un auteur publie son modèle par le mécanisme existant.
2. Le catalogue expose sa présentation `/modeles/<uuid>` et des liens de partage.
3. Un destinataire consulte cette présentation sans compte. Aucun agent n'est
   exécuté à l'ouverture du lien.
4. Une connexion ou une inscription conserve la destination autorisée et un
   éventuel code de parrainage structurellement valide.
5. Le destinataire choisit explicitement « Créer ma copie privée ».
6. Le serveur vérifie son identité et la disponibilité du modèle, crée une copie
   privée, puis l'interface ouvre la fiche existante de cette copie.

Le code de parrainage réutilise le stockage existant. Sa présence dans un lien
ne prouve ni son existence métier ni un droit à une commission.

### Comportements de reprise

- Une réponse de copie perdue peut être retentée avec le même UUID : le serveur
  retrouve la copie du même propriétaire et de la même source.
- L'UUID de tentative est conservé dans l'instance montée de l'interface. Une
  reprise après rechargement de page ou sur un autre appareil n'est pas fournie.
- Deux clics avant le prochain rendu n'envoient qu'une demande.
- Un changement de compte est vérifié côté serveur avant toute lecture ou
  insertion ; une réponse tardive ne fait pas naviguer l'ancien utilisateur.
- Un modèle retiré ne peut plus être copié. Une copie déjà créée survit à la
  suppression de sa source ; elle n'est pas réécrite lors d'une reprise.
- Une panne partielle du catalogue conserve la section disponible et propose
  une nouvelle tentative, au lieu de présenter une fausse liste vide.

## Contrat public et confidentialité

`purama_ai.public_creator_models(p_id uuid, p_kind text)` retourne seulement :

```text
id, name, description, emoji, color, category,
is_public, is_template, is_active
```

La sélection actif/public, le statut officiel, les bornes des textes et la limite
de 100 résultats sont imposés en SQL. Le client reconstruit aussi un DTO limité.
Le statut officiel exige `is_template = true AND user_id IS NULL`.

L'aperçu public n'expose ni propriétaire, prompt, planification, historique ni
compteurs privés. En revanche, **publier un modèle autorise la copie de sa
configuration réutilisable, dont son prompt**, par un utilisateur authentifié.
Le prompt d'un modèle publié ne doit donc pas être présenté comme secret.

`clone_public_creator_model(p_source_id, p_copy_id, p_expected_user_id)` :

- dérive le propriétaire de `auth.uid()` ; l'identifiant attendu ne donne aucun
  droit et sert à refuser une session ayant changé depuis le clic ;
- vérifie la disponibilité du modèle avant une nouvelle insertion ;
- résout les reprises et collisions par propriétaire, source et UUID de copie ;
- crée une copie privée, non officielle, sans calendrier, entrée planifiée,
  démarrage KARTA ni historique repris.

Les lectures directes des tables restent limitées au propriétaire. La migration
retire également les anciens privilèges excessifs, dont `TRUNCATE`, sur agents,
chats et runs. Elle répare les drapeaux officiels hérités attribués à des agents
possédés par des utilisateurs.

La contrainte étrangère de `cloned_from` est retirée pour conserver une copie
après suppression de la source. Ce champ est une provenance fonctionnelle :
**ce n'est ni une attestation immuable ni une preuve d'attribution financière**.

Le chat métier exige désormais la propriété de l'agent même si celui-ci est
public et filtre l'historique par utilisateur, agent et session. L'utilisation
d'un modèle d'un autre auteur passe par la création de sa copie privée.
La validation rend `agent_id` obligatoire au niveau du schéma objet ; l'ancien
appel à `required()` sur un champ optionnel provoquait une erreur serveur.
Le test exécute le vrai module de validation avec Zod `3.22.4`, identique à
l'import de la fonction Edge, via une dépendance de test dédiée.

## Liens, accueil et mode hors ligne

- Les liens sont construits à partir de l'origine et d'une route publique
  explicitement autorisée. Les paramètres et fragments de la page courante ne
  sont pas repris. Un code de parrainage est ajouté seulement après validation.
- WhatsApp, Telegram, Twitter/X, Facebook, LinkedIn et email reçoivent une URL
  de partage. La livraison effective d'un message externe n'est pas testée.
- Le presse-papiers confirme uniquement une écriture réussie. En cas de refus,
  un champ sélectionnable permet la copie manuelle. L'annulation du partage
  natif n'est pas présentée comme une erreur ou un succès d'envoi.
- L'introduction est réservée à l'accueil sans paramètres ni fragment et peut
  être passée immédiatement. Les préférences de réduction des animations sont
  prises en compte.
- L'affirmation automatique est limitée à `/dashboard` sans paramètres ni
  fragment, avec session chargée. Navigation, déconnexion ou changement de
  compte démontent son overlay et son minuteur.
- Le service worker met en cache les ressources publiques de secours prévues.
  Il ne met pas en cache le HTML privé authentifié. Le secours hors ligne
  indique honnêtement la limitation réseau.
- Une notification ne déclenche aucune opération métier. Sa destination est
  validée à réception et au clic ; seules des routes locales autorisées sont
  ouvertes, sans paramètres ni fragment.

## Vérification et limites

Les résultats exécutés et leur environnement figurent dans
[`verification.json`](./verification.json). Les tests navigateur manipulent
l'application compilée et son vrai client Supabase avec une API locale simulée.
Ils ne prouvent pas une connexion à un service Supabase distant.

Les tests SQL exécutent les migrations dans PGlite, avec de vrais rôles et droits
PostgreSQL, mais un contexte d'authentification de test. Ils ne remplacent pas
une recette du transport HTTP Supabase ni une concurrence entre plusieurs
connexions PostgreSQL natives. Les tests du chat exécutent le handler avec des
doubles des services externes ; aucun fournisseur IA n'est appelé.

Commandes reproductibles, avec Node 22 et npm 10 :

```sh
npm ci
npm run lint
npm run typecheck
npm run test:unit
npm run test:distribution:db
node --test tests/service-worker-distribution.test.mjs
npm run test:security
npm run test:repo-security
npm run test:release-config
node --test tests/mobile-oauth-pkce.test.mjs
npx playwright install chromium webkit
npm run test:distribution:e2e
```

`test:ci` ajoute les contrôles navigateur existants sur ordinateur et les parcours
de livraison, distribution et PWA sur les profils tablette et mobile. Ceux-ci
utilisent WebKit dans la configuration du dépôt ; la CI doit donc installer ce
moteur en plus de Chromium. Une émulation ne certifie pas un appareil physique.

Playwright est verrouillé à `1.64.1` pour inclure le correctif de navigation
hors ligne WebKit : le même test échouait avec `1.59.1`/WebKit 26.4, puis passe
avec `1.64.1`/WebKit 27.2. Les assertions HTTP 200, réponse du service worker et
affichage du secours sont conservées. Voir le
[correctif officiel #42894](https://github.com/microsoft/playwright/pull/42894)
et la [régression documentée #42775](https://github.com/microsoft/playwright/issues/42775).

## Admission et livraison

La migration `20261110001000_creator_public_distribution.sql`, le frontend et le
correctif de `creator-agent-chat` doivent être qualifiés comme un même lot.
L'ancien catalogue lit directement les tables ; le nouveau utilise les RPC.
Un déploiement partiel peut donc rendre le catalogue indisponible. Aucun repli
vers une lecture publique de toutes les colonnes n'est prévu.

Avant une mise en service :

1. Intégrer le lot avec sa base `codex/security-integration` et vérifier le diff
   final. Aucune fusion automatique dans `main` n'est effectuée par ce lot.
2. Appliquer la migration et publier la fonction Edge dans un environnement de
   recette ; vérifier les rôles, le schéma RPC exposé et les anciennes policies
   réellement présentes. Déployer le frontend correspondant.
3. Tester connexion Google et confirmation email réelles, avec l'origine finale
   autorisée dans les paramètres de redirection. Vérifier également retrait du
   modèle, perte de réponse et copie concurrente avec deux connexions réelles.
4. Admettre le module et ses adaptateurs dans le shell ONE selon ses contrats
   existants. Ce dépôt ne prouve pas cette admission.
5. Vérifier le routage direct `/modeles/<uuid>`, les règles de cache et le service
   worker sur l'hébergement Hostinger/Cloudflare retenu, puis la recette finale.

La correction du chat refuse désormais l'exécution directe d'un agent public
appartenant à autrui : tout consommateur externe de cet ancien comportement
doit créer une copie privée avant de l'utiliser.

Un retour en arrière ne doit pas restaurer les anciens privilèges publics ou
les droits `TRUNCATE`. Préparer une version compatible du frontend et du backend
avant toute bascule de production.
