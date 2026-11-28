# IAO — continuité des essais et inventaire, 25 novembre 2026

## Résultat vérifié

**PASS — correction de la lecture vidéo masquée.** Les essais déjà visités restent
montés afin de conserver leurs fichiers et leur saisie. Avant correction, revenir
à « Tous les essais » masquait les vidéos tout en les laissant jouer. Le test
navigateur reproduit cet état (`hidden`, mais `paused === false`). Le panneau
met désormais en pause les médias des essais masqués. Il conserve les fichiers,
la variante sélectionnée et la position ; revenir dans l'essai ne relance pas
automatiquement la lecture.

Le correctif modifie uniquement `src/components/IaoTrialPanel.tsx`. Le scénario
ajouté dans `tests/chat/trials.spec.ts` produit une vidéo WebM locale réelle et
observe les méthodes et états natifs du lecteur, sans simuler `play()` ou
`pause()`. Le changement volontaire de variante conserve la lecture de l'original
dans le panneau actif. Une revue indépendante des deux fichiers n'a relevé aucun
défaut bloquant dans ce périmètre.

## Provenance et continuité

- Base distante : PR40, `audit/reliability-oauth-20261110`, commit
  `dd59dae670db7d3fca0d0b7173ad55aec5d10891`.
- La copie de travail isolée a pour parent local
  `4fa91be71810a145b742f09eae689d62435aa9b2`. Son arbre initial est strictement
  identique à celui de la base distante :
  `dcf21bb64af2d10d6a8b2f24030c3f5a157378ac`.
- La publication doit ajouter ces seuls changements au parent distant, avec
  contrôle de la tête attendue. Aucun écrasement de branche ni fusion dans `main`
  n'est requis.
- L'inventaire et la conception de transition personnelle complètent le document
  existant `docs/iao-adaptive-intelligence-20261112.md`. Ils ne créent pas une
  seconde mémoire, un second comparateur ou un nouvel orchestrateur.

## Réceptions

| Contrôle | Résultat et portée |
| --- | --- |
| Régression avant correction | Échec attendu sur la vidéo masquée toujours en lecture ; reçu `trials-media-red-*`. |
| Régression après correction | 1/1 ; même assertion causale, sans assouplissement. |
| Suite navigateur des essais | 5/5 en 11,3 s, Chromium local ; transports du harnais isolés. |
| Scénario final avec pièces jointes | 1/1 après ajout des reçus JSON et captures ; assertions métier inchangées. |
| Tests unitaires ciblés | 23/23, aucun échec ni cas ignoré. |
| Typage de l'application | `npm run typecheck`, sortie 0. |
| ESLint du composant et du test | Sortie 0 ; lint final du fichier de test également reçu. |
| Inspection de la capture | Deux lecteurs visibles et arrêtés, fichiers et deuxième variante conservés. |
| Réseau du scénario final | 0 requête externe transmise par la page ; connexion locale Vite uniquement. |

La suite complète a été exécutée avant l'ajout des seules pièces jointes du test.
Le ciblage final et le lint couvrent l'empreinte finale du test. Ces réexécutions
se recouvrent : le nouveau scénario fait partie des cinq, pas d'un total de six.
Le premier essai de mise au point du sélecteur est conservé séparément dans
l'archive ; il ne constitue pas la reproduction du défaut produit.

Au retour, les positions observées sont `0,1132 s` et `0,0394 s`, identiques à
la sortie, avec `paused: true`. La vidéo muette mesure 64 × 64 pixels et dure
environ 0,63 seconde. Les contrôles natifs arrondissent cet affichage à `0:00` ;
le reçu JSON porte les valeurs précises. Cette preuve ne qualifie pas une écoute.

## Analyse d'impact

L'analyse GitNexus préalable retrouve `IaoTrialPanel`, mais ne résout pas ses
appelants : risque **UNKNOWN**, et non absence d'impact. Les deux raccordements
ont été vérifiés dans les sources : `ChatbotWidget.tsx` et `src/trial-page/main.tsx`.
La première détection du lot (trois fichiers, avant ajout des preuves) indique
quatre symboles, aucun processus résolu et un risque faible. La détection finale
est conservée dans l'archive ; les limites du graphe restent applicables.

La comparaison au `main` exact `ae84415be0b9516422805910be999a2c1e6350c0` a d'abord
échoué faute de référence locale. L'objet déjà présent dans un autre dépôt local
a ensuite été importé dans cette copie isolée, sans téléchargement ni modification
de ce dépôt. La comparaison aboutit et classe l'écart cumulé de PR40 comme
**CRITICAL** : 3 456 fichiers, 26 605 symboles et 655 processus affectés. La liste
affichée est plafonnée. Ce classement porte sur la divergence historique de la
branche de revue ; les tests de ce lot ne valident pas l'intégralité de cet écart.

L'index a été construit sur les sources locales ; FTS et vecteurs sont désactivés,
et des bornes de parcours sont signalées dans le journal. Ce graphe ne remplace
pas les tests et ne fournit pas une garantie exhaustive.

## État général et limites

- **PARTIEL — continuité fonctionnelle globale.** Les essais panier/médias/atelier,
  la réplication SMARANA et le transfert chat → atelier existent. Leur présence
  ne prouve pas le remplacement d'applications ou d'abonnements concurrents.
- **BLOQUÉ — assemblage natif complet.** Le démarrage accessible ne fournit pas
  `iaoRuntime`. L'autorité de session, le port SMARANA avec reçus durables et le
  serveur Fabric avec déduplication après redémarrage restent à qualifier et
  raccorder. Le refus `503` prévu au contrat n'a pas été masqué.
- **BLOQUÉ — accès natif pendant cette intervention.** Desktop Commander indique
  le Mac hors ligne ; les deux bridges Mac renvoient une erreur interne. Aucun
  nouvel essai natif ou contrôle de production n'est revendiqué.
- **CONCEPTION_EN_COURS — transition personnelle.** La reprise sélective de
  contexte externe et le bilan comparatif des usages sont décrits dans le document
  canonique. Ils ne sont pas annoncés implémentés ; la validation explicite de
  cette évolution reste distincte des corrections existantes autorisées.
- **NON TESTÉ — portée extérieure.** Autres moteurs de navigateur, audio écouté,
  appareils physiques, modèles réels, facturation, services distants, production
  et supériorité générale de l'IA.

## Pièces conservées

`qualification.json` fournit les empreintes des sources, commandes, versions et
résultats. `evidence.zip` conserve les journaux bruts, reçus navigateur, rapports
unitaires et analyses GitNexus. `media-preview-return.png` est la capture réelle
du scénario final. Ces preuves sont propres au périmètre et aux versions indiqués.
