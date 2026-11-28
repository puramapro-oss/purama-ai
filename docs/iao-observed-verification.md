# IAO : observer, corriger et revérifier le résultat

## Portée

IAO partage une même règle de travail : définir des critères observables, produire,
examiner le résultat réel, corriger les défauts et examiner de nouveau la version
corrigée. Cette règle est indépendante du fournisseur du modèle. Les capacités
effectivement disponibles dépendent du modèle, de son adaptateur et des outils
autorisés : une connexion API seule ne donne ni vision, ni audition, ni navigateur,
ni accès aux fichiers.

Deux mécanismes restent distincts :

- `OBSERVED_VERIFICATION_POLICY`, dans
  `karta/src/claude/assistant-policy.ts`, transmet la méthode au cadre commun KARTA
  et aux fonctions Edge qui le réutilisent. Le même bloc est transmis au calcul
  local par `buildMemoryPrompt` et au driver CLI Codex. Il s'agit de consignes,
  pas d'une preuve d'observation ou d'un appel d'outil supplémentaire.
- CHEF exécute les profils de vérification configurés par l'hôte, conserve leurs
  preuves et peut transmettre les défauts observés à une tentative corrective.
  L'observation structurée d'un artefact est activée explicitement par profil.

Les profils existants sans `observation` conservent leur comportement. L'ajout ne
remplace ni KARTA/CHEF, ni SMARANA, ni les contrôles d'autorisation. Le runtime de
conversation qui valide un reçu KARTA ne devient pas, par ce seul ajout, un
vérificateur automatique de toutes les réponses.

## Profil de vérification avec observation

La configuration de confiance choisit **avant la génération** le fichier final,
les contrôles et leur couverture minimale. `CommandChefVerifier` reçoit ces
profils depuis la configuration de l'hôte ; l'atelier transmet aussi leur champ
`observation` à travers `parseWorkshopProjects`. Les autres exigences de
l'atelier, dont ses preuves et revues indépendantes, restent applicables.

Exemple de structure d'un profil :

```json
{
  "name": "final-video-review",
  "kind": "review",
  "requirementKeys": ["QUALITY"],
  "command": "/opt/iao-observers/review-final-video",
  "args": ["exports/final.mp4"],
  "timeoutMs": 120000,
  "observation": {
    "artifactPath": "exports/final.mp4",
    "maxArtifactBytes": 67108864,
    "checks": [
      { "id": "frames", "modality": "visual", "coverage": "sample" },
      { "id": "speech", "modality": "audio", "coverage": "full" }
    ]
  }
}
```

Cet exemple décrit un contrat, pas un observateur fourni ou installé. Le chemin
de commande doit désigner un exécutable réellement qualifié par l'hôte, avec les
outils nécessaires aux contrôles annoncés. Le programme et sa configuration
doivent rester hors du périmètre modifiable par le modèle. Un chemin placé dans
un brief ou une réponse du modèle ne devient pas une commande de confiance.

Le vérificateur ne lance pas de shell pour interpréter la commande. Il fournit les
arguments configurés au processus existant. Il ne transmet pas automatiquement
le contrat d'observation sur stdin : l'hôte doit configurer l'observateur pour
le fichier et les contrôles correspondants.

### Contrôles et couverture

Chaque contrôle possède un identifiant unique. Les modalités admises sont :

| Modalité | Type de constat à produire |
| --- | --- |
| `behavior` | Comportement réellement exécuté : test, parcours ou interaction |
| `visual` | Inspection d'un rendu, d'une image ou d'images d'une vidéo |
| `audio` | Contrôle audio correspondant au critère, avec méthode explicitée |
| `content` | Contenu, données, faits ou calculs contrôlés |
| `metadata` | Propriétés techniques : format, durée, dimensions ou autres métadonnées |

Ces étiquettes ne prouvent pas à elles seules que la méthode est pertinente.
L'observateur doit être qualifié sur les défauts qu'il prétend détecter. Par
exemple, une transcription ou un spectrogramme ne démontre pas que la voix est
audible et intelligible dans le mixage final.

| Couverture exigée | Observation permettant un succès |
| --- | --- |
| `full` | `status: "pass"` et `coverage: "full"` |
| `sample` | `status: "pass"` et `coverage: "sample"` ou `"full"` |

Un échantillon conserve cette qualification ; il ne devient pas une inspection
complète. `fail`, `not_tested` ou `coverage: "none"` ne satisfont jamais un
contrôle requis. Une modalité absente ou inaccessible reste non testée.

## Rapport de l'observateur

Avec `observation` activé, stdout doit contenir un seul document JSON conforme au
contrat ci-dessous, sans préambule de logs. Le rapport doit identifier exactement
les contrôles configurés, avec leurs modalités, et porter le SHA-256 du fichier
réel. Le résultat reste négatif si le processus échoue, même avec un rapport
positif.

Exemple de structure indiquant honnêtement que les deux contrôles n'ont pas pu
être exécutés :

```json
{
  "schemaVersion": 1,
  "artifactSha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "observations": [
    {
      "id": "frames",
      "modality": "visual",
      "status": "not_tested",
      "coverage": "none",
      "method": "inspection-visuelle-indisponible",
      "summary": "Aucun outil de vision qualifié disponible pour ce contrôle."
    },
    {
      "id": "speech",
      "modality": "audio",
      "status": "not_tested",
      "coverage": "none",
      "method": "inspection-audio-indisponible",
      "summary": "Aucun contrôle d'intelligibilité du mixage final exécuté."
    }
  ]
}
```

