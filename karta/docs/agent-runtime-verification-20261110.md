# PURAMA / IAO — fiabilisation du moteur d’agents

## Périmètre

Ce lot renforce le moteur KARTA et le superviseur CHEF existants. Il part de
`audit/aether-karta-consolidation-20261110` au commit
`1daf6314d60f6dd336c3a3601ddf73cf432ef4b3`. Il ne crée pas de second orchestrateur.
Les changements sont préparés dans `codex/iao-agent-runtime-20261110`.

Résultat final : **PASS — 788 tests sur 788, 60 fichiers, typecheck et build.**

La validation porte sur le moteur, ses contrats et ses migrations. Aucun
déploiement, envoi de message, achat ou appel à un fournisseur IA payant n’a été
effectué. La supériorité commerciale, le coût réel et la vitesse par rapport à
un autre produit ne sont pas établis par ces tests.

## Défauts reproduits et corrections

### Transmission des tâches et approbations

Le motif d’une délégation était présent dans la file mais n’arrivait pas dans
le contexte envoyé au modèle. La reprise d’une approbation perdait également
les faits permettant de distinguer une action déjà exécutée d’une nouvelle
demande.

Le cycle fournit maintenant un contexte `kartaTrigger` réservé au serveur.
Les données métier ne peuvent pas écraser cette clé. Une reprise recharge
l’action et son cycle parent depuis la base, en vérifiant le propriétaire,
l’agent, les identifiants, l’état résolu, le mode réel et le journal concordant.
La comparaison JSON canonique empêche de rejouer exactement l’action de cette
reprise immédiate. Une action rejetée répétée arrête les effets suivants.
Les autorisations courantes, l’arrêt d’urgence et les schémas des outils
continuent de s’appliquer.

La migration `019_pending_action_execution_trigger.sql` conserve une origine
minimale et bornée dans `karta_pending_actions.execution_trigger`. Elle contient
le type et la source, puis uniquement le motif et la lignée connus pour une
délégation. Aucun payload webhook arbitraire ni contexte de reprise imbriqué
n’est enregistré. La colonne reste réservée aux écritures serveur et la lecture
reste limitée au propriétaire. Une origine persistée malformée est refusée
avant l’exécution.

La délégation conserve sa lignée après une ou plusieurs approbations. Elle
refuse l’auto-délégation, un retour vers un agent déjà visité et une profondeur
supérieure à trois. Le contrat existant de déduplication de la file est conservé.
Une ancienne approbation sans origine ne peut pas inventer une nouvelle lignée.

Les décisions, paramètres, résultats et erreurs privés des délégations sont
minimisés dans les traces. Les paramètres nécessaires à l’exécution restent
disponibles dans l’action protégée. Le compteur des actions rejetées reste
visible même lorsque le contenu du journal est minimisé.

### Admission et comptabilité CHEF

Deux défauts ont été reproduits avant correction sur PostgreSQL 15 natif :

- Une estimation omise devenait implicitement zéro et permettait une admission
  sous un budget de zéro.
- Deux tâches estimées à 60 pouvaient être admises pour une mission plafonnée
  à 100, car aucune réservation ne tenait compte des tentatives déjà en cours.

La migration `018_chef_budget_reservations.sql` et le runtime associé ajoutent :

- La validation et la conservation de `estimatedTokens` et
  `estimatedCostMicros` dans le brief canonique et en SQL.
- Une réservation liée à la tâche, à sa tentative, à son jeton de génération
  et au worker, créée sous verrou de mission. L’admission prend en compte les
  dépenses connues, les réservations ouvertes et la nouvelle estimation.
- Le refus d’une estimation inconnue pour chaque dimension plafonnée. Un zéro
  explicitement connu reste distinct d’une valeur absente.
- La conservation des réservations après une exception, une expiration du bail
  ou un crash. Une consommation plafonnée non rapprochée bloque de nouvelles
  admissions jusqu’à réconciliation.
- Le nouveau RPC `chef_record_claim_usage`, qui accepte un reçu partiel et
  rapproche chaque dimension une seule fois. Un reçu tardif ne peut solder que
  sa propre tentative. Un total déjà réglé ne peut être réécrit.
