# IAO — qualification des profils, des parcours et du moteur local

Date : 23 novembre 2026, Europe/Paris. Base : `970ff2255e2037625a62745ecac3e6cd9c04b702` après la PR 101. Cette réception prolonge les travaux existants, sans remplacer leur historique.

**État avant intégration CI : PARTIEL. Le déploiement mondial et le parcours natif complet restent BLOQUÉS par des dépendances non qualifiées.** Les tests décrits ici ont une portée finie ; aucun résultat n'atteste toutes les demandes possibles, tous les appareils ou une absence générale de défauts.

## Corrections du lot

1. **Client de consultation.** Les positions contenant un identifiant de modèle acceptent le contrat du résolveur, y compris une révision avec `@`. La grammaire des identifiants de sources et de fournisseurs demeure stricte. Trois défauts unitaires étaient reproduits avant la correction ; 83 tests client/composants ont ensuite réussi. Cette correction seule ne qualifie pas un modèle révisé sur toutes les routes serveur.
2. **Banc LM Studio.** Le catalogue et le cache cloud ambiants ne peuvent plus empêcher la qualification explicite d'un modèle local. Le script existant emploie son catalogue local et conserve ses contrôles d'opt-in, modèle exact, capacités et résultats. Deux défaillances étaient reproduites ; les neuf cas du CLI corrigé réussissent. Les réponses du serveur de ce banc de régression sont synthétiques.
3. **Cohérence du catalogue natif.** La qualification a reproduit un modèle annoncé par le host mais impossible à représenter dans le contrat HTTP et les reçus comptables. Un appel direct au host produisait alors `accounting_unavailable` après l'inférence. La correction et sa réception sont détaillées dans `profiles/` : les modèles incompatibles sont écartés avant annonce, réservation et appel, sans substitution silencieuse. Les deux nouvelles régressions échouaient avant la correction et réussissent ensuite. Le contrat générique LM Studio n'est pas modifié.

## Ce qui est réellement exercé

| Couche | Exécution | Portée de la preuve |
| --- | --- | --- |
| Serveur et persistance | HTTP réel, catalogue et host de production, SDK installé, migrations SQL exécutées dans PGlite | Profils, réservations, isolation, reprise, projection des résultats et réconciliation ; réponses fournisseur contrôlées |
| CLI local | Véritable processus enfant et véritables sockets HTTP | Contrôles de qualification et séparation des configurations ; serveur/modèle synthétiques |
| Client et composants | Client réel et composants React testés | Validation des contrats et transitions d'interface |
| Navigateur | 24 nouveaux scénarios découverts par `test:chat`, en plus des 24 antérieurs | À confirmer par CI ; Chromium local échoue avant toute page. Authentification et HTTP restent simulés dans le harnais |
| Modèle local | Ollama réellement appelé sur le Mac avec `qwen3.5:4b` déjà présent | Sept cas avec oracles : cinq PASS et deux FAIL ; ce n'est pas le parcours complet IAO |

La matrice finale comprend **65 tests** ; les 29 tests existants du host ont également réussi après la correction (94/94 sur ce passage ciblé). Les 36 profils serveur correspondent à quatre familles de capacités : sans réflexion (6), budget de réflexion (12), réflexion adaptative (12), budget insuffisant pour l'approfondissement (6). Ils ne représentent pas 36 nouveaux modes publics. Le résolveur actuel transforme `auto` en `standard` ; il ne choisit pas la puissance à partir de la difficulté de la tâche.

Les essais comprennent des demandes jusqu'à 8 000 unités UTF-16, plusieurs alphabets, les limites du corps UTF-8, les avis supplémentaires, les réponses partielles, les refus, les erreurs 429, la substitution de modèle, les budgets absents ou expirés et l'absence de nouvelle inférence lors d'une reprise. Les tailles ne sont pas croisées exhaustivement avec chaque profil.

La matrice navigateur prévoit notamment membre, fondateur vérifié, adresse fondatrice non vérifiée, visiteur, session anonyme, changement de compte, double soumission, fermeture/réouverture, rechargement, annulation, retour tardif, clavier et viewport étroit. Les tests ne qualifient pas de véritables comptes utilisateurs, tous les handicaps ou tous les systèmes d'exploitation.

## Résultats réels du composant Ollama

