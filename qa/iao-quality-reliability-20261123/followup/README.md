# IAO Audit complémentaire des appels et des reprises

Date : 23 novembre 2026. Base : `26eb27298976a8dd0cf1397f7bbaff00ea4360a3`, après fusion de la PR 100. Branche : `fix/iao-audit-depth-20261123`.

## Corrections et résultat local

Le catalogue ne partageait pas ses chargements encore en cours. Une rafale contrôlée de 32 demandes exécutait 32 GET identiques. Le même scénario exécute maintenant un seul GET, en conservant 32 contrôles budgétaires propres aux utilisateurs, les mêmes modèles et les mêmes plafonds. Ce partage reste limité à une instance d’hôte et à sa politique fournisseur. Il ne contient ni conversations privées ni réponses générées.

Les tests ont également reproduit une publication de catalogue après expiration de la politique ou annulation pendant le contrôle de disponibilité. Enfin, deux fenêtres laissaient partir une génération après expiration pendant le contrôle d’arrêt ou pendant la réservation. Des contrôles synchrones supplémentaires suivent désormais ces attentes. Une réservation déjà effectuée reste réconciliée par le traitement existant ; le correctif ne fabrique ni coût ni consommation fournisseur.

Le partage conserve l’annulation individuelle, l’abandon du dernier demandeur, la reprise après échec, le cache vide de 60 secondes et l’isolation entre hôtes. Une ancienne réponse tardive ne remplace pas le cache courant. Le chargement partagé et chaque attente sont bornés à cinq secondes.

## Contrôles locaux exécutés

| Contrôle | Résultat | Preuve |
| --- | --- | --- |
| Catalogue, hôte, profils, intégration et transport des profils | 87 tests PASS dans cinq suites, dont 13 nouveaux | `cost-latency/manifest.json` et journaux référencés |
| Consultation, transport HTTP et reprise SQL composés sur le produit final | 108 tests PASS dans trois suites, dont les six nouveaux de persistance | `root-gates.json`, `composed-final.log` |
| TypeScript KARTA | PASS | `cost-latency/typecheck-final-command.json` et journal référencé |
| Compilation KARTA sur le produit final | PASS | `root-gates.json`, `build-final.log` |
| Revue indépendante du cache et des autorisations | PASS, aucun défaut P1/P2 restant identifié dans ce périmètre | `cost-latency/independent-review.json` |
| Revue indépendante des nouveaux tests SQL | PASS | `persistence/independent-review.json` |
| Audits réels npm du site et de KARTA, verrous complets | Aucune alerte modérée, élevée ou critique ; un avis faible transité par trois paquets du site | `dependency-security/manifest.json` |
| Compatibilité et chemin de signature concerné | Six tests ciblés existants PASS | `dependency-security/targeted-verification.json` |

Les exécutions intermédiaires ne sont pas additionnées. Les 19 nouveaux cas comprennent les 13 tests d’hôte et les six tests de reprise SQL. Les suites complètes, les nouvelles étapes d’audit CI et l’intégration du commit publié sont attestées séparément par les workflows et la PR associés à cette branche.

## Reprise SQL nouvellement éprouvée

Six scénarios exécutent les migrations et le store de production sur PostgreSQL compilé en WASM via PGlite. La confirmation est perdue après le succès réel de l’écriture SQL pour la création, le démarrage, la réservation, le reçu fournisseur, la finalisation et l’annulation préalable. Un nouvel adaptateur retrouve les données. Les assertions vérifient l’unicité, les conflits, l’isolation du compte, l’absence de seconde autorisation, les usages appliqués une seule fois et les coûts inconnus laissés inconnus.

Ces scénarios n’ont pas révélé de défaut du store ou des migrations, restés identiques à la base. Ils ne simulent ni un redémarrage de PostgreSQL, ni une panne de volume, ni plusieurs processus natifs, ni un transport PostgREST réel. Les cinq tests PostgreSQL natifs déjà présents dans la CI ne sont pas présentés comme de nouveaux contrôles.

## Audit des dépendances désormais exécuté sur les PR

Les deux étapes npm du workflow `PURAMA CHEF hardening` étaient exclues des PR. Elles exécutent maintenant `npm audit --package-lock-only --audit-level=high --ignore-scripts`, dépendances de développement incluses, avec les mêmes droits `contents: read`. Aucun paquet ou verrou n’est modifié.

L’avis résiduel [GHSA-848j-6mx2-7j84](https://github.com/advisories/GHSA-848j-6mx2-7j84) concerne la signature ECDSA d’elliptic et n’annonce pas de version corrigée. Les trois entrées sont une seule chaîne `opentimestamps → bitcore-lib → elliptic`. Le parcours de preuve exercé ne déclenche aucun appel à cette signature ; l’avis reste néanmoins ouvert. La rétrogradation majeure suggérée automatiquement par npm n’a pas été appliquée.

Un contrôle borné de six motifs a examiné 169 fichiers sources suivis sans correspondance. Il ne couvre pas tout l’historique Git ni les secrets et configurations déployés.

## Impact, portée et limites

Les analyses préalables classent `models` HIGH et `catalog` CRITICAL ; les avertissements ont précédé les modifications. `authorize` est LOW. Le wrapper de réservation reste UNKNOWN dans le graphe ; ses appels effectifs sont confirmés par les sources et les contre-exemples. FTS est indisponible et les parcours du graphe sont bornés : un résultat absent ne prouve pas l’absence d’un effet. Les analyses finales et leur portée figurent dans `gitnexus-receipt.json`.

Le gain 32 → 1 mesure les GET du catalogue dans une rafale avec transport fournisseur simulé. Il ne mesure pas une réduction de facture, un débit distribué ni une latence de production. Aucun modèle, niveau de réflexion, plafond ou enveloppe de coût n’a été abaissé. Aucun appel réel à un modèle payant, déploiement, installation ou interruption de session native n’est effectué dans ce lot. Le déploiement automatique de la branche est désactivé.

La PR 99 mobile/SMARANA reste distincte. La lecture ciblée du worktree Mac T03 confirme une autre révision avec trois modifications de documents et sans les modules consultation : `native-observation.json`. Cette lecture n’identifie pas à elle seule le runtime réellement exécuté et ne vaut pas installation du correctif.

## Intégrité des journaux

Les reçus des sous-lots gardent leurs dates, commandes, codes de sortie et empreintes d’origine. Si une sortie terminal contient des espaces de fin de ligne ou des lignes vides finales incompatibles avec le contrôle Git, sa copie lisible est normalisée et son contenu UTF-8 exact est préservé dans `raw-terminal-output.json`. `terminal-output-normalization.json` associe les empreintes brutes et normalisées. Les empreintes de journaux présentes dans les reçus antérieurs désignent alors les copies brutes, sans modification des résultats de test.
