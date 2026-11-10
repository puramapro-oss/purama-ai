# Réconciliation CHEF des PR #21 et #27

Base : PR #27 `5f8d23d46b1aaa103eccb944406eb3e189388c1c`, avec le correctif OpenTimestamps. Source des réservations : PR #21 `b826af125ce296d3808d3b71b93fd084e63dbdb7`. Les autres changements de délégation et d'approbation de #21 ne sont pas intégrés par ce complément.

## Défauts reproduits et correction

Sur la base #27, le banc local admettait une seconde tâche estimée à 70 sous un plafond de 100 après le blocage d'une première tâche estimée à 70 sans reçu fournisseur. La réservation dépendait de l'état actif de la tâche. Le superviseur pouvait aussi substituer zéro à un coût absent, ignorer l'absence d'accusé de réconciliation et abandonner un reçu arrivé après la perte de lease. Avant correction, les 16 scénarios de comptabilité/adaptateur repris de #21 produisent 14 échecs et deux réussites.

La migration **024** reprend le journal `chef_budget_reservations` de #21, associé à la tâche, la tentative, le fencing token, le worker et le provider. La réservation survit au blocage et à la reprise ; les consommations inconnues restent `NULL`. Chaque dimension connue est réglée une seule fois, même avec un nouvel identifiant de reçu. Les reçus contradictoires sont refusés. Une tâche plafonnée ne peut devenir `verified_done` tant que sa consommation requise reste inconnue.

Le runtime utilise `chef_record_claim_usage` et exige un retour booléen valide. Un accusé faux bloque la validation ; un accusé mal formé est une erreur. Les clés de reçu distinguent une valeur absente d'un zéro explicite. Un reçu tardif règle sa génération d'origine sans autoriser sa validation après perte de lease. Une consommation nulle n'est déclarée que si le driver n'a pas été invoqué. Une exception, un arrêt confirmé ou une quarantaine après démarrage ne prouve pas un coût nul.

L'ingestion stricte des estimations de **022**, le diagnostic de budget de **021** et la quarantaine persistante de **023** sont conservés. Un reçu fournisseur ne constitue jamais une preuve d'arrêt d'un processus et ne lève aucune quarantaine.

## Validation nouvelle du 10 novembre 2026

| Contrôle exécuté | Résultat |
|---|---|
| Suite KARTA complète sur les sources réconciliées | **980/980 PASS**, 68 fichiers, aucun échec ni cas pending ; sortie 0 |
| TypeScript et compilation KARTA | **PASS**, deux sorties 0 |
| Reproduction 70 + 70 sous plafond 100, premier reçu absent | Échec attendu avant correction ; **PASS après 024**, deuxième admission refusée |
| Upgrade avec le vrai SQL #21 | **PASS dans PGlite** : réservation créée sous 018 de #21, puis 021/022/023/024 ; réservation conservée, reçu final 20 compté une fois, admission suivante 70 autorisée |
| Historique ambigu ou non réconcilié | Refus transactionnel vérifié, écritures et compteurs antérieurs conservés |
| Compatibilité OTS, migrations 019–023, processus/driver/daemon | Empreintes identiques à la base #27 |

La passe complète s'est déroulée de **04:46:34 à 04:49:11 UTC**, en 156,971 secondes, avec Node 24.22.1, Vitest 5.0.3, TypeScript 5.9.3 et PGlite 0.5.8 sur Linux, avec un seul worker. Les dépendances KARTA correspondaient exactement au manifeste et au lockfile ; le cache du banc était isolé. Les tests utilisent des credentials fictifs et refusent les appels réseau inattendus.

[Reçu, commandes exactes, empreintes et limites](reconciliation-validation.json) · [Rapport Vitest complet compressé](reconciliation-karta-tests.json.gz)

GitNexus a été exécuté avant les modifications puis avant commit. Le lot ciblé couvre 13 fichiers, 120 symboles et cinq flux signalés, risque **MEDIUM**. La comparaison avec `main` inclut les travaux antérieurs : 409 fichiers, 2 149 symboles et 377 flux, risque **CRITICAL**, liste tronquée. Ces risques ont été signalés ; les fonctions SQL ne sont pas couvertes par le graphe. La contre-revue indépendante des neuf sources et douze protections n'a identifié aucun défaut bloquant, sans revendiquer une seconde exécution de la suite.

Les 980 cas comprennent les sous-lots : leurs nombres ne doivent pas être additionnés. Les succès PostgreSQL natifs des rapports historiques de #21 et #27 ne constituent pas une validation native de cette combinaison. **La concurrence PostgreSQL native de 024 reste NON TESTÉE.** Aucun parcours navigateur, appel fournisseur réel, paiement, prospection ou déploiement de cette combinaison n'a été effectué.

## Ordre de migration et limites d'intégration

Conserver les prérequis de la base commune, notamment **019/020**, puis appliquer **021, 022, 023 et 024** dans cet ordre avec le runtime corrigé. Aucun ancien numéro ni SQL de migration n'a été modifié. Le fichier 018 de #21 n'est pas ajouté au répertoire des migrations : ce numéro entre en conflit avec une autre proposition existante. Il sert seulement de source et de scénario d'upgrade isolé.

Avant toute migration réelle, arrêter et drainer les anciens workers. Les claims actifs dont l'identité est établie sont importés ; un journal déjà présent est conservé. Un ancien historique plafonné sans réservation authentifiable, ou des reçus anciens mélangeant coût connu et coût ambigu, provoque un rollback explicite. Ce cas requiert l'examen des données et des reçus réels par l'opérateur : ne pas supprimer l'historique, remettre les compteurs à zéro ni fabriquer une consommation nulle pour franchir le contrôle.

Les estimations limitent l'admission ; elles ne garantissent pas la facture fournisseur. La validation concurrente sur PostgreSQL natif, les adaptateurs et reçus réels, la CI distante et la mise en service restent des contrôles séparés. Ce lot ne fusionne aucune PR et n'applique aucune migration en production.