- Un coût absent conservé à `NULL`, au lieu d’un coût zéro fabriqué. Une tâche
  plafonnée sans les métriques requises ne peut pas devenir `verified_done`,
  y compris par une mise à jour SQL directe.
- La remise à zéro automatique d’une réservation uniquement lorsque le
  superviseur sait qu’il n’a pas encore appelé le driver.

Le backfill garde les anciens coûts zéro comme inconnus, car l’ancien runtime
pouvait produire ce zéro en l’absence de métrique. Les coûts historiques
positifs concordants sont conservés. Si plusieurs anciens reçus mélangent un
coût positif et un coût zéro ambigu pour la même tentative active, la migration
refuse la transformation et annule sa transaction. Le cas reproduit aurait
compté 19 pour un total final de 12 ; le refus conserve les 7 déjà imputés et
les deux événements, en attendant une réconciliation documentée. Les missions sans plafond continuent de
fonctionner ; leurs compteurs représentent seulement les montants connus.

### Annulation avant lancement

Un test avec un vrai sous-processus local a reproduit un lancement malgré un
`AbortSignal` déjà annulé. `ProcessChefDriver.run` refuse désormais ce signal
avant toute création de processus. Le test vérifie l’absence de l’effet local
du sous-processus, en plus du rejet de la promesse.

## Vérification

Les assertions fonctionnelles utilisent les vrais modules du moteur et les
migrations SQL. Les tests automatisés remplacent volontairement le modèle, le
transport Supabase, Redis et les effets externes lorsqu’ils ne font pas partie
du scénario. PGlite fournit un backend PostgreSQL embarqué ; les scénarios de
concurrence décrits ci-dessous ont aussi utilisé deux connexions distinctes à
un PostgreSQL 15 natif.

| Contrôle | Résultat |
| --- | --- |
| Base initiale exacte `1daf6314` | PASS — 612 tests, 52 fichiers |
| Régression d’annulation avant correction | 5 tests PASS, 1 défaut reproduit |
| Annulation après correction | PASS — 6 tests |
| Contexte de déclenchement et vraie boucle | PASS — 79 + 26 tests ciblés |
| Deux approbations successives, SQL et vrai moteur | PASS — 8 tests ciblés |
| PostgreSQL 15, concurrence et migrations | PASS — scénarios détaillés ci-dessous |
| Suite complète finale | PASS — 788 / 788 tests, 60 fichiers, aucun en attente |
| TypeScript et compilation de production | PASS — deux commandes terminées avec le code 0 |

La première suite complète locale a recensé 787 tests : 770 réussis,
deux dépassements de délai de cinq secondes dans `chatHistoryIsolation.test.ts`
et 15 tests restés en attente. Ces dépassements concernent un fichier inchangé
dans un environnement partagé saturé. Ils ne sont pas présentés comme un PASS.
La validation finale a levé cette incertitude sur une copie complète et isolée.
La première copie Mac omettait des dépendances de tests situées hors de KARTA ;
elles ont été ajoutées. Un champ manquant dans une donnée de test a également
été corrigé avant la campagne finale complète. Les 262 fichiers de source
contrôlés correspondent exactement aux sources finales.

Environnement final : macOS arm64, Node 26.0.0, TypeScript 5.9.3, Vitest 5.0.3
et PGlite 0.5.8, installés par `npm ci --ignore-scripts` avec le lockfile exact.
Les limites de temps de la commande de test étaient de 30 secondes par test et
120 secondes par hook, avec deux workers. Les assertions n’ont pas été
assouplies. Les tests ont terminé en 177,443 secondes ; cette durée est celle
de la suite et ne mesure pas la latence du produit.

```sh
npm run typecheck
npm run build
npm test -- --maxWorkers=2 --testTimeout=30000 --hookTimeout=120000
```

### PostgreSQL natif

Les essais ont utilisé des données synthétiques dans un conteneur temporaire :
réseau désactivé, aucun port publié, aucun montage hôte, données en mémoire,
mémoire plafonnée à 768 Mio et un CPU. Aucun service ou jeu de données de
production n’a servi aux tests. Le conteneur exact a ensuite été arrêté et sa
suppression vérifiée.

