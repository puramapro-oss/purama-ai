# PURAMA / IAO — première brique robotique

Le parcours utilisateur `/dashboard/robots`, son éditeur de routines à plusieurs
étapes, l'import/export de fichiers et l'aperçu visuel sont décrits dans
[ROBOTICS_CONNECTIONS.md](./ROBOTICS_CONNECTIONS.md). Il complète les outils KARTA
ci-dessous ; les connecteurs physiques restent à développer et à qualifier.

Cette version ajoute à KARTA un catalogue de cibles, un validateur de séances et un
simulateur de chronologie. **Elle ne connecte aucun robot, ne diffuse aucun son et
ne commande aucun moteur.** Aucun SDK constructeur ni modèle de robot n'a été
installé ou testé. Le catalogue de recherche ne constitue pas une certification
de compatibilité.

L'objectif reste de faire utiliser PURAMA depuis téléphone, tablette ou ordinateur
avec les capacités réellement accessibles de chaque robot. Une commande sans fil
est possible uniquement si le modèle et son interface la permettent. Une app mobile
constructeur ne donne pas automatiquement accès aux microphones, caméras, gestes,
articulations, routines ou mises à jour. Selon le matériel, une installation locale,
un appairage, un compte développeur ou un équipement supplémentaire peuvent rester
nécessaires. « Tous les robots sans rien brancher » n'est pas validé.

## Comportement livré

| Outil KARTA | Résultat | Effet matériel |
| --- | --- | --- |
| `robot_catalog` | Cibles, sources et limites, toutes marquées non raccordées | Aucun |
| `robot_plan_session` | Validation et chronologie ; échec explicite pour toute cible matérielle | Aucun |
| `robot_simulate_session` | Reçu `execution: simulation`, `physicalActions: 0` sur `purama-simulator` | Aucun |

Les outils sont disponibles dans le registre des agents personnalisés. Les options
de leur éditeur et la liste du générateur d'agents reprennent ces mêmes noms. Aucun
agent existant ni compte de production n'est modifié automatiquement. Après revue
et déploiement des composants concernés, l'utilisateur pourra les sélectionner
dans l'éditeur existant ; cette branche ne fournit pas un écran d'appairage robot.

Les trois outils transmettent un schéma JSON détaillé au fournisseur IA. Le contexte
de décision fournit `serverTimeEpochMs` pour calculer l'expiration sans inventer
l'heure. La validation serveur reste obligatoire. Les outils historiques sans
schéma gardent leur comportement. La liste d'outils ignore les propriétés héritées
et supprime les doublons.

Le moteur KARTA en mode `live` peut exécuter **le calcul du simulateur**. Le résultat
reste une simulation. Le mode global `simulation` de KARTA est un dry-run qui saute
tous les outils, y compris celui-ci : il ne valide pas la séance. Les mécanismes
existants d'arrêt, d'approbation et de journalisation restent appliqués. Le résumé
générique du moteur peut parler d'un « outil exécuté » ; le résultat propre de
l'outil précise dès ses premiers caractères qu'aucune action physique n'a eu lieu.

Les tests d'intégration passent par le constructeur d'agent, le registre, la boucle
KARTA et son contrat de résultat. Le fournisseur IA, la base, les notifications et
la persistance y sont simulés. Cela ne valide ni une génération libre par le modèle,
ni une connexion utilisateur dans le site déployé.

## Contrat des séances

Les outils de planification et simulation acceptent ce même objet JSON :

```ts
const session = {
  version: 1,
  sessionId: "presence-001", // nouveau pour chaque séance ; stable pour ses retries
  targetId: "purama-simulator",
  expiresAt: Date.now() + 60_000, // epoch en ms, au plus cinq minutes dans le futur
  steps: [
    { id: "welcome", kind: "speech", text: "Bienvenue. Vous pouvez arrêter.", durationMs: 3000 },
    { id: "greet", kind: "gesture", gesture: "greeting", durationMs: 2000, required: false },
    { id: "pause", kind: "pause", durationMs: 5000 },
  ],
};
```

Les durées sont des durées **planifiées** ; aucune synthèse vocale ne les mesure et
le simulateur n'attend pas le temps réel. Les seuls gestes reconnus sont les noms
`greeting` et `attention` ; ils ne contiennent aucune trajectoire d'articulation.
Une séance comporte 1 à 24 étapes, au plus cinq minutes au total, une minute par
étape et 2 000 caractères par texte. Les identifiants doivent être uniques par
séance. Les propriétés inconnues, actions non prévues, commandes motrices, cibles
inconnues et requêtes expirées sont refusées. `required` vaut `true` par défaut ;
les étapes optionnelles sont conservées, sans stratégie de dégradation matérielle
dans cette version.

Les tableaux incomplets et les propriétés à accesseur ne sont pas acceptés par
l'API locale. L'identité est copiée avant toute suspension asynchrone. Une horloge
non finie ou qui recule pendant une simulation provoque un échec et la libération
du verrou de l'utilisateur.

L'identité vient du contexte serveur KARTA et n'est jamais acceptée dans la séance.
Un même utilisateur et `sessionId` rejouent le même reçu en mémoire, jusqu'à
expiration. Réutiliser cet identifiant avec un contenu différent est refusé. Deux
séances distinctes du même utilisateur ne tournent pas simultanément dans une même
instance. La capacité par défaut est 100 reçus. L'expiration libère le cache ; il
n'est ni durable, ni distribué, ni adapté à l'exécution physique.

L'API locale du simulateur accepte un `AbortSignal` et arrête la simulation entre
deux étapes logiques ; un reçu annulé reste annulé lors d'un rejeu. KARTA ne transmet
pas actuellement de signal d'annulation d'outil. Aucun arrêt d'urgence matériel
n'est implémenté ou revendiqué.

