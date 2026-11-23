# Qualification UI IAO — inventaire et limites

Date : 23 novembre 2026. Base inspectée : `970ff2255e2037625a62745ecac3e6cd9c04b702`.
Responsable : `qual_ui`. Périmètre : client consultation, panneau consultation et parcours réels du widget dans le harnais navigateur existant.

## Contrôles effectivement présents

| Profil | Accès constaté dans le code | Sélection effectivement offerte |
| --- | --- | --- |
| Visiteur / session anonyme | Conversation publique ; aucune consultation privée | Aucun sélecteur technique de consultation |
| Membre authentifié | Conversation / Analyse approfondie | Premier modèle du catalogue offrant `auto` et `standard`, sans avis supplémentaires par défaut |
| Compte à adresse du fondateur non vérifiée | Même présentation publique que le membre | Aucun accès aux réglages techniques |
| Fondateur vérifié | Analyse approfondie + détails techniques | Modèle principal, réflexion, vitesse, modèles d’avis supplémentaires optionnels et recherche publique explicite |

Les quatre valeurs de réflexion reconnues sont `auto` (« Automatique (standard) »), `standard` (« Standard »), `deep` (« Approfondie ») et `maximum` (« Maximale »). Les trois vitesses sont `standard`, `fast` et `ultra_fast`. Les combinaisons offertes dépendent des profils annoncés par le catalogue serveur ; le client ne doit pas en inventer. Les douze combinaisons du catalogue synthétique de test couvrent la transmission de ces valeurs, sans prétendre qu’un fournisseur réel les accepte toutes.

Sources : `src/components/ConsultationPanel.tsx`, `src/components/ChatbotWidget.tsx`, `src/lib/consultation-client.ts`, `karta/src/api/consultation-contract.ts`.

## Manques à distinguer des défauts

- Les modes publics envisagés `FLASH`, `EXPERT`, `APEX` et les trois niveaux publics `RAPIDE`, `APPROFONDI`, `MAXIMUM` n’ont pas été retrouvés comme choix utilisateur reliés à ce parcours dans `src`, `karta/src` ou `supabase/functions`. Les réglages techniques du fondateur ne constituent pas cette offre publique. Aucun écran ni règle d’accès ne sont inventés dans cette correction.
- Une question est bornée à 8 000 caractères et l’ensemble du JSON transmis à 65 536 octets UTF-8. Les essais de grands contenus restent dans ce contrat ou vérifient son refus explicite. Ils ne prouvent pas la prise en charge d’un projet de taille arbitraire.
- Le stockage navigateur de reprise conserve seulement l’UUID d’opération par compte dans `sessionStorage`. Il ne constitue pas une sauvegarde universelle des créations ou des conversations.
- La qualité sémantique, les coûts, les latences fournisseurs, les services Supabase/Deno réels, le fonctionnement intégral hors ligne et tous les appareils restent hors de la preuve de ce harnais. Le responsable racine traite séparément les essais de runtime réel disponibles.

## Couverture existante et ajout ciblé

Le dépôt possédait des tests unitaires de frontière client, de panneau consultation et de liaison au widget (`src/lib/consultation-client.test.ts`, `src/components/ConsultationPanel.test.tsx`, `src/components/ChatbotWidget.consultation.test.tsx`). Les 24 scénarios Playwright existants de `tests/chat/lifecycle.spec.ts` portent sur la conversation ; aucun fichier navigateur de consultation n’existait à cette base.

La nouvelle suite `tests/chat/consultation.spec.ts` déclare 24 scénarios :

1. Douze combinaisons réflexion/vitesse avec identifiants de révision, tailles de question de 64 à 8 000 caractères, choix du modèle et une soumission clavier.
2. Deux présentations publiques : membre et compte du fondateur non vérifié.
3. Visiteur et session anonyme sans accès à la consultation privée.
4. Choix d’avis supplémentaires conservé après un profil plus restrictif, avec correction explicite requise avant envoi.
5. Dépassement du poids combiné UTF-8 refusé avant requête.
6. Fermeture/réouverture avec lecture de statut, sans réenvoi.
7. Réponse d’erreur amont malformée puis rechargement, UUID seul conservé, récupération par statut sans réenvoyer une opération incertaine.
8. Annulation durable avec même identité et réponse tardive ignorée.
9. Changement de compte sans résultat ni récupération du compte précédent.
10. Réponse partielle de 32 000 caractères, HTML traité comme texte, viewport étroit sans débordement horizontal.
11. Deux soumissions dans la même tâche navigateur n’admettent qu’une seule opération.
12. Recherche publique explicite et avis choisi transmis sans ajouter la question privée aux champs de recherche.

