# Sélection des compétences et connecteurs de réalisation

État au 12 novembre 2026 : **PARTIEL** pour le parcours utilisateur complet.
La sélection et son transport dans CHEF sont implémentés et testés localement.
Le chat principal ne lance toujours pas CHEF ; aucun adaptateur fournisseur réel,
compte externe, migration de production ou déploiement n'est qualifié par ce lot.

## Intégration existante

Base : consolidation IAO `b170fcb647f8f70851ee918bff795de3a45b0328` (PR45).
Le canon PURAMA courant a été rapproché des sections « Réalisation complète dans
la conversation », « Compétences et agents » et de la réception du 12 novembre.

Le choix suit les composants actuels : brief → hash → ingestion SQL atomique →
claim durable → propriétaire de mission → sélection → processus adaptateur →
vérifications indépendantes. `web-capability-plan.ts` reste propriétaire de
l'évaluation des accès web. Aucun deuxième ordonnanceur, catalogue global ou
système de comptes n'est créé.

Les agents métier possédaient déjà génération d'outils et sélection manuelle ;
ces écrans ne sont pas confondus avec la réalisation de projets logiciels.

## Deux modes, même autorité

Chaque tâche peut porter `capabilitySelection` :

```json
{
  "mode": "auto",
  "needs": ["typescript", "browser-test"],
  "selectedIds": [],
  "excludedIds": [],
  "maxSelected": 8
}
```

En mode `auto`, les besoins structurés sont rapprochés des capacités qualifiées,
disponibles et autorisées. La couverture est gloutonne et déterministe : besoins
couverts, qualité minimale des dépendances, coût puis identifiant. Elle ne prouve
ni un optimum global, ni la supériorité universelle d'un outil. Les tags de besoins
doivent provenir du plan validé ; ce module ne comprend pas à lui seul une demande
en langage naturel.

En mode `manual`, `selectedIds` contient la liste exacte choisie. Aucune
substitution ni dépendance supplémentaire n'est ajoutée silencieusement. Une
liste vide est valide lorsqu'aucune capacité n'est nécessaire. Les exclusions,
versions, dépendances et limites restent applicables dans les deux modes.

Les listes sont bornées à 32 entrées avant dédoublonnage ; `maxSelected` vaut 8
par défaut, entre 1 et 16. Ces valeurs limitent le contexte chargé par tâche et
ne constituent pas une limite du nombre de projets ou de workers.

Le futur contrôle dans le chat pourra présenter « PURA choisit » et « Je choisis »,
les raisons d'un blocage et les capacités retenues à la demande. Ce contrôle
utilisateur et le raccordement chat → CHEF ne sont pas livrés ici.

## Catalogue fourni par le serveur

`ChefCapabilityContext` est une vue temporaire du registre de l'hôte, jamais un
paramètre fourni par le modèle. Il est lié au propriétaire canonique `userId`,
à `missionId`, `taskId` et au hash du brief. `claimNext` charge le propriétaire
dans `chef_missions`, sans croire un propriétaire injecté dans la ligne de tâche.

Le snapshot comprend au plus 128 descriptions. Chaque description porte son
identifiant, son type `skill` ou `connector`, sa version, ses besoins couverts,
ses dépendances, sa qualification, son autorisation, sa disponibilité, un score
qualifié facultatif et une estimation de coût explicite. Les coûts inconnus ne
sont pas traités comme nuls. Les cycles et références inconnues sont rejetés.

`remainingBudgetMicros` doit représenter l'enveloppe autorisée pour cette tâche,
rapprochée de sa réservation CHEF, et non le même solde global promis à chaque
worker. Les estimations CHEF doivent inclure les capacités et les outils. La
sélection ne réserve pas d'argent et n'est pas un plafond de facture fournisseur.
Les contrôles de coût réels restent à appliquer à chaque appel dans l'adaptateur.

Un connecteur utilise `planWebCapabilityAccess` avec le même propriétaire et une
opération liée à la tâche. Une route structurée ou une recette validée est requise.
Une péremption ou une indisponibilité technique peut conduire à un autre candidat
autorisé. Un refus de politique, une incohérence d'identité ou un effet incertain
ne déclenche pas de contournement. La sélection n'effectue ni OAuth, ni installation,
ni création de compte, ni appel externe.

