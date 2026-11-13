# Qualification de l’atelier IAO

Statut du code testé : PASS après corrections. Statut produit global : PARTIEL, non déployé.

Les 303 cas ciblés correspondent à 276 tests KARTA du nouvel atelier, 19 tests frontend, 3 scénarios navigateur et 5 courses PostgreSQL natives. Le lot final KARTA a d’abord produit 275 PASS et un échec de la fenêtre d’attente du préflight Git dans le test d’arrêt. Après correction de cette attente de fixture, les 31 tests complets de l’adaptateur sont PASS. Le délai et la procédure d’arrêt en production n’ont pas été assouplis.

Un test existant de timeout du superviseur supposait que Node démarrait en moins de 500 ms. Sa fixture utilise maintenant /bin/sh avec SIGTERM ignoré et un effet après 900 ms : l’assertion de transition seulement après fin réelle reste identique. Ses 20 tests sont PASS. Les deux autres échecs initiaux KARTA étaient des délais PGlite sur le Mac chargé ; le rejeu Node22 valide les 72 cas concernés. Le premier balayage KARTA comptait 2709 PASS / 3 échecs sur 2712 tests ; ce n’est pas présenté comme un balayage global vert.

Le balayage frontend initial comptait 387 PASS / 22 échecs : l’ancien test CinematicIntro recevait localStorage indéfini sous Node26. Ses 22 cas passent sous Node22, version utilisée par la CI. Les 19 tests atelier repassent également après le dernier ajustement de nettoyage React.

Typecheck frontend et KARTA, builds frontend et KARTA, Deno check du proxy, lint des fichiers ajoutés/modifiés et git diff --check : PASS. Le contrôle GitNexus trouve 15 chemins d’exécution affectés et un impact global HIGH (entrée App et serveur API). Il complète les tests, sans certifier la production.

## Essai fournisseur

Deux appels Codex réels, dans des dépôts temporaires isolés, ont testé l’adaptateur. Le premier a révélé l’impossibilité de créer .git/index.lock dans le sandbox. Le code corrigé garde ce sandbox et délègue l’enregistrement à un helper serveur limité aux fichiers autorisés, avec index privé, absence de hooks/filtres et mise à jour conditionnelle de la branche.

Le second appel a rendu completed, avec SHA observé 8fd73068c1321a16bf3b9ca5fc3336b71c3825dc et arbre Git propre. La page générée est conservée dans live-output/index.html. Le contrôle navigateur vérifie trois clics puis une activation clavier, compteur à 4, langue française, absence de débordement à 320 px, aucune requête externe et aucune erreur JavaScript. Voir live-browser.json et les captures live-created-*.png. Les coûts monétaires ne sont pas connus ; seuls les compteurs CLI rapportés sont conservés.

Les captures workshop-*.png proviennent du harnais avec réponses de test explicites. Elles montrent l’interface, pas des missions de production.

## Périmètre restant

Le démarrage réel --check de cet hôte échoue proprement avec WORKSHOP_CONFIG : aucun catalogue de projets autorisés n’y est enregistré. Aucun daemon permanent, migration de production, fusion ou déploiement n’a été effectué. La branche repose sur la PR45 encore en brouillon. L’éditeur Origin/N04, la sélection des capacités de la PR68, l’aperçu progressif/édition visuelle, les exports mobiles et la publication publique ne sont pas déclarés intégrés par ce lot.

Avant ouverture aux utilisateurs : rapprocher les branches, appliquer la migration 030, enregistrer des worktrees et profils de confiance, utiliser des environnements d’exécution isolés par client, activer le consommateur et le proxy, puis tester la chaîne authentifiée sur l’environnement cible. WORKSHOP.md décrit ces prérequis ; aucun accès à un projet client ne se déduit du seul droit de se connecter à IAO.
