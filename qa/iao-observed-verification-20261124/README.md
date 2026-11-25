# IAO — Vérification observée et correction durable

## Périmètre du changement

La politique commune exige de contrôler le livrable final, de corriger les défauts
et de revérifier la version corrigée. Elle est transmise aux parcours existants
KARTA/Edge, au calcul local et au pilote CLI Codex. `AGENTS.md` conserve les
consignes pour les sessions de développement de ce dépôt.

CHEF accepte un contrat d'observation optionnel par profil de confiance. Le
contrat lie un fichier, des critères, leurs modalités et leur couverture à une
empreinte SHA-256 effectivement calculée. Une observation manquante, incomplète,
périmée ou négative empêche le succès du profil. Le contrôle final détecte aussi
la modification d'un export ignoré par Git par un profil exécuté plus tard.

Le superviseur conserve les défauts dans les preuves existantes et les transmet
à la tentative suivante, avec validation de la portée et du commit exact. Les
budgets, générations, leases, annulations et contrôles des effets externes restent
ceux de CHEF. Aucun nouvel orchestrateur ni nouvelle migration.

Voir [le contrat et ses limites](../../docs/iao-observed-verification.md).

## Continuité

- État initial examiné : `04ff79cf8c5d1061e04cf631efac21601978433e`.
- Consolidation récupérée avant les vérifications finales :
  `3c6d6c3a669d481b7c9bada7800c4721c0bb94de`.
- Branche de travail isolée : `feat/iao-observed-verification-20261124`.
- Cible d'intégration : `audit/reliability-oauth-20261110`.

Les changements de qualification des partenaires arrivés entre ces deux états
ont été conservés. Les nouvelles assertions de politique commune s'ajoutent à
la fixture actualisée, sans la remplacer.

## Preuves locales

`local-verification.json` conserve les commandes, les codes de sortie, les
compteurs recalculés à partir des assertions et les empreintes des fichiers
contrôlés. Les campagnes se recouvrent : leurs nombres ne doivent pas être
additionnés.

Les tests nouveaux ont d'abord reproduit les défauts : absence de contrat
d'observation, perte du feedback correctif et maintien d'une preuve après une
modification ultérieure de l'artefact. La contre-revue a aussi identifié une
SHA valide en majuscules rejetée et un ordre de diagnostics considéré à tort
comme un progrès ; ces deux cas ont été corrigés et testés.

Les tests de correction exécutent de vrais processus et opérations Git dans
des dépôts temporaires. Le modèle et le plan de contrôle y sont des fixtures.
Les tests de persistance exécutent les méthodes réelles de l'adaptateur avec
un transport Supabase simulé. Les tests d'instructions exécutent les chemins
réels d'assemblage avec des transports fournisseurs simulés.

Un test matérialise une limite volontaire : après une tentative interrompue sans
nouveau checkpoint, un ancien feedback ne traverse pas automatiquement le trou
de génération. Le commit et l'historique sont conservés, la reprise bloque avant
le pilote et exige une réconciliation explicite.

## Contrôles qui exigent la CI ou l'hôte déployé

Dans l'environnement local, dix tests du transport Fabric échouent à l'ouverture
de sockets Unix (`listen EPERM`), avant de tester le transport. Trois suites SQL
sur les preuves et budgets s'arrêtent par `SIGKILL` avant leurs assertions. Le
rapport JSON de Vitest peut alors porter `success: true` malgré un code de sortie
1 et des assertions `pending` : ce champ seul n'est pas une preuve de réussite.
Ces cas ne sont pas comptés comme PASS dans le reçu.

Le workflow existant `PURAMA CHEF hardening` exécute la suite KARTA complète, les
tests natifs et les compilations à l'ouverture de la PR. Ses résultats doivent
être lus sur le commit final avant fusion ; le présent reçu local ne les
préjuge pas.

Aucun modèle distant, observateur audiovisuel réel ou service déployé n'est
qualifié par les fixtures de protocole. L'ajout du champ `observation` est
optionnel ; il ne prétend pas installer tous les outils de perception nécessaires.

## GitNexus

Les impacts avant modification sont conservés dans `impact/`. Le parcours du
vérificateur et le pilote Codex présentent un impact élevé ou critique, signalé
avant leurs modifications. Le contrôle `verify` a été désambiguïsé par son UID.

L'analyse complète a dépassé les ressources de cet environnement. L'index utilisé
est limité aux sources CHEF, à la politique/transport communs et au fournisseur
local, avec un seul parseur, sans FTS ni embeddings. `gitnexus-scope.txt` reproduit
ce périmètre temporaire ; il n'est pas installé comme configuration du dépôt.
Les avertissements de troncature du graphe sont conservés. Une absence de symbole
ou de flux dans ce graphe ne prouve pas son absence dans le projet.

Les détections des changements staged et comparés à `origin/main` sont conservées
avec leurs limites. Elles ne constituent pas un audit complet de PURAMA.

La détection staged identifie 131 symboles et 24 flux dans ce graphe limité.
La comparaison à `origin/main` comprend aussi les travaux de consolidation déjà
présents avant ce lot : 2 989 fichiers diffèrent de cette branche par défaut et
la liste des symboles est plafonnée. Ce nombre ne représente pas la taille de
cette modification, dont le manifeste ne contient que 18 fichiers produit,
tests, consignes et documentation, hors reçus de QA.
