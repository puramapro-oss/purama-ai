# IAO — continuité de création, 24 novembre 2026

Ce lot complète les composants existants sur `e81129a56e07535129827c95211d82815df8dc5a`. Il conserve les corrections de rétention et de preuve des PR104/106/107. L'autorisation et les critères de réception sont consignés dans `scope.json` ; aucune seconde orchestration, mémoire persistante ou identité de projet n'est créée.

## Fonctionnalités reçues localement

- **Conversation → Atelier** : préparation locale et éditable du dernier objectif et de son contexte, dans la limite de 6 000 caractères. La réduction du contexte est explicitement signalée. Les notices et la réponse provisoire arrêtée sont exclues. La conversation et la saisie source restent présentes. Le transfert ne lance ni modèle ni mission ; le lancement explicite utilise le projet autorisé et la clé d'idempotence existants.
- **Reprise protégée** : un transfert contient son compte, son identité et sa date. Le transfert frais prime sur une ancienne copie de session ; un transfert d'un autre compte est refusé. Une nouvelle demande reçue dans un Atelier déjà monté est proposée sans écraser le texte présent. Le choix garder/remplacer est explicite. Le stockage reste le slot existant, avec sa durée de 20 minutes.
- **Mémoire utile** : après validation complète, filtrage d'autorisation/sensibilité et classement, un extrait de texte exactement identique n'occupe qu'une fois le budget de contexte. Les sources stockées, leur historique et les textes distincts restent inchangés. Ce résultat mesure la projection de caractères, pas un gain de qualité de modèle, de tokens facturés ou de latence réelle.

La reprise du brouillon invité OriginForge est conservée. Le bouton de transfert du chat est limité au compte connecté ; la conservation d'une conversation invitée après authentification n'est pas ajoutée par ce lot.

Ce transfert fournit un brief textuel éditable. La liaison durable conversation–mission–fichiers–scène AR reste une intégration distincte ; elle n'est pas déclarée terminée par ces ajouts.

La réception native a exécuté les 5 scénarios Atelier et les 51 scénarios chat : 56/56 réussis, aucune nouvelle tentative, aucun cas ignoré ou instable. Les trois nouveaux parcours sont également sélectionnés dans la matrice existante sur ses cinq profils, soit 15 exécutions CI supplémentaires. Leur collecte locale ne vaut pas exécution multi-moteurs ; les résultats exacts sont ceux du job CI reçu.

## Preuves et portée

| Contrôle | Preuve |
|---|---|
| Projection mémoire : 22/29 avant, 29/29 après ; régression adaptateur/runtime 188/188 | `memory/qualification.json`, `memory/evidence.zip` |
| Trois défauts Atelier reproduits avant correction ; pannes complètes de stockage reproduites puis corrigées | `workshop/` |
| Revue statique ESLint des quatre fichiers UI produit | `eslint.json` |
| Réception macOS avec navigateur natif et transports simulés | `native/` |
| Impacts GitNexus avant modification, index ciblé et détection finale | `impacts/`, `graph/` |
| Compilation, typage et suites complètes de l'arbre publié | Jobs de la PR associée à cette branche ; résultats reçus séparément après publication |

Les répétitions de suites se recouvrent : les 29 cas de projection sont inclus dans les 188 cas adaptateur/runtime. Les tests natifs et CI reprennent des scénarios communs ; leurs nombres ne doivent pas être additionnés comme des fonctionnalités distinctes.

Le banc Atelier conserve ses assertions métier et ajoute une isolation explicite du trafic de page : ressources locales, mutations simulées, aucune transmission de requête inattendue. Les captures sont écrites dans le répertoire de résultat du test, sans écraser les preuves historiques. La CI conserve ce résultat en artefact. Cette isolation de page ne qualifie pas l'ensemble du réseau du système d'exploitation.

## Limites actives

- **PARTIEL — persistance après indisponibilité totale du stockage.** Un indicateur éphémère empêche la réapparition d'une copie connue comme périmée tant que l'incarnation du module subsiste. Si tous les accès persistants sont refusés puis que la page est détruite, une suppression durable ne peut pas être attestée. Le slot et sa durée existants restent inchangés.
- **BLOQUÉ — composition réelle IAO.** La qualification complète exige l'autorité de session existante, le port SMARANA durable et le serveur local Compute Fabric RPC/2 compatibles. La présence d'un socket ou d'un paquet ne prouve pas leurs contrats. Le démarrage par défaut n'active pas un runtime incomplet et conserve le refus explicite `503`.
- **NON TESTÉ — gain sur modèle réel.** Aucun appel de modèle réel, benchmark comparatif de qualité, consommation facturée ou vitesse d'inférence n'est revendiqué. Aucune nouvelle dépense de service n'est introduite.
- **NON TESTÉ — appareils physiques et AR.** Les parcours navigateur et les dimensions émulées ne qualifient pas une caméra, un clavier mobile natif, un casque ou tous les appareils.

DreamForge est reçu dans sa livraison canonique distincte, sous le même identifiant de fichier et avec contrôle de version. Son historique partagé n'est pas copié dans ce dépôt. La réception de cette archive est suivie dans la page de continuité IAO.

La publication vise uniquement `audit/reliability-oauth-20261110`. La branche de ce lot a les déploiements Vercel désactivés. La réception de code ne constitue pas une mise en production ni une qualification de l'ensemble des 168 capacités prévues.
