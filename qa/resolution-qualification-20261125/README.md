# Qualification et restitution privée des dossiers PURAMA

## Suivi correctif du 26 novembre 2026 — continuité et simulations

**PASS local ; CI du candidat et intégration à lire sur la PR correspondante ;
mise en production BLOQUÉE.** Le suivi prolonge la livraison intégrée par
[PR123](https://github.com/puramapro-oss/purama-ai/pull/123), depuis la
consolidation `271f40b666c11d90fe4a350a41432513a08fc72f`. Les preuves sont
rassemblées dans `continuity-verification-20261126.json`, avec les empreintes
des sources. Les reçus antérieurs ci-dessous restent historiques.

### Défauts reproduits et corrigés

1. **Unicode valide rejeté à la livraison.** Le schéma acceptait 160 points de
   code pour un identifiant et 500 pour une référence, tandis que la projection,
   le lecteur et le SQL comptaient des unités UTF-16. Les champs fournis ont
   maintenant des bornes cohérentes ; NUL et surrogates isolés sont refusés dès
   l’entrée. La migration additive 037 conserve 036, la RPC, les textes générés
   et les budgets en octets. Aucun identifiant métier n’est normalisé.
2. **Intention perdue lors du déclenchement.** Le bouton et l’Edge transmettent
   désormais l’identifiant au protocole KARTA existant. Une issue inconnue le
   conserve ; un reçu valide permet un nouvel ordre. Un verrou natif coordonne
   les onglets, les changements de conversation empêchent les notifications
   tardives et un reçu déjà acquis ne peut redevenir « non confirmé ».
3. **Dépendances absentes du seul dossier Edge.** Le contrôle de paquet démontre
   les deux sources canoniques nécessaires sous `/home/karta/src`. Il vérifie
   la disposition proposée et son cas négatif sans copier la politique ou le
   lecteur métier. La configuration du serveur reste à recevoir séparément.

### Contrôles locaux exécutés

| Vérification | Résultat | Portée |
| --- | --- | --- |
| Qualification, projection et lecteur | **141/141 PASS** | Trois fichiers hors SQL |
| SQL privé final après correction de typage | **130/130 PASS** | PostgreSQL PGlite ; anciennes catégories et migration 037 |
| Affichage et lecteur frontend | **55/55 PASS** | Régressions privées |
| Hook de déclenchement et caller | **44/44 PASS** | 37 hook + 7 caller ; ports substitués |
| Handlers chat et déclenchement | **115/115 PASS** | 59 chat + 56 déclenchement ; vrais handler/API/producteur, ports externes inertes |
| Navigateur Chromium | **3/3 PASS** | Deux onglets avec Web Locks natif ; restitution ordinateur et viewport mobile |
| Qualification → SQL → lecture → contexte chat | **12/12 PASS** | Zéro tentative réseau ; cas Unicode aux bornes |
| Fermeture locale du paquet Edge | **5/5 PASS** | 13 modules, 14 empreintes ; preuve statique |
| Types et builds frontend/KARTA | **PASS** | Plafond de tas Node de 1 024 Mio |
| Lint et contrats de données | **PASS** | 0 erreur ; 22 avertissements dans les fichiers non modifiés |

Ces groupes recouvrent les suites globales de CI : leurs nombres ne doivent
pas être ajoutés aux totaux distants. Le fichier PostgreSQL natif contient
14 tests ; seul le résultat effectivement retourné par son job CI prouve leur
exécution. Les profils mobiles Chromium ne prouvent pas Safari natif.

Les premiers processus SQL et un typecheck ont été interrompus sans résultat
par SIGKILL. La libération des seuls caches reproductibles et des limites
mémoire explicites ont permis les réceptions finales. Aucun test, assertion,
budget produit ou garde n’a été assoupli. Un typage manquant dans un nouveau
test SQL a été corrigé et contrôlé après une première correction mal ciblée,
repérée par la relecture indépendante.

### Livraison et limites actuelles

L’ordre de bascule doit rendre le moteur et ses gardes SQL compatibles, puis
mettre entièrement à jour l’Edge avant de servir la nouvelle interface. Une
ancienne Edge ignore `requestId` ; elle ne doit recevoir aucun envoi du nouveau
client. L’Edge corrigée refuse les anciens clients avant transmission.

La protection durable réutilise les journaux `execution_key` et
`execution_fingerprint`. Elle dépend de leur conservation et de workers
compatibles. Le stockage local ne contient que l’UUID d’intention ; sa
suppression ou l’utilisation d’un autre navigateur retire cette continuité.
Un reçu d’admission en queue ne constitue pas une preuve d’exécution métier.

Le suivi `deployment-readiness-followup-20261126.json` rapporte les observations
actuelles : Auth 502, frontend 402 avec `DEPLOYMENT_DISABLED`, anciens services
arrêtés, sauvegardes sources anciennes malgré un reçu récent de copie chiffrée,
et absence de source de production adoptée dans le rapprochement consulté.
Les instances P8 et ONE privées ne sont pas assimilées à la production.
**Les 44 scénarios métier restent NON TESTÉS sur les services réels.**

Le rafraîchissement complet du graphe de code a encore été interrompu avec
code 137 malgré un seul worker et une mémoire native bornée. Les métadonnées
restent sur l’ancien commit ; le contrôle du graphe demeure **PARTIEL**. Les
comparaisons de portée n’autorisent donc pas une affirmation de couverture
exhaustive. Les tests exécutés et la relecture des fichiers restent distincts.

## Réception initiale du 26 novembre 2026

**PASS local — mise en service BLOQUÉE sur l’environnement observé.** Ce complément termine le parcours logiciel de l’outil `qualify_resolution` dans le mécanisme privé existant. Il poursuit la même PR123 et conserve le premier module, les six spécialisations, les quatorze domaines, leurs identités et l’historique de réception ci-dessous.

### Ce qui est utilisable dans le candidat reçu

Le propriétaire peut sélectionner la capacité dans les catalogues existants, exécuter une mission avec son agent, retrouver une **Analyse de dossier** dans les résultats privés, ouvrir les six rubriques et leurs références, joindre explicitement le résultat au chat, puis le supprimer après clôture avec confirmation. Aucun agent existant ne reçoit automatiquement la nouvelle capacité.

Le statut visible **Analyse disponible** distingue la livraison d’une analyse d’un problème réellement résolu. L’identifiant, la révision et la date de l’instantané fourni restent distincts de la date d’enregistrement. Les informations absentes, contradictions et références non retenues restent visibles. Le contexte des quatorze domaines reste intégralement accessible dans un volet dépliable, afin de conserver une vue mobile lisible.

Le résultat est conservé par la RPC et dans la table privées existantes. La migration additive `karta/migrations/036_resolution_private_results.sql` étend seulement le validateur et la contrainte de type. Les migrations 028/034, le corps de persistance et la définition de la RPC de stockage sont inchangés. Aucun moteur, stockage de dossiers, planificateur, permission ou service parallèle n’est ajouté.

### Réception exécutée

| Vérification | Résultat local final |
| --- | --- |
| Qualification, projecteur, lecteur et SQL, 4 fichiers | **240/240 PASS** |
| Cycle moteur et approbations, 2 fichiers | **30/30 PASS** |
| Catalogues et intégration recherche/simulation, 2 fichiers | **18/18 PASS** |
| Composant et lecteur frontend, 2 fichiers | **55/55 PASS** |
| Handler de chat réel, transports substitués | **59/59 PASS** |
| Route réelle dans Chromium, ordinateur 1440×1000 et mobile 390×844 | **2/2 PASS** |
| Outil réel → projection → PGlite → RPC → lecture propriétaire → contexte chat | **11/11 contrôles PASS**, zéro tentative réseau |
| Typage et construction frontend/KARTA | **PASS** |
| Lint global | **PASS**, 0 erreur ; 22 avertissements hors fichiers modifiés |
| Contrats de base de données | **PASS** |

Les groupes du tableau portent sur des fichiers de tests distincts. Les totaux ultérieurs de CI recouvrent ces tests ; ils ne doivent pas être additionnés. Les 11 contrôles du banc sont une réception complémentaire, pas 11 services réels.

La migration 036 a été appliquée deux fois dans PGlite ; `pg_get_functiondef` confirme que la RPC de stockage demeure identique. Les trois anciens types de résultats privés passent leurs régressions. Trois nouveaux cas natifs PostgreSQL 18 sont ajoutés au fichier déjà exécuté par la CI : livraison concurrente idempotente, révocation pendant l’attente du verrou d’agent, borne JSON/JSONB. Leur exécution distante reste un jalon séparé du présent reçu local.

Le navigateur utilise le dossier synthétique réellement enregistré puis relu en SQL. Il vérifie les détails, références échappées, ouverture au clavier, sélection, envoi des seuls identifiants au handler, remise à zéro et suppression annulée/confirmée. Les transports Supabase et la réponse de chat sont substitués ; aucune session utilisateur ou base de production n’est qualifiée. Quatre captures finales ont été inspectées ; les vues d’ensemble ont aussi été relues par le coordinateur.

### Défauts observés et corrigés

La première projection de chat pouvait laisser des rubriques sans extrait quand trois grands dossiers étaient sélectionnés. Une réservation du coût JSON d’un premier extrait pour chaque rubrique non vide précède maintenant l’enrichissement ; la limite totale reste 16 000 octets. Les marqueurs de troncature et d’omission restent explicites. Les références intégrales restent dans le panneau.

Deux incompatibilités TypeScript du lecteur partagé ont été corrigées sans changer la configuration globale. La vue mobile a été raccourcie par un volet de contexte, sans supprimer de contenu. Une installation incomplète après manque d’espace et un fichier de test interrompu ont été rétablis ; la réception finale est postérieure à leur correction. Une construction interrompue avec code 137 a été suivie de constructions séquentielles réussies avec un plafond de tas Node de 1536 Mio.

### Portée du contrôle de code

Les impacts précis avant édition étaient **HIGH** pour le projecteur commun et le lecteur partagé, et **LOW** pour les composants d’affichage et de contexte. Ces avertissements ont été conservés et les anciens types ont reçu leurs régressions. Le rafraîchissement final complet de GitNexus a échoué deux fois avec code 1, sans diagnostic exploitable. La recherche plein texte reste indisponible.

Les appels finaux `detect-changes` ont terminé : 28 fichiers / 84 symboles / 1 flux signalés en risque MEDIUM pour le delta préparé, et 3 489 fichiers / 727 flux en CRITICAL face à `main`. **Analyse de graphe PARTIELLE :** ces chiffres reposent sur le graphe préédition conservé ; les décalages de lignes peuvent attribuer un changement à un symbole voisin et les nouveaux nœuds ne sont pas tous représentés. Ils ne mesurent pas complètement la portée finale. Le diff exact, les réservations, les invariants octet par octet, la revue indépendante et les réceptions exécutées restent les preuves principales de ce lot. La divergence historique entière n’est pas fusionnée dans `main` par cette livraison.

### Limites de la livraison et exploitation

Le rapport privé est entier ou refusé : 61 440 octets UTF-8 pour le JSON compact et 65 536 octets pour le JSONB, six rubriques, 2 048 éléments et 128 références au plus. La représentation du dossier principal reçu mesure 9 703 octets compact / 9 950 JSONB ; son contexte de chat mesure 8 151 octets. Ces nombres décrivent ce cas synthétique et ne remplacent pas les tests de bornes.

Les références et autorisations fournies restent **non authentifiées**. L’outil ne crée aucun droit, paiement, courrier, rendez-vous ou intervention. Les 44 scénarios métier spécifiés demeurent **NON TESTÉS sur le terrain** ; la qualification logicielle n’établit aucune couverture mondiale ou prestation disponible.

L’inspection Hostinger du 26 novembre est en lecture seule. Les anciens conteneurs KARTA, Redis KARTA, Auth et Edge sont arrêtés ; les instances actives P8/ONE privé sont distinctes. Les deux GET publics datés renvoient 502 pour Auth et 402 pour l’entrée PURAMA-AI. Un 402 ne suffit pas à diagnostiquer une cause financière. Aucun ancien conteneur n’a été redémarré et aucune migration de production n’a été appliquée. La destination actuelle et son propriétaire doivent être rapprochés avant mise en service.

### Preuves et reproduction

- `delivery-verification.json` : réception du complément, commandes, empreintes, corrections et limites.
- `private-resolution-roundtrip.json` : sortie réellement conservée/rechargée et fixture navigateur synthétique.
- `private-resolution-roundtrip.mjs` : banc reproductible depuis `karta/` avec `node --import tsx ../qa/resolution-qualification-20261125/private-resolution-roundtrip.mjs`.
- `deployment-observation-20261126.json` : état d’exploitation daté, sans secret ni donnée utilisateur.
- `scope.json` : réservation additive des fichiers et conservation du périmètre historique.
- `docs/iao-private-results.md` : contrat produit et ordre de livraison des migrations, worker, fonctions Edge et interface.

La CI existante est configurée pour exécuter aussi le banc de chaîne réelle et archiver son reçu. La publication, son arbre exact, ses contrôles distants et une éventuelle fusion doivent être rapprochés de PR123 ; un résultat local n’est jamais présenté comme un déploiement.

## Réception historique du 25 novembre 2026

Le texte ci-dessous conserve la réception initiale de l’outil interne. Son différé d’exposition utilisateur est levé dans le candidat du 26 novembre décrit plus haut ; ses limites de prestations et de vérification externe restent applicables.


**PASS local — PARTIEL produit.** Base `dd59dae670db7d3fca0d0b7173ad55aec5d10891`, branche isolée `feat/iao-resolution-qualification-20261125`. Le lot prolonge les six spécialisations et quatorze domaines approuvés le 25 novembre 2026. Il ne crée ni application, ni orchestrateur, ni mémoire, ni planificateur.

### Ce qui fonctionne

L'outil interne `qualify_resolution` réutilise `ToolDefinition`, la validation stricte de paramètres KARTA et la politique de traces `metadata_only`. Il est exporté par `karta/src/tools/registry.ts`. L'appelant reçoit une qualification déterministe de son instantané, sans réseau ni modification du dossier.

- **Dépendances :** cycles métier directs/indirects, exigences inconnues ou contradictoires, alternatives et acceptations référencées. Une première étape candidate ne satisfait pas automatiquement les suivantes. Aucun cycle n'est soumis à CHEF.
- **Transitions :** intervalles calculés depuis les seules déclarations actives référencées ; trous et chevauchements ; dates absentes ou invalides conservées comme inconnues. Aucune clôture d'ancien service ni dépense.
- **Effort :** choix existants de 2, 10 ou 25 minutes, appels/déplacements déclarés, pause et étapes déjà terminées. Ce choix n'accorde aucun droit ; la sélection porte sur l'effort, pas sur une autorisation d'exécuter.
- **Correction :** version attendue, concurrence, conséquences transitives, brouillon/transmission/effet distincts. Les liens absents et impacts inconnus restent visibles. L'absence de chemin fourni ne démontre pas l'absence d'impact.
- **Occurrences :** nouvel épisode, réouverture et rejeu technique séparés. Une même opération à effet incertain ou déjà produit ne devient pas un nouvel effet admissible par changement de libellé. Aucun rejeu ni calendrier créé.
- **Passation :** `prepared`, `transmitted`, `accepted` et `performed` qualifiés séparément par références fournies. `observedAt` date la consultation d'une référence et ne prouve pas l'ordre des événements. Une contradiction explicite reste bloquante. Le rôle, le dossier, l'acteur, l'action et les données ne transfèrent aucune habilitation.

Les quatorze domaines A–N sont des rattachements aux produits existants. Ils n'annoncent aucune disponibilité de prestation. Le propriétaire métier précis des capacités N reste à qualifier.

### Preuves

`verification.json` contient les commandes réellement exécutées, leurs sorties, les empreintes SHA-256 et les conclusions GitNexus. `internal-call.json` conserve un appel réel au JavaScript compilé, avec données synthétiques et six rubriques non vides.

- 73/73 tests ciblés PASS sur cinq fichiers avant l'ultime correction de date d'observation.
- 45/45 tests affectés PASS sur les deux fichiers du lot après cette correction. Les 28 régressions existantes n'ont pas été modifiées.
- Compilation produit et typage complet KARTA PASS sur la version finale.
- Appel interne via le registre et `runAgentCycle` : outil réel, ports modèle/état/journal substitués, zéro fournisseur. Gardes simulation/arrêt et confidentialité des traces vérifiées.
- Six régressions de revue reproduites avant correction, reçues après correction ; revue indépendante finale sans défaut concret restant.

### Impact avant commit

GitNexus reçoit le lot staged et la comparaison à sa base de consolidation en **LOW** : neuf fichiers, 318 symboles/propriétés, zéro flux existant affecté. La comparaison à `main` reste **CRITICAL** pour toute la divergence de consolidation (3 464 fichiers, 727 flux) ; elle ne constitue pas une réception de fusion. Une incohérence d’index intermédiaire avait attribué des appelants Swift/frontend impossibles aux nouveaux symboles ; une reconstruction sans cache a rétabli leurs identifiants et le seul appelant produit attendu. Le code n’a pas été modifié pour changer cette évaluation. La recherche plein texte demeure indisponible ; les analyses exactes, imports et diff sont conservés.

### Frontière de livraison

**PARTIEL :** exposition utilisateur différée. `CUSTOM_AGENT_TOOLS`, les options de création et le générateur conservent exactement leur état initial. La restitution privée existante accepte seulement ses noms d'outils qualifiés ; ce lot ne lui ajoute aucun stockage parallèle. Un appelant interne autorisé peut employer l'outil explicitement et recevoir son résultat.

Un résultat calculé depuis des références fournies ne prouve ni fait externe, ni source authentique, ni habilitation, ni disponibilité d'un intervenant. Les sorties exposent cette limite et ne deviennent jamais une autorisation d'agir. Aucun raccordement ONE, déploiement, CI distante, prestation terrain ou couverture mondiale n'est revendiqué.

Les fichiers runtime des PR121/122, les manifestes et les verrous sont préservés. Aucun cache GitNexus, dépendance installée, fichier compilé ou journal volumineux ne fait partie du livrable. À la réception locale du 25 novembre 2026, aucun changement distant n'a été effectué. Une publication ultérieure en branche et PR brouillon relève de la coordination du parent ; aucune fusion ni aucun déploiement ne sont inclus dans cette réception.