La suite réutilise `tests/chat/{fixtures,transport,auth,harness,vite.config,playwright.config}`. Elle charge le navigateur, React et le client réels ; les identités et réponses HTTP sont simulées. Les requêtes externes sont bloquées. Aucun compte ni appel IA réel n’est créé ou consommé. La configuration `testMatch: '*.spec.ts'` inclut automatiquement ce fichier dans `test:chat`.

## Défaut reproduit avant correction

**Identifiants de modèles contenant `@`.** Le validateur du profil d’exécution de `karta/src/claude/execution-profile.ts` accepte un identifiant comme `studio/primary@revision-2`. Le client emploie un validateur générique qui le refuse lors de la lecture du catalogue, de l’envoi du modèle/avis choisi et de la lecture d’un résultat existant. Trois nouveaux tests reproduisent ces trois refus ; un quatrième contrôle que les valeurs malformées et les identifiants de source contenant `@` restent refusés. Cette reproduction concerne le client et ne prouve pas l’acceptation par toutes les frontières serveur.

**Frontière HTTP supplémentaire identifiée après la revue croisée.** La source de `karta/src/api/consultation.ts` emploie encore un `IDENTIFIER` excluant `@` pour les modèles et avis entrants, ainsi que les projections du catalogue et du résultat. La correction client est donc nécessaire mais ne suffit pas au support de bout en bout. `qual_profiles` est responsable de la reproduction HTTP, de sa correction éventuelle et de sa vérification ; leur résultat n’est pas présumé dans ce reçu. Le code du lot UI reste figé pendant cette qualification.

Preuve unitaire initiale : `client-revision-red.json` et `client-revision-red.log` — 35 tests, 3 échecs et 32 réussites, sortie du test 1. Aucun appel fournisseur réel.

Le premier lancement Chromium est **BLOQUÉ avant chargement de l’application** par `socket() failed: Operation not permitted`. Le reçu `browser-revision-red.json` et son journal décrivent ce blocage environnemental, pas un échec fonctionnel UI. La suite navigateur n’est pas déclarée exécutée avec succès tant qu’un navigateur autorisé n’a pas démarré.

Les résultats finaux, impacts GitNexus, reçus et empreintes sont ajoutés dans ce même répertoire au fil de la qualification. Aucun constat de cette note n’autorise à annoncer un résultat universel ou une mise en production.

## État de remise à l’intégration

| Contrôle | État | Preuve |
| --- | --- | --- |
| Reproduction du défaut `@` avant correction | PASS : 3 échecs attendus sur 35 tests | `client-revision-red.{json,log}` |
| Impacts des validateurs `catalog`, `input`, `plan` | PASS : trois risques LOW | `impact-preedit.json`, `context-resolve.json` |
| Client corrigé, panneau et liaison widget | PASS : 83 tests / 3 fichiers | `client-and-components-green.{json,log}` |
| Support de `@` à travers la frontière HTTP réelle | PARTIEL : autre validation serveur incompatible identifiée ; reproduction de bout en bout attendue | `karta/src/api/consultation.ts`, responsable `qual_profiles` |
| ESLint des trois fichiers TypeScript concernés | PASS, aucune sortie de diagnostic | `lint.{json,log}` |
| Découverte Playwright | PASS : 48 scénarios, dont 24 nouveaux de consultation | `browser-discovery.{json,log}` |
| Exécution Chromium locale | BLOQUÉ avant toute page : socket refusé | `browser-revision-red.{json,log}` |
| Exécution des nouveaux parcours en CI | NON TESTÉ dans ce reçu local ; responsable racine | Commande existante `npm run test:chat` |
| Qualité d’une IA réelle et déploiement | NON TESTÉ par cette qualification UI | À distinguer des réponses synthétiques |

La correction ajoute un validateur d’identifiant de modèle conforme au contrat du profil d’exécution et l’utilise pour le catalogue, le modèle sélectionné, les avis sélectionnés et le résultat. Cette conformité locale ne constitue pas une validation de toute la chaîne HTTP. Le validateur d’identité générique n’a pas été modifié. Aucun composant produit, règle d’accès, dépendance, migration ou workflow n’a été changé par ce lot. La documentation du harnais a été mise à jour.

Les impacts sont bornés au client : `catalog` appelle la méthode de catalogue (1 dépendant ; le graphe prévient que 6 sites d’appel de méthode restent non résolus), `input` affecte la méthode `consult` (1 dépendant) et `plan` affecte `result`, puis `operation`, `lookup` et `consult` (4 dépendants). Aucun processus n’a été identifié par le graphe. Les tests couvrent la frontière que cette limite d’analyse statique ne permet pas de garantir seule.

Les empreintes des quatre fichiers du lot sont dans `source-manifest.json`. Aucun commit ni push n’a été effectué par `qual_ui`. Le responsable racine conserve la vérification GitNexus finale et l’exécution navigateur dans la CI existante.