Le hash nul est uniquement un exemple de format : il doit être remplacé par
l'empreinte exacte du fichier inspecté. Ce rapport ne constitue pas une preuve
de succès. Même avec une empreinte correcte, les deux résultats `not_tested`
empêchent la validation. Le champ facultatif `location` peut préciser une page,
une zone, un cas ou un horodatage observé.

Le vérificateur calcule lui-même le SHA-256 du fichier avant et après le processus.
Il refuse un fichier absent, non régulier, accessible par un lien symbolique,
trop volumineux ou changé pendant les lectures/contrôles. Une modification
nécessite donc une nouvelle observation du nouvel artefact. Le hash du rapport ne
se substitue pas à celui du fichier.

À la fin de la séquence, il recalcule aussi l'empreinte des artefacts observés,
même si un profil ultérieur a échoué. Un export modifié par un contrôle suivant,
y compris un fichier ignoré par Git, invalide ainsi son observation antérieure
avant la remise des preuves.

Ces contrôles encadrent les lectures et comparent l'état final ; ils ne créent pas
un instantané immuable du système de fichiers ni une surveillance permanente. Ils
ne prouvent pas l'absence d'un changement transitoire entre deux lectures, ni la
qualité perceptive d'un observateur mal configuré qui déclarerait à tort `pass`.

### Limites de taille

- Artefact : **64 Mio** par défaut (`67108864` octets), configurable de 1 octet à
  **1 Gio** (`1073741824` octets).
- Rapport JSON d'observation : **64 Kio** maximum, calculés en octets UTF-8.
- Contrôles par profil : de 1 à 32, sans identifiant dupliqué.
- Chaque observation contient une méthode non vide de 200 caractères maximum,
  un résumé non vide de 1 000 caractères maximum et, facultativement, une
  localisation de 300 caractères maximum.
- Le plafond de sortie du processus et son délai continuent à s'appliquer.
  Le délai du processus ne constitue pas une mesure garantie du temps total de
  lecture et de vérification de l'artefact.

## Retour des défauts et reprise corrective

Après une vérification indépendante négative et un contrôle Git concluant, le
superviseur peut enregistrer dans `chef_evidence` un retour
`verification-feedback`. Il conserve les profils en échec, les observations
structurées disponibles et les identités nécessaires au rapprochement. Les logs
bruts ordinaires du processus ne sont pas ajoutés aux instructions du modèle.

À la tentative suivante, la reprise doit correspondre à :

- la même tâche et mission, le même brief et le même périmètre ;
- la tentative précédente et une génération de verrou antérieure ;
- la même branche et le **SHA exact de la sortie précédemment vérifiée** ;
- un arbre Git propre, sans changement concurrent absorbé silencieusement.

Le retour est chargé depuis la preuve durable existante et validé de nouveau.
Les observations sont ajoutées sous forme JSON aux instructions initiales comme
**données de diagnostic non fiables**. Elles ne peuvent étendre le périmètre,
modifier les critères, autoriser une dépense ou déclencher un effet externe.

La correction passe de nouveau par le driver, les contrôles Git, les profils et
les preuves liées à sa propre génération. Les preuves d'un ancien essai ne
valident pas le nouveau. Le budget, les limites de tentatives, l'annulation et
les mécanismes de quarantaine restent ceux de CHEF.

La chaîne de reprise exige la génération immédiatement précédente. Si un essai
intermédiaire s'arrête avant d'exécuter le driver et n'enregistre aucun nouveau
retour de vérification, le système ne reprend pas automatiquement un retour
plus ancien. Il conserve le commit produit et bloque la reprise lorsque ce
commit diffère de la base initiale : une reprise ou replanification explicite
est alors nécessaire. Un usage nul ne prouve pas à lui seul une absence
d'exécution et ne permet donc pas de sauter une génération.

Si la sortie Git et les profils en échec restent identiques au retour précédent,
le superviseur signale une correction sans progrès et demande une résolution
explicite. Cette comparaison ne prétend pas détecter toutes les répétitions
sémantiques possibles.

Les tâches avec `capabilitySelection` n'utilisent pas cette reprise corrective
automatique : un effet externe possible exige un rapprochement. L'extension
n'autorise aucun envoi, paiement, publication ou autre effet supplémentaire.
L'absence de réponse d'un service ne prouve pas l'absence d'effet.

## Qualification et exploitation

Les suites de contrat doivent distinguer les preuves suivantes :

- Exécution réelle de fichiers, processus et opérations Git locaux.
- Tests de routage des consignes avec transports fournisseurs simulés.
- Validation du protocole d'observation avec rapports de fixture.
- Qualification d'un véritable observateur visuel/audio sur des artefacts réels.
- Test des modèles et fournisseurs réellement raccordés, puis du service déployé.

Un rapport de fixture portant `modality: "audio"` teste le contrat et ses refus ;
il ne prouve aucune audition. De même, les tests de prompt prouvent son
assemblage et sa transmission, pas son respect par un modèle réel. Une réussite
locale ne constitue ni une activation de tous les profils, ni un déploiement, ni
une validation universelle de toutes les IA par API.

Les tests concernés se trouvent dans `karta/test/chefObservedVerification.test.ts`,
`karta/test/chefCorrectionLoop.test.ts`, `karta/test/chefWorkshopConfig.test.ts`,
`karta/test/assistantPolicy.test.ts`, `karta/test/localComputeFabricProvider.test.ts`
et `karta/test/chefCodexCliDriver.test.ts`. Les résultats de campagnes doivent
rester dans leurs reçus datés, attachés à leur version de code, plutôt qu'être
représentés ici comme des garanties permanentes.
