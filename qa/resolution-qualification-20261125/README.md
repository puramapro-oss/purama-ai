# Qualification interne des dossiers PURAMA

**PASS local — PARTIEL produit.** Base `dd59dae670db7d3fca0d0b7173ad55aec5d10891`, branche isolée `feat/iao-resolution-qualification-20261125`. Le lot prolonge les six spécialisations et quatorze domaines approuvés le 25 novembre 2026. Il ne crée ni application, ni orchestrateur, ni mémoire, ni planificateur.

## Ce qui fonctionne

L'outil interne `qualify_resolution` réutilise `ToolDefinition`, la validation stricte de paramètres KARTA et la politique de traces `metadata_only`. Il est exporté par `karta/src/tools/registry.ts`. L'appelant reçoit une qualification déterministe de son instantané, sans réseau ni modification du dossier.

- **Dépendances :** cycles métier directs/indirects, exigences inconnues ou contradictoires, alternatives et acceptations référencées. Une première étape candidate ne satisfait pas automatiquement les suivantes. Aucun cycle n'est soumis à CHEF.
- **Transitions :** intervalles calculés depuis les seules déclarations actives référencées ; trous et chevauchements ; dates absentes ou invalides conservées comme inconnues. Aucune clôture d'ancien service ni dépense.
- **Effort :** choix existants de 2, 10 ou 25 minutes, appels/déplacements déclarés, pause et étapes déjà terminées. Ce choix n'accorde aucun droit ; la sélection porte sur l'effort, pas sur une autorisation d'exécuter.
- **Correction :** version attendue, concurrence, conséquences transitives, brouillon/transmission/effet distincts. Les liens absents et impacts inconnus restent visibles. L'absence de chemin fourni ne démontre pas l'absence d'impact.
- **Occurrences :** nouvel épisode, réouverture et rejeu technique séparés. Une même opération à effet incertain ou déjà produit ne devient pas un nouvel effet admissible par changement de libellé. Aucun rejeu ni calendrier créé.
- **Passation :** `prepared`, `transmitted`, `accepted` et `performed` qualifiés séparément par références fournies. `observedAt` date la consultation d'une référence et ne prouve pas l'ordre des événements. Une contradiction explicite reste bloquante. Le rôle, le dossier, l'acteur, l'action et les données ne transfèrent aucune habilitation.

Les quatorze domaines A–N sont des rattachements aux produits existants. Ils n'annoncent aucune disponibilité de prestation. Le propriétaire métier précis des capacités N reste à qualifier.

## Preuves

`verification.json` contient les commandes réellement exécutées, leurs sorties, les empreintes SHA-256 et les conclusions GitNexus. `internal-call.json` conserve un appel réel au JavaScript compilé, avec données synthétiques et six rubriques non vides.

- 73/73 tests ciblés PASS sur cinq fichiers avant l'ultime correction de date d'observation.
- 45/45 tests affectés PASS sur les deux fichiers du lot après cette correction. Les 28 régressions existantes n'ont pas été modifiées.
- Compilation produit et typage complet KARTA PASS sur la version finale.
- Appel interne via le registre et `runAgentCycle` : outil réel, ports modèle/état/journal substitués, zéro fournisseur. Gardes simulation/arrêt et confidentialité des traces vérifiées.
- Six régressions de revue reproduites avant correction, reçues après correction ; revue indépendante finale sans défaut concret restant.

## Impact avant commit

GitNexus reçoit le lot staged et la comparaison à sa base de consolidation en **LOW** : neuf fichiers, 318 symboles/propriétés, zéro flux existant affecté. La comparaison à `main` reste **CRITICAL** pour toute la divergence de consolidation (3 464 fichiers, 727 flux) ; elle ne constitue pas une réception de fusion. Une incohérence d’index intermédiaire avait attribué des appelants Swift/frontend impossibles aux nouveaux symboles ; une reconstruction sans cache a rétabli leurs identifiants et le seul appelant produit attendu. Le code n’a pas été modifié pour changer cette évaluation. La recherche plein texte demeure indisponible ; les analyses exactes, imports et diff sont conservés.

## Frontière de livraison

**PARTIEL :** exposition utilisateur différée. `CUSTOM_AGENT_TOOLS`, les options de création et le générateur conservent exactement leur état initial. La restitution privée existante accepte seulement ses noms d'outils qualifiés ; ce lot ne lui ajoute aucun stockage parallèle. Un appelant interne autorisé peut employer l'outil explicitement et recevoir son résultat.

Un résultat calculé depuis des références fournies ne prouve ni fait externe, ni source authentique, ni habilitation, ni disponibilité d'un intervenant. Les sorties exposent cette limite et ne deviennent jamais une autorisation d'agir. Aucun raccordement ONE, déploiement, CI distante, prestation terrain ou couverture mondiale n'est revendiqué.

Les fichiers runtime des PR121/122, les manifestes et les verrous sont préservés. Aucun cache GitNexus, dépendance installée, fichier compilé ou journal volumineux ne fait partie du livrable. À la réception locale du 25 novembre 2026, aucun changement distant n'a été effectué. Une publication ultérieure en branche et PR brouillon relève de la coordination du parent ; aucune fusion ni aucun déploiement ne sont inclus dans cette réception.
