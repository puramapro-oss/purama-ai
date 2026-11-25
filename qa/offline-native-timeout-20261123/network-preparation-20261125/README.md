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

### Première réception du contrôle préalable

Le run `45713386695` du commit `a4153c6f2653f4ffeedbf254f06937d0ab7018e2`
reçoit les 43 tests synthétiques, puis démarre réellement l'émulateur. Le relevé
`emulator -version` échoue toutefois avec le code 127, car il choisit le binaire
graphique et ne trouve pas `libpulse.so.0`. Aucun helper ni observateur n'a été
exécuté dans ce passage ; aucun état téléphonique n'en est déduit.

Le lanceur utilise désormais `-no-window -version`, cohérent avec le mode déjà
démarré par l'action. Cette correction d'interrogation ne change aucun critère
réseau et n'ajoute pas de bibliothèque audio. Les preuves de cet échec sont dans
`ci-version-failure.json` et `ci-version-failure.zip`. Le nouveau passage réel
reste à recevoir ; les preuves de la phase précédente demeurent inchangées.

- [Réglages par souscription — SDK35 figé](https://android.googlesource.com/platform/prebuilts/fullsdk/sources/+/dc3f885ebe8ddc75bd9cf2d567eef4d1ed433a09/android-35/com/android/internal/telephony/GlobalSettingsHelper.java).
- [Traitement DATA — SDK35 figé](https://android.googlesource.com/platform/prebuilts/fullsdk/sources/+/dc3f885ebe8ddc75bd9cf2d567eef4d1ed433a09/android-35/com/android/internal/telephony/data/DataSettingsManager.java).
- [Action émulateur épinglée](https://github.com/ReactiveCircus/android-emulator-runner/blob/a421e43855164a8197daf9d8d40fe71c6996bb0d/src/main.ts) : chaque entrée de script est exécutée séparément ; la logique du contrôle est donc réunie dans un lanceur Bash unique.

Le scope et la répartition des fichiers sont dans `scope.json`. `evidence.zip`
préserve les preuves sélectionnées et les analyses ; `qualification.json`
relie leurs empreintes aux sources contrôlées. Le document IAO existant conserve
séparément la réconciliation des décisions utilisateur et des composants natifs.

### Réception de la commande d’aide et correction ciblée

Le run `45715335512` du commit `337dcdd1ee7d47999bdc8175f251d2032636a159`
a franchi le relevé de version sans fenêtre : émulateur 37.3.10.0 et image
API35/google_apis/x86_64, révision 9. Il s’arrête ensuite sur `cmd phone help`,
qui émet 16 019 octets d’aide normale, sans stderr, puis retourne 255. Aucun
réglage n’a été changé et l’observateur n’a pas démarré. Le checkout de fusion
`d0015c928eaed945b499376229503f34af981544` porte bien l’arbre `a3e51821`.

L’aide documentaire est retirée du chemin obligatoire. Le refus des erreurs des
autres commandes, les contrôles radio et l’observateur demeurent identiques.
La fixture existante reproduit désormais le retour 255 observé : les deux cas
fonctionnels ciblés échouent avant la correction, puis les 43 tests réussissent
après, sans cas ignoré. La revue du graphe a signalé un impact CRITICAL partiel
sur le nom générique `execute` ; les appels directs ont aussi été inspectés.

Le reçu `ci-help-failure.json` et l’archive `ci-help-failure.zip` lient les sources,
le rouge/vert et les pièces exactes de ce passage. Ils ne qualifient pas encore
la préparation réseau réelle de la nouvelle version. La source SDK35
[BasicShellCommandHandler](https://android.googlesource.com/platform/prebuilts/fullsdk/sources/+/dc3f885ebe8ddc75bd9cf2d567eef4d1ed433a09/android-35/com/android/modules/utils/BasicShellCommandHandler.java)
explique ce retour après l’affichage de l’aide.

### Abonnement DATA absent : précondition de préparation

Le run `45716525092` de `262f33d308402b3c3a91b537016fc557ec7bbb8d`
franchit les deux corrections d’instrumentation et reçoit les 43 tests.
Le préparateur termine en 3,530634 secondes, mais son succès signifie seulement
que les commandes sont revenues normalement. L’observateur refuse la coupure :
40 relevés complets gardent `mobile_data=1` et un ensemble de réseaux vide ;
le 41e appel commence à la fin des 45 secondes disponibles et est interrompu.
L’inspection finale réussit immédiatement après, sans preuve d’une panne générale ADB.

Les dumps initiaux, après DATA et après mode avion identifient un modem unique,
une SIM de souscription 1, mais `defaultDataSubId=-1` et `activeDataSubId=-1`.
Le défaut DATA reste absent dans l’inspection finale. `mobile_data1` et
`multi_sim_data_call` sont `null` : le masquage par une clé multi-SIM n’explique
pas cette réception. Le shell DATA retourne zéro bien que la cible par défaut
nécessaire à sa mise en œuvre manque.

La nouvelle préparation attend donc, avant toute mutation, que le vrai défaut
DATA corresponde à une souscription du mapping actif. Elle ne substitue pas
`defaultSubId`, n’exige pas `activeDataSubId` et ne force aucun réglage DATA.
Cette attente est bornée dans le budget global de préparation. L’absence de
convergence et les formats ambigus sont refusés avant la coupure ; le diagnostic
complémentaire demeure en lecture seule et ne remplace pas la cause primaire.
L’observateur final conserve tous ses critères.

AOSP explique pourquoi l’initialisation des souscriptions ne suffit pas à établir
ce défaut : la configuration opérateur doit aussi être chargée avant la sélection
automatique. Le lancement immédiat du contrôle constitue une hypothèse étayée
pour ce passage, à vérifier dans la prochaine CI. Il n’explique pas rétroactivement
le run `e04369c`, dont le dump téléphonique initial n’a pas été reçu.

Sources : [PhoneInterfaceManager figé](https://android.googlesource.com/platform/packages/services/Telephony/+/0f31d1f00721da0b6d830f51d621f15650956fd1/src/com/android/phone/PhoneInterfaceManager.java),
[MultiSimSettingController — SDK35](https://android.googlesource.com/platform/prebuilts/fullsdk/sources/+/refs/heads/androidx-constraintlayout-release/android-35/com/android/internal/telephony/MultiSimSettingController.java),
[diagnostic TelephonyDebugService utilisé par CTS](https://android.googlesource.com/platform/cts/+/927ad37e0ac7d0a863d14f5beba3eb9a5b1d4db0/hostsidetests/statsd/atom/AtomTestCase.java).

Régression ciblée sur les 13 nouveaux scénarios : 12 échecs et un succès avant
la correction, puis suite complète de 56 tests réussis après correction
(33 préparation, 23 observateur inchangé), sans cas ignoré. Le parser reconnaît
aussi les quatre dumps réels de `262f` comme attente d’un défaut DATA, plutôt
que comme un format inconnu. Le reçu `ci-data-default-failure.json` et son archive
conservent les sources, journaux et preuves. La convergence réelle de la nouvelle
attente reste NON TESTÉE jusqu’à réception de la prochaine CI.
