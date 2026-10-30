# Audit PURAMA / IAO robots — 30 octobre 2026

Complément ultérieur : le [parcours de connexion et son aperçu](./ROBOTICS_CONNECTIONS.md)
ajoutent une page et 12 tests navigateur locaux réussis. Les blocages navigateur
décrits ci-dessous correspondent à l'état de cette première passe d'audit.

## Périmètre et conclusion

Audit de la première brique robotique de la PR nº 5, initialement au commit
`9791abb4ffc3e649f97a05ae9f63168d9f433be5`. Le périmètre principal est le contrat
de séance, le simulateur, les outils KARTA, leur passage au fournisseur IA et les
dépendances nécessaires à leur fonctionnement et à leur vérification. Un contrôle
supplémentaire des dépendances du site a aussi été réalisé.

**PARTIEL pour l'objectif complet :** la préparation logicielle est corrigée et
testée ; aucune installation sur robot ni commande physique n'a été validée.
Ce rapport n'est pas une certification de sécurité ou de compatibilité universelle.

## Défauts reproduits puis corrigés

| Observation avant correction | Comportement vérifié après correction |
| --- | --- |
| Le fournisseur IA recevait un schéma vide, sans description des étapes ni heure de référence | Schémas JSON des trois outils transmis ; heure serveur fournie ; ancien comportement conservé pour les autres outils |
| Les noms `constructor`, `toString`, `__proto__` pouvaient être résolus depuis le prototype du registre | Seules les propriétés propres de la liste autorisée sont résolues ; doublons supprimés ; liste stockée mal formée ignorée |
| Un tableau d'étapes creux pouvait être accepté ; des accesseurs pouvaient s'exécuter pendant la lecture | Tableaux incomplets, accesseurs et champs symboliques refusés |
| Une requête catalogue pouvait être un objet `Date` ; un propriétaire mal formé produisait un `TypeError` | Validation du catalogue alignée sur le contrat et erreurs métier explicites |
| Une mutation du contexte pendant `await` pouvait laisser le verrou du propriétaire bloqué | Identité capturée avant suspension ; verrou original libéré |
| Une horloge non finie ou reculant pouvait produire un résultat incohérent | Échec explicite `INVALID_CLOCK` et libération du verrou |
| `qs` et `uuid` entraînaient trois alertes modérées en production KARTA | `qs` 6.17.1 et `uuid` 11.1.1 ; cycle de vie réel de `node-cron` 3 et sérialisation de Stripe testés |
| L'ancienne chaîne Vitest présentait des alertes de développement, dont critiques | Migration de l'outillage vers Vitest 4.1.12 ; suite complète exécutée avec cette version |
| Après réinstallation propre, le test d'approbation pouvait dépasser cinq secondes en attendant une notification vers `example.invalid` | Échec réseau substitué de façon déterministe ; le test vérifie l'appel et le maintien de l'action en attente sans exécution |

Les cas de régression ont échoué avant les corrections et réussi ensuite. Un échec
supplémentaire dû à une horloge fictive éloignée du temps réel dans le nouveau test
du fournisseur a été corrigé dans sa fixture ; il n'est pas compté comme un défaut
de production. Les scénarios avec accesseurs ou tableaux creux concernent l'API
JavaScript locale : ils ne prouvent pas à eux seuls une exploitation HTTP.

## Vérifications exécutées

Les chemins de travail sont relatifs à la racine du dépôt. Les clés des commandes
de tests ci-dessous sont factices.

| Répertoire | Commande / contrôle | Résultat observé |
| --- | --- | --- |
| `karta/` | `SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=test-only-not-a-secret npm test` | PASS, 206 tests, 27 fichiers, code 0, Vitest 4.1.12 |
| `karta/` | `npm run typecheck` | PASS, code 0 |
| `karta/` | `npm run build` | PASS, code 0 |
| Racine | `npm run build` | PASS, code 0 |
| Racine | ESLint sur les fichiers TypeScript modifiés ou ajoutés dans cette passe | PASS, code 0 |
| `karta/` | `npm audit` | PASS, zéro alerte déclarée par le registre, développement compris |
| `karta/` | `npm audit --omit=dev` | PASS, zéro alerte déclarée sur les dépendances de production |
| `karta/test/roboticsFuzz.test.ts` | 2 000 requêtes générées avec une graine fixe | PASS, validation bornée, chronologie cohérente, aucune action matérielle |
| Adaptateur du fournisseur | Schémas, heure serveur, réponse structurée puis exécution | PASS avec service distant simulé ; aucune inférence payante ou réelle revendiquée |
| Navigateur | Playwright, navigation locale | BLOQUÉ avant les assertions : Chromium absent et téléchargement invalide dans cet environnement |