| Cas | Résultat |
| --- | --- |
| Premier calcul avec plafond de 128 tokens | FAIL : HTTP 200, réponse finale vide et fin `length` ; conservé séparément |
| Même calcul par le transport compatible OpenAI avec plafond de 1 024 tokens | PASS, réponse `42`, 3 615,3 ms observées |
| Calcul natif avec réflexion demandée | PASS, réponse `42`, champ de réflexion présent, 1 962,9 ms |
| Calcul natif sans réflexion demandée | PASS, réponse `42`, champ de réflexion absent, 320,0 ms |
| Extraction multilingue sous schéma JSON | FAIL, HTTP 501 |
| Préparation d'un appel d'outil avec titre accentué | PASS, un appel exact, aucun outil exécuté, 529,0 ms |
| Référence retrouvée dans le contexte transmis | PASS, `AZUR-7391`, 160,9 ms |
| Petit plan de dépendances sous schéma JSON | FAIL, HTTP 501 |

Le diagnostic du serveur répond `structured output is unavailable`. Cette observation concerne le moteur et les poids réellement présents ; la prise en charge générale de JSON dans une documentation ne remplace pas ce résultat. Le socket Compute Fabric existe mais refuse la connexion. Aucun service n'a été démarré, remplacé ou reconfiguré, aucun poids téléchargé et aucun outil externe exécuté par ces essais.

Les durées sont des observations individuelles, dépendantes de l'état du modèle et du cache. Elles ne sont ni un percentile, ni une comparaison de qualité, ni une garantie de vitesse. Les compteurs et durées internes sont déclarés par Ollama ; `elapsed_ms` est mesuré par le banc. Les contrôles de champs de réflexion ne prouvent pas le fonctionnement interne du modèle. La restitution d'une référence fournie dans le prompt ne prouve pas une mémoire durable.

Aucun appel à une API externe payante n'a été effectué pour ces sondes. Le coût de l'électricité et du matériel n'a pas été mesuré.

## Conditions restant nécessaires pour le déploiement

| Condition | État et responsable technique |
| --- | --- |
| Exécution de la nouvelle suite navigateur sur le commit proposé | NON TESTÉ avant CI ; intégration racine |
| Raccordement public FLASH / EXPERT / APEX et RAPIDE / APPROFONDI / MAXIMUM | PARTIEL : décisions conservées, raccordement non présent dans les parcours inspectés ; orchestration et interface |
| Reprise des conversations et artefacts entre appareils et fournisseurs | PARTIEL ; mémoire et stockage, avec tests de coupure et reprise à compléter |
| Parcours natif IAO vers Compute Fabric | BLOQUÉ : connexion au socket refusée ; propriétaires du runtime natif T01/T03/T06 à réconcilier avec la coordination active |
| Sorties JSON contraintes sur le modèle local sondé | BLOQUÉ sur cette route, HTTP 501 ; qualification des capacités du fournisseur |
| Parcours authentifié jusqu'à un vrai modèle cloud et sa facture | NON TESTÉ dans ce lot ; compte et budget fournisseur à qualifier |
| Charge, quotas réels, reprise après panne de machine/base et durée de service | NON TESTÉ par ces nouvelles familles ; exploitation et qualification de préproduction |
| Demandes de taille arbitraire | Non garantie : le plafond public et les plafonds de contexte/budget sont distincts |

Une demande de 8 000 caractères CJK dépasse le plafond de contexte de 16 384 octets associé à la politique opérateur minimale. Le test confirme un échec conservé, sans appel ni dépense inventée. Une amélioration de découpage/reprise demanderait une qualification propre, sans relever arbitrairement les plafonds.

## Preuves et reproduction

- `profiles/qualification.json` et les reçus associés : matrice serveur, limites et correction de qualification du modèle.
- `ui/qualification.json`, `ui/independent-review.json` : client, composants, cas navigateur et limite d'exécution locale.
- `release/qualification.json` : CLI, readiness et reçus avant/après.
- `native/qualification.json`, `reasoning-results.json`, `structured-results.json`, `runtime-blockers.json` : observations locales réelles et échecs conservés.
- `gitnexus-baseline-summary.json` : index courant et limites de résolution. Les avertissements du graphe ne sont pas assimilés à une absence de chemin.

Les commandes ciblées figurent dans leurs reçus avec répertoire, sortie et empreintes. Les workflows existants exécutent les suites complètes lors de la PR. La publication du lot dans la branche de consolidation ne vaut pas déploiement de production.
