# IAO — intégration des candidats existants, 13 novembre 2026

Cette réception rapproche PR68/73, PR71 et PR74 sur la consolidation PR45. Aucun nouvel orchestrateur, compte, portefeuille ou déploiement n’est créé.

Le client commun conserve le modèle choisi et le transport local qualifié. Une préférence incompatible ou une réponse portant un autre modèle est refusée, avec comptabilité conservée. Le catalogue accepte les identifiants locaux contenant `@`. L’adaptateur direct Codex refuse une sélection de capacités qu’il ne sait pas appliquer avant tout lancement, sans la perdre silencieusement.

Les migrations sont désormais `030_chef_capability_selection.sql` puis `031_chef_workshop.sql`, chargées ensemble dans les recettes atelier. La CI exécute les cinq courses PostgreSQL atelier dans un cluster privé et échoue si les binaires manquent. Son rapport va dans `test-results/` ; les preuves datées du 12 novembre restent intactes.

**PASS local :** 3 136 tests KARTA, 434 tests interface, huit tests HTTP natifs, types/builds, contrats générés, assets hors connexion et lint (zéro erreur, 21 avertissements existants). Les 98 tests de modèle rejoués sont inclus dans le total KARTA. Les premières interruptions mémoire sont conservées.

**NON TESTÉ localement :** PostgreSQL natif, absent de cet environnement ; son absence retourne bien un code non nul. La réception CI du nouvel arbre doit confirmer ces courses et l’ensemble des contrôles. La production, les fournisseurs réels, les capacités atelier, la consultation raccordée, les appareils natifs et l’endurance restent hors de cette preuve.

Les versions, empreintes, résultats et limites du graphe figurent dans [verification.json](verification.json). Le risque d’impact agrégé est CRITICAL ; les listes du graphe sont bornées et ne prouvent pas l’exhaustivité.