## Exécution locale

Depuis `karta/`, avec Node 22 LTS à partir de 22.12, ou Node 24 LTS, pour
l'outillage de test (Node 24.22.1 utilisé pour cet audit) :

```sh
npm ci --ignore-scripts --no-audit --no-fund
node --import tsx scripts/robotics-demo.ts
npm run typecheck
npm run build
SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=test-only-not-a-secret npm test
```

La démo ne nécessite ni compte constructeur, ni clé de modèle IA, ni réseau. Elle
affiche un plan Optimus bloqué et un reçu de simulation. La configuration factice
de test est nécessaire aux imports existants de KARTA ; ce n'est pas une clé réelle.

## Cibles et interfaces à qualifier

Les sources et la date de consultation sont aussi enregistrées dans
[`src/robotics/catalog.ts`](src/robotics/catalog.ts). État de recherche au 30 octobre
2026 ; aucune de ces lignes ne signifie « connecteur PURAMA installé ».

| Cible | Point de départ et limite |
| --- | --- |
| Tesla Optimus, prioritaire | [Tesla Developer](https://developer.tesla.com/) : Fleet API véhicules/énergie ; interface Optimus exploitable non identifiée dans les documents consultés |
| Unitree G1 EDU | [SDK officiel](https://github.com/unitreerobotics/unitree_sdk2_python) ; édition et firmware requis à vérifier |
| Unitree G1 / UniStore | [Templates d'apps](https://github.com/unitreerobotics/unitree-app-templates) ; installation d'apps et développement complet sont des droits distincts |
| 1X NEO | [Fonctions produit](https://www.1x.tech/neo), app et enceinte Bluetooth ; cela ne prouve pas un accès tiers aux mouvements ou au micro |
| Figure 03 | [Helix](https://www.figure.ai/news/helix-02) ; aucun connecteur tiers validé ici |
| Boston Dynamics Atlas | [Plateforme Atlas](https://bostondynamics.com/products/atlas/) ; ne pas réutiliser un SDK Spot en supposant sa compatibilité |
| Apptronik Apollo | [Constructeur](https://apptronik.com/) ; interfaces et accès client à obtenir |
| UBTECH Walker | [Produit Walker](https://www.ubtrobot.com/en/humanoid/products/walker) ; domotique et accès aux articulations sont distincts |
| Fourier GR-2 | [Aurora SDK](https://github.com/FFTAI/fourier_aurora_sdk) ; prérequis firmware et essais nécessaires |
| Agility Digit | [Agility Arc](https://www.agilityrobotics.com/solutions) ; intégration industrielle et accès à qualifier |
| Pollen Reachy 2 | [SDK](https://docs.pollen-robotics.com/developing-with-reachy-2/sdk-introduction/discover-sdk/) ; référence de banc d'essai à base roulante, différente de l'objectif bipède |

## Conditions pour un premier connecteur réel

1. Identifier le robot, son édition, son firmware, son propriétaire et les droits
   d'accès effectifs. Utiliser l'interface documentée ou un accord constructeur.
2. Décrire séparément les capacités vérifiées : audio sortant, micro, caméra,
   gestes, locomotion, routines, télémétrie. Une capacité manquante ne devient pas
   disponible parce que PURAMA peut contrôler l'écran d'une application.
3. Implémenter un adaptateur propre au constructeur et le contrôle local nécessaire
   au robot. Garder les boucles motrices et les protections physiques sur leur
   contrôleur adapté ; le téléphone et le modèle IA donnent des intentions.
4. Ajouter autorisation par propriétaire, secrets protégés, commandes bornées,
   anti-rejeu durable, exclusion entre opérateurs, journal et état confirmé.
5. Vérifier sur matériel l'arrêt indépendant, la perte réseau, l'expiration des
   commandes, le redémarrage et le retour à un état sûr. Aucun succès ne doit être
   annoncé sans retour d'état du robot.
6. Tester d'abord une capacité non motrice, puis chaque geste sur une zone adaptée
   et sous supervision. Enregistrer modèle, firmware, mesure et résultat de chaque
   essai avant d'annoncer sa compatibilité.

L'accompagnement spirituel peut proposer des contenus choisis, de la réflexion et
des routines interrompables. La personnalité et les contenus sont personnalisables ;
la compétence physique, l'infaillibilité et une autorité spirituelle parfaite ne
se déduisent pas de cette personnalisation. Les textes de la démo sont originaux,
sans attribution à un maître ou à une tradition.

## Critères de livraison

| Critère | Preuve attendue |
| --- | --- |
| Catalogue fidèle à l'absence de connecteurs | Tous les modèles matériels bloqués et catalogue non modifiable par l'appelant |
| Séances bornées et explicites | Tests de schéma, expiration, actions inconnues, doublons et limites |
| Simulation isolée | Zéro appel réseau, reçus distincts de l'action physique, annulation et rejouabilité |
| Intégration KARTA | Outils résolus par un agent ; succès simulé, échec matériel, dry-run, approbation et arrêt préservés |
| Non-régression backend | Typecheck, build et suite KARTA complète |
| Interface et générateur | Noms cohérents ; compilation et essais utilisateur à vérifier séparément |
| Contrôle matériel | **BLOQUÉ / NON TESTÉ** : pas d'accès constructeur ni de robot de test dans cette session |
| Déploiement | **NON EFFECTUÉ** : branche de revue uniquement |

Résultats et limites de la seconde passe :
[`ROBOTICS_AUDIT_2026-10-30.md`](ROBOTICS_AUDIT_2026-10-30.md).
