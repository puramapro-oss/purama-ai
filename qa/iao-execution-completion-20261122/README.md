# IAO — lecture sociale et achèvement borné

## Identité, autorisation et périmètre

Projet existant : `puramapro-oss/purama-ai`, orchestration KARTA et interface IAO.
Base inspectée : `5a01da79e810c8f4a900ebc95ae544006b9333d6`, branche de consolidation
`audit/reliability-oauth-20261110` (PR #40). Branche de travail :
`fix/iao-runtime-deadline-20261122`.

Conception : `PRET_A_CODER` pour les garanties d'exécution et de consultation déjà définies.
Référence : validation collective de Matiss du 21 novembre 2026, complétée par sa demande
actuelle d'ajouter les capacités manquantes à IAO. Le catalogue et l'audit détaillés restent
dans la Page existante `page_52e96d68878481918b9374550aa378ca` ; ce dossier contient les
preuves du lot de code, sans créer une nouvelle autorité de projet.

Les trois lots réutilisent les contrats existants. Aucun nouveau service d'identité,
orchestrateur, dépôt de mémoire, schéma SQL ou fournisseur payant n'est introduit.

## Critères d'acceptation et responsabilités

| Lot | Responsable d'exécution | Critère observable | Périmètre |
|---|---|---|---|
| Délais IAO | `iao_runtime_reprise` | Une dépendance tardive ne devient pas un succès ; aucun calcul après expiration du contexte ; effet incertain préservé après dispatch | `kartaRuntimePort.ts`, tests dédiés |
| Connexion sociale | `iao_social_raccordement` | Transport et corps bornés ; plafond en octets ; réponse tardive nettoyée ; aucune répétition de création | Fournisseur de connexion existant, tests Deno |
| Lecture sociale | `iao_voix_continuite` | Projections fixes, utilisateur contrôlé, validation de toutes les lignes, erreurs minimisées, provenance et simulation explicites | `social-status.ts`, tests dédiés |
| Raccordement et réception | Agent principal | Métadonnées disponibles avant la décision du seul agent publicitaire existant ; typage, régressions, impact et livraison vérifiés | Contexte préparé, registres, tests du cycle, preuve et branche de revue |

## Analyse avant modification

L'index GitNexus 1.6.12 correspond à la base et aux 2 005 fichiers couverts.
`impact-before.json` conserve les sorties réelles.

- `bounded` : risque LOW ; appelants directs `KartaRuntimeIaoPort.prepare` et `#control`,
  puis `IaoFacade.#prepare`.
- `createZernioConnectionProvider` : risque LOW ; parcours de connexion, callback,
  vérification et confirmation d'absence d'un compte.
- `request` de ce fournisseur : risque LOW, borne inférieure ; deux appels non résolus
  sont explicitement signalés par l'outil.
- `maitreDesPublicites` : risque UNKNOWN pour la constante. Recherche textuelle complétée :
  `agents/index.ts` enregistre l'agent ; `resolveAgentDefinition` l'expose au moteur ; le
  serveur reprend le registre des types. Un test réel de ce registre couvre le raccordement.
- `deploymentEnabled` : propriété JSON non indexée, UNKNOWN. La comparaison JSON confirme
  que seule l'entrée `false` de cette branche de revue est ajoutée.

La recherche FTS est indisponible ; le graphe des dépendances fonctionne. L'extraction des
processus est plafonnée et certains appels dynamiques ne sont pas résolus. Une absence dans
le graphe n'est pas une preuve d'absence de dépendance.

## Résultat fonctionnel

### Une lecture sociale utilisable avant la décision

`social-status.ts` réutilise le client Supabase serveur existant. Le schéma vient du réglage
serveur `SOCIAL_DB_SCHEMA` : absence = `purama_ai`, valeurs explicites `purama_ai` et `public`
acceptées, autres valeurs refusées. Aucune recherche dans un second schéma n'est effectuée.
L'identifiant utilisateur vient du contexte KARTA, jamais des paramètres du modèle.

Les projections SQL sont fixes. Elles ne contiennent ni nom de compte, contenu, média,
secret, JSON fournisseur ou message d'erreur. Toutes les lignes sont contrôlées : propriétaire,
identifiants, ordre, booléens, dates, plateformes et statuts ; le contrôle inclut la ligne
supplémentaire qui sert à calculer la pagination. Une page incohérente est indisponible, sans
restituer un résultat filtré qui masquerait une rupture d'isolation.

Le mode direct du lecteur expose `accounts|posts`, une limite de 1 à 20 et un curseur UUID.
Son budget est de 5 secondes par lecture ; aucune clé, URL, colonne, table ou identité libre
n'est acceptée. Les champs historiques réellement nullable restent inconnus (`null`). Les
migrations sociales 003/004 existantes doivent être présentes dans le schéma retenu.

La contre-revue a découvert qu'un simple ajout de `social_status` aux outils de l'agent
n'aurait pas fonctionné de bout en bout : ce moteur décide une seule fois avant les outils,
et le canal de résultats privés existant ne conserve pas ce type de résultat pour un agent
statique. Ce raccordement initial a donc été remplacé.

`buildSocialBriefContext` attend désormais deux lectures parallèles **avant** la décision de
`maitreDesPublicites` : au plus 14 comptes et 10 publications restitués. Le moteur fournit le
mode d'exécution avec le brief acquis. Un mode absent/simulé, une configuration de modèle
simulé ou inconnue, ou l'absence de brief, ne déclenche aucune lecture sociale. Le déclencheur n'accorde
aucune autorité de lecture. `social_status` n'est pas présenté au modèle comme un outil
postérieur à sa décision ; son export reste un composant de lecture pour un hôte adapté.

Le contexte indique la provenance stockée, les pages restantes, l'absence d'instantané
atomique et l'absence de contrôle fournisseur. Une panne devient `unavailable`, jamais une
liste vide inventée. Les premières pages sont ordonnées par identifiant : elles ne sont ni
exhaustives ni nécessairement les publications les plus récentes. Un reçu d'association
n'est pas une preuve actuelle d'accès au compte ; `partial` et `publish_unconfirmed` ne
deviennent pas des succès ou des autorisations de republier.

Le test du cycle conserve le moteur, la définition d'agent, le lecteur, Supabase et le client
SDK du modèle. Les transports et effets finaux sont substitués. Il vérifie que l'état stocké
atteint réellement le message envoyé au modèle puis détermine les paramètres d'une action
PDF. La minimisation des traces du brief reste active ; aucune nouvelle persistance ou boucle
d'inférence n'a été ajoutée.

### Des délais IAO conservés jusqu'à l'acceptation

Une dépendance synchrone bloquant environ 130 ms pour un budget de 100 ms pouvait être
acceptée et déclencher le calcul suivant. Le runtime contrôle désormais l'horloge monotone
avant le dispatch, après résolution/rejet, après chaque transfert de promesse et après
validation et construction du résultat public.

La première contre-revue a reproduit un intervalle oublié entre `bounded` et `prepare`, puis
entre `#control` et `prepare`. L'état privé `StageDeadline` conserve maintenant l'échéance,
le dispatch et la première cause d'interruption jusqu'au point d'acceptation. Les erreurs de
validation tardives sont aussi reclassées comme interruptions. Les résultats déjà acceptés
ne sont pas révoqués rétroactivement.

Les budgets par étape et le contrôleur partagé restent inchangés : un contexte réussi
n'annule pas le calcul suivant. Avant dispatch, l'effet est absent ; après dispatch d'un
calcul ou contrôle mémoire, l'effet reste incertain. Le timer et le listener sont nettoyés
même lorsqu'une promesse ne se termine jamais.

Ce mécanisme refuse un résultat tardif dès que le contrôle revient. Il ne préempte pas du
JavaScript synchrone et ne garantit pas l'arrêt d'un effet distant déjà engagé.

### Une connexion sociale bornée en temps et en octets

Le fournisseur Zernio de connexion applique une échéance absolue commune au transport, au
corps et au parsing. Il utilise les helpers existants sans les modifier. Un transport qui
ignore l'annulation ou un corps sans fin de flux ne retient plus son appelant indéfiniment.
La borne de 1 048 576 octets est vérifiée pendant la lecture ; des caractères UTF-8 multioctets
ne peuvent plus contourner une mesure qui portait auparavant sur `text.length`.

Les corps tardifs ou refusés sont nettoyés sans attendre une annulation non coopérative.
Les erreurs publiques restent des codes fixes. Une création de profil à l'issue incertaine
ne déclenche pas un second POST automatique ; une validation tardive ne complète pas une
association OAuth. La contre-revue a aligné aussi la borne du helper et celle du lecteur aux
transferts du transport et après parsing.

Le délai par défaut reste de 15 secondes **par requête HTTP**, et non pour toute une
pagination ou transaction OAuth. Aucun appel fournisseur réel n'a été réalisé pour ce lot.

## Vérification et contre-revues

| Campagne ciblée | Résultat observé |
|---|---|
| Runtime, première reproduction | 14 échecs et 10 réussites avant correction |
| Runtime, transferts et validations supplémentaires | 23 échecs et 32 réussites avant correction, puis 55/55 réussis |
| Runtime, reproduction indépendante finale | 18/18 conformes, séparés des comptes Vitest |
| Connexion sociale | 25 réussites et 9 échecs avant correction ; puis 34 réussites et 2 échecs pour la borne supplémentaire |
| Régression sociale finale, Deno natif | 113/113 réussis dans cinq fichiers, dont 36 tests de connexion |
| Lecteur social | 68/68 réussis |
| Cycle social avec SDK réels et transports substitués | 6 échecs et 8 réussites avant raccordement, puis 14/14 réussis |
| Raccordement, SDK Supabase et comportements voisins | 44/44 réussis dans quatre fichiers |

Ces campagnes se recouvrent avec la suite complète : leurs nombres ne s'additionnent pas
à son résultat. Les témoins de succès et les cas d'annulation après acceptation restent testés.

La contre-revue croisée a conduit à corriger les deux lacunes fonctionnelles décrites
ci-dessus. La revue finale du runtime et celle du contexte social n'ont plus identifié de
défaut concret dans ce périmètre. Les tests ne constituent pas une preuve d'absence universelle
de bugs ou de disponibilité des services de production.

### Régression finale du dépôt

Le typage final et le build final réussissent, chacun avec code 0. La suite KARTA complète
finale rapporte **4 236 réussites, 24 échecs et une erreur de worker**, sur 4 299 tests
collectés dans 189 fichiers ; code 1. Les 24 échecs concernent exclusivement les deux fichiers
de transport Unix (`listen EPERM`). Un script minimal utilisant seulement `node:net`, sans
import produit, reproduit le refus. Le worker de `chatHistoryIsolation.test.ts` reçoit un
SIGKILL ; 39 tests collectés ne reçoivent pas de résultat dans cette campagne.

Ce fichier d'historique passe lors de la campagne séparée de six fichiers : **126/126 tests**,
avec les tests d'admission du modèle, de brief et de contexte social. Le résultat de la
campagne complète reste PARTIEL ; les succès de campagnes différentes ne sont pas présentés
comme une exécution globale verte. La CI existante doit encore qualifier l'ensemble.

La première campagne générale avait identifié **10 régressions d'admission** introduites par
le raccordement initial : `getClaudeClient()` était appelé avant le dernier contrôle d'état,
et deux fois dans le cas valide. Le correctif lit maintenant `config.mockClaude`, réglage
serveur déjà utilisé pour sélectionner le client, sans l'initialiser. L'unique appel au client
reste après l'admission fraîche. `loopModelAdmission.test.ts` est conservé sans modification.
La contre-revue confirme l'absence de mutation de ce réglage dans les sources ; le test du
cycle utilise une configuration de simulation cohérente avec son transport de modèle.

Un premier lancement concurrent du typage a été interrompu avec le code 137. Cet essai et les
premières régressions restent dans les preuves historiques ; les vérifications finales de
typage et de build ont ensuite été exécutées séparément avec succès.

Commandes finales depuis `karta/` :

```bash
NODE_OPTIONS=--max-old-space-size=1536 npm run typecheck
NODE_OPTIONS=--max-old-space-size=1536 npm run build
node --max-old-space-size=384 node_modules/vitest/vitest.mjs run --maxWorkers=1
```

Les plafonds mémoire décrivent uniquement le banc local. Les scripts, dépendances et
permissions des tests du produit n'ont pas été modifiés pour obtenir ces résultats.

### Impact du raccordement au contexte

Après reconstruction de l'index, `AgentContextInput` a été classé **CRITICAL** (60 éléments
potentiellement affectés, imports partagés). Cet impact a été signalé avant modification.
Le changement est un champ optionnel `executionMode`, fourni avec le brief par KARTA.
`runAgentCycle` est relié au worker dans le graphe ; les tests couvrent aussi les chemins
d'approbation, simulation et confidentialité. Les consommateurs sans brief conservent leur
appel de contexte historique.

Les identifiants des callbacks anonymes de tests et certaines constantes ne sont pas résolus
par l'analyse automatique ; la lecture des imports, du registre et les tests du vrai cycle
complètent ces résultats UNKNOWN. Le contrôle final avant commit conserve ses propres
journaux et sa comparaison avec `main`, qui inclut la consolidation héritée.

## Dépendances de l'activation complète

Une recherche ciblée des sources accessibles n'a pas retrouvé d'implémentation exploitable
du port SMARANA `buildContext/control`, de l'authentificateur de session IAO pour l'audience
`purama-ai`, ni du serveur local Compute Fabric protocole 2. Les clients et contrats existants
sont conservés. Ce relevé ne démontre pas l'absence d'un service sur le Mac, qui n'a pas été
interrogé. Ces raccordements doivent être faits aux autorités existantes, avec leurs reçus
durables et leur identité réelle.

Le raccordement d'une publication KARTA au parcours social authentifié exige également une
délégation d'identité concrète. Une clé de service serveur ne remplace pas le jeton utilisateur
attendu par les routes sociales. La nouvelle capacité de lecture ne prétend pas résoudre ce
raccordement d'écriture.
