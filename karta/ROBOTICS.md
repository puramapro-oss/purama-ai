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
deux étapes logiques ; un reçu annulé reste annulé lors d'un rejeu. Le contrat
d'exécution KARTA transmet désormais ce signal au simulateur. Le délai maximal
d'un outil déclenche une demande d'annulation et interrompt le cycle avant l'outil
suivant. Un adaptateur qui ignore le signal peut continuer : son arrêt reste non
confirmé et le cycle ne doit pas être rejoué automatiquement. Aucun arrêt d'urgence
matériel n'est implémenté ou revendiqué.

Les permissions sont relues avant chaque outil et lors de la résolution d'une
approbation, avec une lecture du stop global qui contourne le cache. Désactiver
l'agent, activer son arrêt, changer le mode simulation ou réduire l'autonomie
interrompt le cycle en cours à la prochaine frontière d'outil. Une augmentation
d'autonomie n'élargit pas les droits du cycle déjà lancé. Ces contrôles logiciels
ne rendent pas la lecture des droits et une action distante atomiques ; une
révocation pendant une opération déjà lancée exige encore un mécanisme d'arrêt
effectif propre à l'adaptateur et au contrôleur local.

Pour un agent personnalisé, le chargement vérifie aussi le propriétaire et les
deux interrupteurs `is_active` / `karta_enabled` dans `creator_agents`. Ces droits
et la liste des outils sont relus avant chaque outil du cycle : une désactivation
ou un retrait enregistré pendant la décision du fournisseur bloque le dispatch.
Les tâches déjà en file et les anciennes approbations passent par le même
résolveur. Les tests remplacent les services externes ; ils ne valident pas les
politiques RLS ni le service de base de données de production.

Le journal parent ne clôture plus une mission lorsqu'une approbation sœur est
encore `processing`. Une erreur de comptage ou un compte absent ne signifie pas
que toutes les actions sont terminées : l'état non terminal est conservé. Cette
correction évite un faux succès ; elle n'ajoute pas de transaction globale entre
les effets externes, les actions et le journal parent. Le verrou existant de
mise à jour du journal reste opportuniste.

## Vérification du 1er novembre 2026

Quatre scénarios supplémentaires échouaient avant cette correction : approbation
et rejet avec une autre action en cours, erreur de comptage et compte absent.
Après correction : **309 tests / 32 fichiers réussis**, contrôle TypeScript et
compilation KARTA réussis. Les services de base de données, modèles et verrous
sont substitués ; aucun moteur n'est connecté. Commande de la suite :

```sh
SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=test-only-not-a-secret npm test -- --maxWorkers=2
```

L'audit externe `npm audit --json` est bloqué par le contrôle automatique :
l'envoi des noms et versions des dépendances privées à `registry.npmjs.org`
demande une autorisation explicite. Aucun nouveau bilan de vulnérabilités n'est
disponible. Les tests navigateur ne sont pas réexécutés dans cette passe :
l'installation hors ligne des dépendances du site échoue, l'archive Vite 5.4.21
étant absente du cache. Ces limites ne sont pas des tests réussis.

## Robot personnel : état de compatibilité des pièces

La cible reste un humanoïde bipède de 1,80 m, avec deux mains à cinq doigts
articulés et retour tactile. Pour la variante personnelle, le vol, la nage et
le mode véhicule du corps sont retirés. Le drone de charge reste un sous-système
distinct dont l'intégration dorsale n'est pas démontrée. Aucun modèle Dropbear
ou autre n'est déclaré sélectionné ou compatible par cette note.

Les dossiers PURAMA de reprise et d'audit du 1er et du 3 octobre, relus le
1er novembre, ne fournissent pas de nomenclature bipède qualifiée. Les plans,
révisions et caractéristiques nécessaires ne peuvent pas être déduits du seul
catalogue logiciel. Les contrôles encore ouverts sont les suivants :

| Interface | Preuve nécessaire avant de déclarer la compatibilité |
| --- | --- |
| Structure, moteurs et mains | Plans cotés, fixations, tolérances, masses, couples continus et transitoires ; collisions et efforts calculés puis essais adaptés |
| Batterie et distribution | Références exactes, plage de tension complète, pointes de courant, protections, chargeur, conversion et dissipation ; schéma électrique vérifié |
| Connecteurs et bus | Brochages et polarités, niveaux logiques, protocole et firmware, terminaison, adressage et comportement en rupture de liaison |
| Capteurs et commande | Unités, repères, latence, fraîcheur des mesures, zéros, limites articulaires et calibrations propres à chaque pièce |
| IAO et PURAMA ONE | Adaptateur matériel effectif, capacités autorisées, identité, annulation et retours d'état ; aucun succès physique déduit de la seule acceptation d'une commande |
| Arrêt et équilibre | Contrôleur local et dispositifs indépendants ; essais protégés de perte réseau, panne et arrêt tenant compte du risque de chute du bipède |

### Contre-vérification de la référence Dropbear

La [nomenclature amont](https://github.com/Hyperspawn/dropbear_bom/blob/78f932c6ede3d39ca484804ab073919881a8830e/bom.md)
contient des A4988 annoncés 8–35 V, un support décrit « 24–48V » et une batterie
48 V. La [fiche Allegro A4988](https://www.allegromicro.com/~/media/Files/Datasheets/A4988-Datasheet.pdf)
donne une alimentation de puissance de 8 à 35 V. **Le support ne rend pas le
circuit compatible avec une alimentation directe à 48 V.** Le branchement direct
est exclu ; conversion et protections ou pilote approprié restent à dimensionner
sur la configuration choisie. Ce constat documentaire n'est pas un essai électrique.

Les [détails électriques](https://github.com/Hyperspawn/dropbear_docs/blob/1c9ebcc249b7cbbe1fa619883407236d1a632a90/docs/04-electronics/README.md)
et [procédures d'étalonnage](https://github.com/Hyperspawn/dropbear_docs/blob/1c9ebcc249b7cbbe1fa619883407236d1a632a90/docs/08-calibration/README.md)
sont encore annoncés à venir. Le dépôt principal distingue ses essais de marche
simulés de la validation physique. La licence du [dépôt principal](https://github.com/Hyperspawn/Dropbear/blob/main/LICENSE)
limite l'autorisation gratuite à un usage personnel non commercial ; vérifier les
licences fichier par fichier et les droits avant intégration pour une entreprise.
L'absence de vente du robot ne suffit pas à établir tous ces droits.

L'objectif de personnalisation est conservé : tâches, contenus, routines et
paramètres exposés par chaque interface. Les bornes de courant, couple, vitesse,
température et arrêt font partie de la qualification matérielle ; elles ne sont
pas des obstacles à supprimer pour obtenir un contrôle universel.

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