| Scénario | Observation vérifiée |
| --- | --- |
| Deux admissions concurrentes, plafond 100, estimations 60 + 60 | Une seule réservation de 60 |
| Règlement tenu en transaction et admission concurrente | 20 consommés + 60 réservés |
| Deux reçus identiques simultanés | Une seule comptabilisation et un seul événement correspondant |
| Nouvelle application de 018 | Réservations, événements et montants inchangés |
| Ancien coût zéro et coût positif de 7 | Zéro ambigu inconnu, 7 conservé |
| Reçu tardif de coût 5 | 25 tokens / 12 micros, sans recompter les tokens |
| Anciens reçus mixtes ambigus | Refus transactionnel, DDL annulé, 7 micros et deux reçus conservés |
| Migration 019 | Rejeu, ancienne origine `NULL`, nouveau champ retourné par le RPC |
| Approbation, droits et bornes SQL | Finalisation atomique, aucun second claim, lecture propriétaire, écritures client refusées, limite de 16 Kio |

Les hashes de source, les résultats consolidés et les limites de validation
sont consignés dans `../test/evidence/agent-runtime-20261110.json`. Le rapport
Vitest complet est conservé dans `../test/evidence/agent-runtime-20261110-tests.json.gz`.

GitNexus a été réindexé et le diff staged contrôlé avant commit. L’impact
agrégé est classé **critique** : les chemins centraux de création, exécution,
approbation et comptabilité sont concernés. La revue manuelle et les tests
couvrent ces chemins ; l’index n’est pas exhaustif et ne constitue pas une
preuve d’absence de dépendance, notamment pour les migrations SQL. La
comparaison avec `main` couvre 265 fichiers et inclut les travaux hérités de la
branche de consolidation ; ce lot apporte 26 fichiers propres, preuves
comprises. La liste des symboles affichée par le comparateur est plafonnée,
mais ses comptes globaux portent sur l’ensemble du diff.

## Intégration de cette version

Ce lot exige une mise à jour coordonnée du runtime et des migrations. Il ne
valide pas une bascule en ligne avec des workers anciens toujours actifs.

1. Arrêter ou drainer les workers concernés, puis rapprocher les effets en
   cours sans les rejouer. Conserver les journaux et réservations.
2. Vérifier les prérequis du schéma existant, puis appliquer 018 et 019. Les
   tests CHEF couvrent 008 à 018 ; ceux des approbations incluent les migrations
   KARTA de base et 019.
3. Déployer le runtime associé au nouveau RPC, avec le lockfile de cette
   version. Les anciens workers ne doivent pas reprendre sur les missions
   réservées : leur ancien RPC comptable est refusé dans ce cas.
4. Fournir une estimation par tâche pour chaque dimension plafonnée. Une
   estimation manquante empêche l’admission ; elle ne vaut pas zéro.
5. Vérifier le parcours complet depuis PURAMA ONE jusqu’au moteur, avec les
   connexions réellement configurées, avant d’annoncer une mise en service.

En cas d’échec de migration, la transaction doit être examinée avant de
reprendre les workers. Ne pas supprimer les réservations pour forcer une
reprise et ne pas réactiver automatiquement l’ancien runtime après 018.

## Limites explicitement conservées

- Le contexte persistant ne reconstitue pas le brief métier complet ni les
  résultats antérieurs des outils.
- La garde compare l’action exacte de la reprise immédiate. Elle n’est pas un
  registre cumulatif ni une détection de doublons sémantiques pour toute une
  mission.
- Les trois niveaux de délégation et l’interdiction des cycles ne constituent
  pas un plafond global du nombre de jobs ou de leur coût. Les réservations
  ajoutées ici concernent CHEF.
- Les enveloppes contrôlent l’admission sur estimations. Une facture réelle
  supérieure reste possible ; un dépassement déclaré est comptabilisé puis
  suspend les admissions suivantes.
- La réconciliation fournisseur, Redis, PostgREST, les connexions métier et le
  parcours PURAMA ONE en production restent NON TESTÉS pour cette version.
- Aucun résultat de coût, de rapidité, d’unicité mondiale ou de supériorité
  comparative n’est déduit des tests de correction.
