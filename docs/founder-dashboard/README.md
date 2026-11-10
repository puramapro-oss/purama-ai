# Tableau de bord privé du fondateur

## Portée du changement

Ce lot renforce la route existante `/admin/dashboard` pour le périmètre de données `purama_ai`. Son origine est le seul commit `ef9aa78312aa092fc2ad02d33aea4b27d6cca303` de la PR16, désormais composé avec les PR13, PR14 et PR15 ; les autres ancêtres de `codex/security-integration` ne sont pas importés.

Il ajoute une fonction de lecture `founder-dashboard`, un contrat de réponse validé et une interface qui distingue les données disponibles, absentes et indisponibles. Il ne constitue pas encore une consolidation financière ou une console de commandes IAO.

## Autorisation serveur

La fonction vérifie le jeton avec Supabase Auth, puis exige simultanément :

- l'UUID stable configuré dans `PURAMA_FOUNDER_USER_ID` ;
- l'adresse canonique du fondateur définie dans le code ;
- une adresse confirmée.

Les métadonnées utilisateur, profils modifiables et rôles transmis par le navigateur ne donnent aucun droit. Le client privilégié est créé après ce contrôle. La fonction ne propose aucune écriture métier.

Configuration serveur requise :

| Variable | Usage |
|---|---|
| `PURAMA_FOUNDER_USER_ID` | UUID réel vérifié auprès du service d'authentification. Les valeurs factices sont refusées. |
| `PURAMA_FOUNDER_ALLOWED_ORIGIN` | Origine HTTPS exacte autorisée pour les appels navigateur. |
| `SUPABASE_URL` | Service Supabase cible. |
| `SUPABASE_ANON_KEY` | Clé publique utilisée pour la vérification du jeton. |
| `SUPABASE_SERVICE_ROLE_KEY` | Clé privilégiée exclusivement côté serveur. |

Le schéma attendu est `purama_ai`. Ce lot n'ajoute aucune migration RLS. Conserver la vérification JWT de la plateforme.

Les réponses sont non stockables (`Cache-Control: no-store`). Les erreurs ne renvoient pas les messages bruts du fournisseur. La limitation de 30 lectures par minute est en mémoire et par instance ; elle ne constitue pas une limite distribuée. Le budget serveur partagé est de huit secondes, celui du client de dix secondes.

## Indicateurs et interface

- Nombre exact de profils enregistrés.
- Abonnements au statut actif, hors plans gratuits ou vides.
- Agents activés dans le catalogue : cet état ne prouve pas leur exécution.
- Dix derniers profils au maximum, avec identifiant, nom et date ; sans adresse email.

Chaque métrique est soit `available` avec un entier, soit `unavailable` avec `null`. Un zéro confirmé reste un zéro. L'échec d'une lecture n'invalide pas les lectures réussies.

L'interface affiche la portée et l'heure de lecture. Elle propose l'actualisation manuelle et une actualisation toutes les minutes lorsque la page est visible, avec un interrupteur. Les résultats sont liés au compte courant et les réponses tardives sont ignorées après annulation ou changement de compte. Les connexions financières et les commandes globales IAO sont signalées comme non raccordées.

## Validation initiale de la PR16

| Contrôle | Résultat |
|---|---|
| Tests du contrat client et du handler serveur | 47 tests réussis. |
| Navigateur Chrome, composant et CSS réels, identité et API simulées | 16 scénarios réussis ; réseau externe bloqué. |
| Typage strict du périmètre modifié | Réussi. |
| Typage du point d'entrée Deno | Réussi. |
| Compilation Vite | Réussie avec des variables publiques de test. |
| Typage global historique | Limité par quatre fichiers de tests existants important `vitest`, absent des dépendances disponibles. |
| Analyse d'impact du composant chargé dynamiquement | UNKNOWN ; route/import examinés et scénarios navigateur vérifiés. |
| Authentification, configuration, données et déploiement réels | Non testés par cette recette locale. |

Commandes :

```bash
node --test tests/founder-dashboard/client.test.mjs tests/founder-dashboard/server.test.mjs
deno check --cached-only --no-config supabase/functions/founder-dashboard/index.ts
node node_modules/typescript/bin/tsc --noEmit -p tests/founder-dashboard/tsconfig.json
npm run test:founder:browser
node node_modules/vite/bin/vite.js build
```

La recette navigateur utilise Chromium installé par `npx playwright install chromium`. Pour réutiliser un navigateur local, définir `PLAYWRIGHT_EXECUTABLE_PATH` vers son exécutable, comme pour `npm run test:quality`. Son lanceur et ses mocks sont dans `tests/founder-dashboard/browser/`. Le lanceur régénère ses preuves dans `docs/founder-dashboard/evidence/`, dossier exclu du suivi Git. Les valeurs des tests sont synthétiques.

Avant activation, vérifier sur le service de recette : compte propriétaire autorisé, compte tiers refusé, accès anonyme refusé, refus des appels directs non autorisés, correspondance de l'UUID et du domaine, puis rapprochement des compteurs avec la base. Une recette simulée ne prouve pas ces conditions.

## Références

- [Supabase : vérification d'un utilisateur](https://supabase.com/docs/reference/javascript/auth-getuser)
- [Supabase : identité et métadonnées](https://supabase.com/docs/guides/auth/users)
- [Supabase : autorisation des fonctions](https://supabase.com/docs/guides/functions/auth)

## Composition du 10 novembre 2026

Le typage global de l’application assemblée réussit avec les dépendances de PR15 ; la limite Vitest de la validation initiale ci-dessus ne s’applique donc plus à ce candidat. Les tests client/serveur, Deno, contrats SQL, commerce et navigateurs sont désormais câblés dans le workflow. Les preuves et limites finales sont décrites dans [le rapport d’intégration](../qa/iao-integration-20261110.md). Le workflow distant reste à exécuter après déverrouillage du compte GitHub ; son ajout ne prouve pas une exécution distante.
