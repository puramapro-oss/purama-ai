# Réception de la boucle de vérification — 25 novembre 2026

## Version et portée

La branche locale `feat/iao-observed-verification-20261124` conserve les commits
de réalisation `383d54cc` et de réception `42b86982`. Cette campagne réconcilie
leur contenu avec la branche d'intégration
`audit/reliability-oauth-20261110`, observée au commit
`795d7db298416f98cf95103c096714f82c01c8cb`.

La fusion préparée ne présente aucun conflit. Parmi les dix-huit fichiers de
la fonctionnalité, seul `karta/test/assistantPolicy.test.ts` reçoit une évolution
amont : normalisation des requêtes du transport simulé et nouvelle enveloppe
d'erreur de la découverte de partenaires. Les deux assertions de politique
d'observation restent présentes. Les modifications des autres contributeurs
sont conservées.

Les empreintes des fichiers testés et relus font autorité. Les tests ont été
exécutés dans l'arbre composé avant son commit ; aucune preuve d'un ancien
commit n'est présentée comme une exécution de cette nouvelle composition.

## Résultats

| Contrôle | Statut | Preuve et limite |
| --- | --- | --- |
| Seize suites ciblées KARTA/CHEF | PASS | 468 tests réussis, zéro échec, attente ou cas à faire ; code de sortie 0. |
| Typage KARTA | PASS | `npm run typecheck`, code de sortie 0. |
| Compilation KARTA | PASS | `npm run build`, code de sortie 0. |
| Lint des seize fichiers TypeScript concernés | PASS | Zéro erreur et zéro avertissement ; configuration du dépôt identique, versions directes des outils conformes au verrou du dépôt. Dépendances de lint isolées, pas une exécution de toute la CI. |
| Revue statique indépendante | PASS | Onze fichiers relus ; aucune anomalie bloquante démontrée. Ce contrôle n'ajoute aucun test exécuté. |
| Première campagne native macOS | PARTIEL | 78 tests réussis sur 79 ; un cas de migration des anciennes preuves dépasse 5 secondes. |
| Recheck natif du cas en délai dépassé | BLOQUÉ | Échec du hook de préparation PGlite à 30 secondes ; aucun test exécuté. |
| Diagnostic PGlite supplémentaire | BLOQUÉ | Non lancé : charge moyenne sur une minute 51,1685 pour 16 cœurs, au-dessus du seuil préalable de 32. Cela ne démontre pas la cause des délais antérieurs. |
| Publication, CI distante et service déployé | NON TESTÉ | Cette réception locale ne prouve aucune publication ou mise en production de la fonctionnalité. |

Les résultats natifs portent sur `42b86982`, avec Node 26.0.0. Le code des quatre
suites et leurs dépendances concernées sont identifiés par leurs empreintes dans
`native-final-summary.json`. Ces résultats ne sont ni une CI Ubuntu/Node 22 ni
une nouvelle exécution sur le commit de composition.

Les treize tests du transport local Fabric, les dix-huit tests d'admission
budgétaire et les dix-sept tests de contrôle des preuves ont réussi dans cette
campagne native. La suite de fraîcheur des preuves a réussi trente cas sur
trente-et-un. Son recheck ne contribue à aucun décompte de réussites.

## Comportements couverts

- Observation d'un artefact réel liée à son SHA-256, avec contrôles déclarés et
  couverture minimale explicite.
- Refus d'un résultat absent, falsifié, incomplet, changé ou supprimé, y compris
  lorsqu'un profil ultérieur modifie un export ignoré par Git.
- Retour des défauts dans le stockage de preuves existant, lié à la tâche,
  mission, portée, génération de verrou et sortie précédente exacte.
- Correction à partir des instructions initiales, puis nouvelle vérification ;
  blocage des sorties concurrentes, des diagnostics ambigus et d'une reprise
  sans progrès.
- Diagnostics sérialisés comme données non fiables, sans élargissement des
  autorisations ; exclusion des tâches pouvant produire un effet externe de
  cette reprise automatique.
- Transmission de la politique commune aux chemins KARTA, CLI Codex et calcul
  local concernés, avec transports simulés lorsque le test est un contrat de
  routage.

## Analyse d'impact

GitNexus 1.6.12 a été réindexé sur un périmètre explicite : CHEF, la politique
commune, les modules de transmission associés et le fixture de politique.
L'analyse préalable du symbole `runtime` du fixture indique un risque LOW,
deux dépendances directes et aucun processus affecté dans ce graphe.

L'index composé compte 1 311 nœuds, 3 443 relations, 38 groupes et 95 parcours.
La recherche plein texte est désactivée et l'analyse de certains parcours est
tronquée. Ce graphe ciblé ne constitue pas une analyse exhaustive du dépôt.
Les contrôles des changements avant commit et la comparaison à `origin/main`
sont conservés dans les fichiers `gitnexus-detect-*`.

La comparaison de la fonctionnalité à la branche d'intégration identifie
132 symboles et 26 parcours affectés, classés CRITICAL. La comparaison cumulative
à `origin/main` identifie 1 134 symboles et 95 parcours, également CRITICAL ; sa
liste est tronquée et inclut les travaux antérieurs de toute la consolidation.
Ces nombres ne décrivent pas uniquement l'ajustement du fixture effectué lors
de cette fusion. Le contrôle des changements préparés pour la fusion identifie
trois symboles de ce fixture et aucun parcours dans le graphe ciblé, classés LOW.
Les classifications et la portée limitée du graphe ont été examinées avant
l'enregistrement de la fusion.

## Limites d'exploitation

La politique est indépendante du fournisseur. Une connexion API ne fournit
pas à elle seule une capacité de vision, d'écoute, un navigateur ou un outil de
vérification. Le contrat d'observation exige un observateur de confiance
réellement configuré et qualifié pour le résultat demandé. Les rapports de
fixture ne prouvent pas la qualité d'un observateur visuel ou audio réel.

Cette campagne ne valide pas tous les modèles connectés en conditions réelles,
ne garantit pas une mémoire exhaustive des conversations et ne déploie aucun
profil d'observation universel. Le contrat et la procédure d'exploitation sont
décrits dans `docs/iao-observed-verification.md`.

Les essais et traces des installations personnelles ChatGPT/Codex sont conservés
séparément ; aucune configuration personnelle ou trace privée de session n'est
ajoutée à cette réception du code produit.

## Contrôles encore nécessaires

1. Qualifier le dernier cas SQL avec ses délais inchangés dans un environnement
   disponible. Les reçus actuels ne démontrent aucun échec d'assertion SQL, mais
   ils ne permettent pas de déclarer ce contrôle réussi.
2. Obtenir l'autorisation explicite requise pour publier le code dans le dépôt
   public, puis observer les résultats de la CI et du déploiement concerné.
3. Qualifier les observateurs et fournisseurs effectivement utilisés avant de
   leur attribuer une capacité de vérification visuelle ou audio.

Ne pas cumuler les campagnes répétées comme des cas indépendants, transformer
une attente en réussite, ni augmenter silencieusement les délais pour obtenir
un statut positif.
