# Préparation réseau Android — reprise du 25 novembre 2026

Base distante : `e04369c79c6395347b66557c0566dc913dc5613d`, arbre
`fe3506e8682cd5cd0a4ad9784fe041438475013d`, PR40 existante. Le checkpoint local
`1b87843` conserve exactement cet arbre avec une histoire locale distincte.

## Défaut de réception observé

Le run `45699636288`, job Android `139506020010`, atteint la préparation native,
puis échoue avant le redémarrage : 42 observations, `mobile_data=1`, zéro observation
qualifiée stable, échéance de 45 secondes. Le premier relevé indique encore un
réseau actif ; les 41 suivants indiquent un ensemble de réseaux actifs vide.
Le job Apple et les sept autres workflows de ce commit réussissent.

Cette preuve ne dit pas pourquoi le réglage DATA reste actif. Les commandes de
contrôle n'étaient pas reçues séparément et les états de téléphonie/souscriptions
n'étaient pas capturés. Android SDK35 prévoit des réglages par souscription en
multi-SIM et un traitement asynchrone de DATA ; ces possibilités restent des
hypothèses pour le binaire CI effectivement exécuté.

Les 18 fichiers de preuve sélectionnés proviennent de l'artefact `15066310692`.
L'archive téléchargée a été vérifiée par SHA-256
`0f3772fe08afa3fa911067ba829c0215b93249638b0e0027ac764b5a7e5f2089`.
La sélection conserve le reçu intégral des 42 observations et les sorties brutes
des première et dernière observations ; elle ne prétend pas reproduire tous les
349 membres de l'archive initiale.

## Changements reçus localement

- Un préparateur commun est appelé par le parcours natif complet et par un
  contrôle réseau préalable dans le même workflow. Ce contrôle est requis avant
  la construction APK, afin qu'une panne réseau soit reçue avant ce travail long.
- Le préparateur fixe le périphérique ADB, refuse un appareil physique avant
  modification et enregistre identité, souscriptions, état téléphone et commandes.
- Les cinq commandes existantes gardent leur ordre. Aucune écriture du réglage
  `mobile_data` ne transforme artificiellement une observation en réussite.
- La capture des sorties et l'exécution sont bornées ; les anciens reçus ne sont
  pas écrasés. Le mode d'inspection finale ne modifie aucun réseau.
- `COMMANDS_COMPLETED` et `OBSERVED` ne signifient jamais réseau isolé. Le champ
  `networkVerified` du préparateur reste faux ; l'observateur indépendant conserve
  seul ses critères et ses trois observations stables.
- Le lanceur conserve l'échec primaire même si les diagnostics finaux réussissent.
  La qualification complète garde les critères d'inférence, de chiffrement,
  d'intégrité, de reprise et d'isolation des comptes.

## Vérifications locales et limites

**PASS — 43 tests locaux** : 20 nouveaux tests du préparateur et 23 tests de
l'observateur existant, sans échec, en 8,174 secondes. Cette exécution utilise des
processus ADB synthétiques ; elle ne prouve pas l'effet des commandes dans Android.
Les empreintes du helper et du test sont consignées dans `qualification.json`.

**PASS — contrôle syntaxique** des deux lanceurs Bash, lecture YAML et vérification
de la dépendance du job Android au contrôle réseau. Les paramètres d'émulateur
des deux parcours concordent. La revue indépendante du helper, des lanceurs et du
workflow n'a relevé aucun défaut bloquant dans ce périmètre.

**PARTIEL — analyse de graphe.** GitNexus a été rafraîchi. Il ne résout pas le
symbole Bash `qa_adb` : risque UNKNOWN, pas absence d'impact. Les deux raccordements
et la propagation des erreurs ont été contrôlés dans les sources. La détection
finale et la comparaison au `main` exact sont archivées avec leurs limites.

**NON TESTÉ à la publication de cette phase — nouveau préflight réel et reprise
native complète.** Les résultats CI du commit publié doivent être reçus avant
toute conclusion. Aucun critère de l'observateur n'est assoupli dans ce lot.

## Sources de diagnostic

- [Réglages par souscription — SDK35 figé](https://android.googlesource.com/platform/prebuilts/fullsdk/sources/+/dc3f885ebe8ddc75bd9cf2d567eef4d1ed433a09/android-35/com/android/internal/telephony/GlobalSettingsHelper.java).
- [Traitement DATA — SDK35 figé](https://android.googlesource.com/platform/prebuilts/fullsdk/sources/+/dc3f885ebe8ddc75bd9cf2d567eef4d1ed433a09/android-35/com/android/internal/telephony/data/DataSettingsManager.java).
- [Action émulateur épinglée](https://github.com/ReactiveCircus/android-emulator-runner/blob/a421e43855164a8197daf9d8d40fe71c6996bb0d/src/main.ts) : chaque entrée de script est exécutée séparément ; la logique du contrôle est donc réunie dans un lanceur Bash unique.

Le scope et la répartition des fichiers sont dans `scope.json`. `evidence.zip`
préserve les preuves sélectionnées et les analyses ; `qualification.json`
relie leurs empreintes aux sources contrôlées. Le document IAO existant conserve
séparément la réconciliation des décisions utilisateur et des composants natifs.