## Raccordement au processus

`ProcessChefDriver` accepte un `capabilityRuntime` fourni par l'hôte. La résolution
est annulable et bornée à cinq secondes. La fraîcheur, au plus cinq minutes, est
vérifiée après sa résolution. Un adaptateur non déclaré compatible bloque une
tâche portant une sélection ; il ne reçoit pas une tâche amputée de ses choix.

Pour le daemon existant, le transport facultatif est :

- `CHEF_CAPABILITY_CONTEXTS_FILE` : chemin absolu d'un fichier géré par l'hôte,
  hors des espaces de travail des agents ;
- `CHEF_DRIVER_CAPABILITY_PROTOCOL=1` : déclaration de compatibilité de l'adaptateur.

Le fichier est une enveloppe `{"schemaVersion":1,"contexts":[...]}` contenant
les snapshots exacts des tâches. Il est relu à chaque demande, borné à 1 Mio et
refuse liens symboliques finaux, FIFO, doublons et identités incohérentes.
L'hôte doit publier ce fichier atomiquement et le protéger des écritures des
agents. Aucune variable de production ni aucun fichier d'autorisation n'a été créé.

Le processus reçoit seulement les préférences et `capabilityPlan` : identifiants,
types, versions, estimation et empreinte. Le catalogue complet, les contextes de
permissions et les secrets ne sont pas transmis. L'empreinte de transport inclut
le worker, la tentative et le fencing token ; un ancien reçu ne vaut pas pour la
nouvelle tentative.

L'adaptateur compatible doit appliquer les versions et la liste choisies avant
le travail, revalider permissions et coûts à chaque effet externe et renvoyer :

```json
{
  "capabilityReceipt": {
    "selectionHash": "empreinte reçue dans capabilityPlan",
    "appliedIds": ["identifiants réellement appliqués"]
  }
}
```

Cet accusé valide le contrat de transport. Il ne prouve pas le confinement du
processus ni l'exécution effective d'un service tiers. Les vérificateurs CHEF
restent nécessaires. Un adaptateur concret Codex/Claude/GLM respectant ces
exigences doit encore être qualifié avant activation.

## Continuité et parallélisme

La migration `030_chef_capability_selection.sql` conserve les préférences dans
les tâches et les vérifie côté SQL. Les anciens briefs sans ce champ gardent
leur hash et leur comportement. Une nouvelle préférence change le hash ; un
replay avec un choix différent sous le même hash est refusé.

Les dépendances, budgets, baux, quarantaines et verrous de fichiers existants
restent utilisés. `maxParallel` demeure une limite par mission, pas une garantie
de capacité globale. Aucun nombre illimité de tâches simultanées n'est promis.

Avant lancement, un blocage de sélection produit une consommation connue nulle.
Après lancement d'une tâche avec capacités, l'absence de reçu, un échec de
processus ou de vérification et une interruption conduisent à `blocked_external`
avant toute reprise. Une consommation inconnue reste inconnue. Un effet externe
doit être rapproché avant relance. La quarantaine existante couvre l'arrêt de
processus non confirmé et l'expiration des baux.

## Réception

Les suites nouvelles couvrent sélection auto/manuelle, dépendances, repli technique,
autorisation, propriétaire, coûts, fraîcheur, hashes, ingestion SQL PGlite,
reprise avec nouveau fencing, processus Node réels et accusés par tentative.
Deux processus indépendants sont exercés ensemble sans partager leur sélection.
Les fournisseurs et comptes de ces tests sont des fixtures locales.

Les résultats de commandes et limites d'analyse sont consignés dans
`qa/chef-capability-selection-20261112/verification.json`.

Reste pour l'ouverture : contrôle utilisateur dans le chat, création des briefs
depuis la conversation, catalogue qualifié de production, adaptateurs appliquant
les choix, connexion des comptes avec leurs droits et recette réelle sur l'hôte.
La migration doit être appliquée avec le runtime correspondant après qualification.

Références de conception consultées :
[Agent Skills](https://github.com/agentskills/agentskills/blob/main/docs/specification.mdx)
pour le chargement progressif ;
[MCP Tools](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/tools.mdx)
pour la découverte des outils liée aux autorisations. Ces standards ne certifient
pas une capacité PURAMA.
