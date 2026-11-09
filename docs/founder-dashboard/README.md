# Tableau de bord privé du fondateur

## Portée du changement

Ce lot renforce la route existante `/admin/dashboard` pour le périmètre de données `purama_ai`. Il réutilise la branche `codex/security-integration` et sa suppression préalable des indicateurs de démonstration.

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

## Validation du candidat

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
node tests/founder-dashboard/browser/run.mjs
node node_modules/vite/bin/vite.js build
```

La recette navigateur utilise Chrome installé et les dépendances existantes du projet. Son lanceur et ses mocks sont dans `tests/founder-dashboard/browser/`. Le lanceur régénère ses preuves dans `docs/founder-dashboard/evidence/`, dossier exclu du suivi Git. Les valeurs des tests sont synthétiques.

Avant activation, vérifier sur le service de recette : compte propriétaire autorisé, compte tiers refusé, accès anonyme refusé, refus des appels directs non autorisés, correspondance de l'UUID et du domaine, puis rapprochement des compteurs avec la base. Une recette simulée ne prouve pas ces conditions.

## Références

- [Supabase : vérification d'un utilisateur](https://supabase.com/docs/reference/javascript/auth-getuser)
- [Supabase : identité et métadonnées](https://supabase.com/docs/guides/auth/users)
- [Supabase : autorisation des fonctions](https://supabase.com/docs/guides/functions/auth)
