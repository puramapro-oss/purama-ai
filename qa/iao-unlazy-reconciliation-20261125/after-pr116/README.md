# Réconciliation avec PR116 — 25 novembre 2026

La première composition publiée `7a38c30d` a reçu ses deux workflows SUCCESS :
5 474 tests KARTA sur 226 fichiers, dont les 13 fixtures Fabric, et tous les jobs
CHEF, y compris le site et les profils navigateur. Cette preuve reste attachée
à son arbre `6340c49710aa8721ef60ef09659cbec87b9456f3`.

Pendant sa qualification, l'intégration a avancé de `d25f2e72` à `2557f304`,
par intégration qualifiée de PR116 (lectures programmatiques). Le Git distant
indiquait cette nouvelle tête alors que le snapshot REST de PR122 conservait
encore l'ancienne base. Le conflit constaté est résolu par composition, sans
forcer la branche cible ni abandonner le nouveau travail.

## Composition conservatrice

- Parents : `7a38c30dd7d0161366e0d15e38c506435950bc68` et
  `2557f304c9c59633b63de95bd298216574679966`.
- Seul chemin commun aux deux deltas depuis d25 : `vercel.json`.
- Résolution : union des 59 règles de déploiement, valeurs et autres propriétés
  conservées. Les deux branches de revue restent désactivées pour Vercel.
- Tous les autres blobs des deux lots sont conservés à l'identique.
- Aucune fonction, migration ou règle métier n'est réécrite dans cette réunion.
  Le mode programmatique demeure désactivé selon son contrat existant.

## Qualification locale

**389/389 assertions dans dix fichiers passent**, sur les suites observation,
retour correctif, boucle de correction, politique et intégration programmatique.
Le typage KARTA passe. Les compteurs de suites internes de Vitest ne sont pas
confondus avec le nombre de fichiers. Les tests de sockets déjà refusés par le
conteneur ne sont pas assouplis ; la nouvelle CI hébergée doit les qualifier.

GitNexus a reconstruit un index borné CHEF/Claude/engine/Fabric. La détection
staged de l'intégration de PR116 rapporte 170 symboles et 49 flux, risque CRITICAL.
Le moteur signale des flux non couverts ; son résultat reste une borne partielle.
La comparaison avec main est archivée séparément, car elle inclut tout l'historique
de consolidation. Le seul conflit résolu manuellement est un objet JSON, sans
édition de symbole applicatif.

Les rapports sont liés à l'arbre produit `db4c848b28bd426977c570eef83afaa683984ea8`.
Les changements ajoutés après ce contrôle sont uniquement ce dossier de preuves.
La CI de la nouvelle composition doit être reçue avant son intégration.

Aucun service, paiement, migration, génération ou déploiement n'est activé.