Le serveur de prévisualisation a démarré avec `--host 127.0.0.1`, après un échec de
détection des interfaces réseau sur la configuration initiale. Cela ne valide pas
l'interface dans un navigateur. La tentative `playwright install chromium
--only-shell` a échoué avec une archive vide ou tronquée. Les six tests de navigation
ont donc échoué au lancement du navigateur, sans démontrer une régression de l'app.

Les tests KARTA substituent les services externes. Le test historique d'approbation
laissait une requête vers `example.invalid` dépendre du réseau ; son échec intermittent
après réinstallation a été reproduit puis corrigé par substitution de `fetch`. Il
vérifie aussi que l'indisponibilité des notifications n'efface pas l'action en attente.
Les nouveaux tests robotiques ne contactent aucun robot, compte utilisateur ou fournisseur.

## Dépendances du site : limites distinctes

Le fichier verrou du site a reçu les mises à jour compatibles disponibles de
DOMPurify, fflate, qs, nanoid, source-map-js, brace-expansion, moment et d'outils de
construction. Le site compile après cette mise à jour. L'alerte critique DOMPurify
n'apparaît plus dans l'audit final.

L'audit complet à la racine conserve **14 alertes : 0 critique, 2 élevées,
11 modérées et 1 faible**. Elles concernent les chaînes suivantes :

- Vite / esbuild : migration de l'outillage du site nécessaire ; distincte de Vitest KARTA déjà migré.
- Zod : migration majeure et vérification des formulaires / résolveurs nécessaires.
- React Router : mise à niveau et vérification des redirections / parcours nécessaires.
- OpenTimestamps / Request / Bitcore / bn.js / elliptic : chaîne ancienne à remplacer ou requalifier ; pas de rétrogradation artificielle vers `opentimestamps@0.0.0` pour masquer l'alerte.
- Tailwind Typography / postcss-selector-parser : dépendance transitive restant signalée.

Ces migrations générales restent **PARTIELLES**, avec des parcours navigateur non
vérifiés ici. Zéro alerte dans KARTA ne signifie donc pas zéro alerte dans tout
PURAMA, ni absence de toute vulnérabilité inconnue. Les chiffres sont ceux du
registre au moment de l'audit et doivent être revérifiés avant déploiement.

## Vérification des fabricants

| Cible | Source officielle consultée | Conclusion limitée aux éléments observés |
| --- | --- | --- |
| Tesla Optimus | [Tesla Developer](https://developer.tesla.com/) | Fleet API concerne véhicules et énergie ; aucune interface publique Optimus exploitable identifiée dans cette recherche |
| Unitree G1 EDU | [Fiche G1](https://shop.unitree.com/products/unitree-g1), [SDK](https://github.com/unitreerobotics/unitree_sdk2_python) | Développement secondaire renvoyé vers EDU ; modèle et firmware à qualifier |
| Unitree UniStore | [Template officiel](https://github.com/unitreerobotics/unitree-app-templates/blob/main/g1_mimic_demo/README.md) | Packaging, permissions et transfert de contrôle documentés ; aucune preuve que toutes les éditions standard deviennent programmables |
| 1X NEO | [Produit](https://www.1x.tech/neo), [communauté développeur](https://www.1x.tech/discord) | App, télécommande et enceinte Bluetooth annoncées ; pas une preuve d'API motrice tierce accessible au projet |
| Figure | [Helix 02](https://www.figure.ai/news/helix-02) | Autonomie constructeur décrite ; pas d'accès tiers PURAMA validé |
| Boston Dynamics Atlas | [Atlas](https://bostondynamics.com/products/atlas/) | Intégration industrielle Orbit annoncée ; documentation Spot distincte d'Atlas |
| Apptronik Apollo | [Apollo 2](https://apptronik.com/apollo/apollo-2) | Configurations bipède et roulante annoncées ; accès développeur à qualifier |
| UBTECH Walker | [Walker](https://www.ubtrobot.com/en/humanoid/products/walker) | Interaction et domotique décrites ; commande des articulations par PURAMA non validée |
| Fourier GR-2 | [Aurora SDK](https://github.com/FFTAI/fourier_aurora_sdk) | GR-2 explicitement pris en charge ; exigences de firmware publiées |
| Agility Digit | [Solutions / Arc](https://www.agilityrobotics.com/solutions) | Intégration industrielle annoncée ; documentation d'API et droits client à obtenir |
| Pollen Reachy 2 | [SDK](https://docs.pollen-robotics.com/developing-with-reachy-2/sdk-introduction/discover-sdk/) | Interface de développement documentée ; référence à base roulante, pas validation de l'objectif bipède |

Les annonces commerciales ne sont pas des mesures indépendantes de performance.
La recherche ne prouve ni l'absence absolue d'accords privés, ni leur disponibilité
pour PURAMA. Les notes du catalogue ont été précisées sans activer de commande.

## Analyse d'impact et travaux restants

GitNexus a classé l'interface commune `ToolDefinition` CRITICAL : 43 références
directes et 61 symboles potentiellement concernés. L'ajout du schéma est facultatif
et le comportement antérieur est testé. Les changements ciblés de validation,
simulateur et résolution des outils ont été classés LOW ; l'index ne résout pas
toutes les références aux constantes. Son extension FTS est indisponible et ses
parcours sont tronqués. Ce signal et la suite de tests ne remplacent pas la revue.

| Étape restante | État | Dépendance / responsable |
| --- | --- | --- |
| Revue, fusion et déploiement du code | NON EFFECTUÉ | Revue du dépôt et processus de déploiement PURAMA |
| Tests navigateur authentifiés, téléphone et tablette | NON TESTÉ | Environnement Chromium fonctionnel et compte de test |
| Inférence avec un modèle réel | NON TESTÉ | Fournisseur configuré et essai contrôlé |
| Premier connecteur matériel | PARTIEL : pas implémenté dans cette branche | Interface du modèle exact, version du SDK et firmware à fixer |
| Commandes physiques, voix, gestes, perte réseau et arrêt indépendant | BLOQUÉ / NON TESTÉ | Accès au robot par son propriétaire ; interfaces et droits constructeur |

Le simulateur reste sans réseau ni commande matérielle. Le contrôle moteur en
temps réel, l'autorisation par propriétaire du robot, l'arrêt matériel, les baux
distribués, l'anti-rejeu durable et la qualification physique restent nécessaires
avant toute activation d'un adaptateur. Aucun robot ne devient compétent pour
toutes les tâches ou autorité spirituelle parfaite par le seul ajout de PURAMA.
