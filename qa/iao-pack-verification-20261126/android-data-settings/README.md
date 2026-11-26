# Qualification isolée du parcours Android Settings / DATA

**PASS local : 46 tests dédiés. NON TESTÉ : parcours sur l’image Android réelle.**
Le reçu final, les versions et les empreintes exactes figurent dans `receipt-final.json`.

Ce lot ajoute seulement le script de diagnostic `mobile/scripts/qualify-android-data-settings.py`
et sa suite `mobile/tests/watch-native/data-settings-qualification.test.cjs`.
Le préparateur, l’observateur, leurs 56 tests et le workflow ne sont pas modifiés par ce lot.
Le périmètre et le propriétaire sont consignés dans `scope.json`.

## Conditions et portée

Le diagnostic exige un reçu original `FAIL / data_subscription_not_ready`, une origine
fraîche (au plus 180 secondes), le même serial d’émulateur épinglé, le garde QEMU,
un seul modem et un seul abonnement actif chargé. Les propriétés de l’image et son
empreinte doivent correspondre à API35, Google APIs, x86_64, révision 9,
`AE3A.240806.043/12960925`. L’ancien reçu ne contient pas d’UUID de boot noyau : la liaison
repose sur le serial, l’image, le run UUID, le checkout et la fraîcheur, avec exécution
prévue dans la même invocation d’émulateur que le préflight.

Sans `--allow-settings-transition`, le script ne lance **aucune commande ADB**.
Avec ce flag, il résout l’activité Settings attendue, vérifie la fenêtre, puis recherche
une association unique entre le titre anglais `Mobile data`, le switch et sa ligne
cliquable. Les identifiants, états et coordonnées viennent du dump reçu. Une autre
langue ou structure est refusée ; aucune locale n’est changée.

Un essai contient un clic si le switch est initialement OFF, au plus deux clics OFF→ON
si le switch est initialement ON. Chaque clic est précédé d’un nouveau dump, après
revalidation de l’abonnement. Une transition doit être observée avant de poursuivre.
Le plafond de dix observations couvre le cas testé à neuf observations, avec trois
observations possibles pour chacune des deux transitions. Tous les appels ADB restent
bornés par le runner existant et le budget global maximal de 60 secondes. Aucune écriture
directe de réglage téléphonie, commande radio ou invocation Binder n’est utilisée.

Le script conserve ses captures et traces sous `data-settings-qualification/`, refuse
de réutiliser ce répertoire, et vérifie que le reçu original est inchangé avant les
actions UI ainsi qu’à la fin. Les dumps UI temporaires sont propres au run sur l’émulateur
jetable. Les captures d’échec sont tentées dans le budget restant.

## Commande prévue depuis le répertoire mobile

```sh
python3 -B scripts/qualify-android-data-settings.py \
  --artifact-dir "$PWD/qa/android-network-preflight" \
  --allow-settings-transition
```

Codes de sortie : `0` signifie seulement `DATA_SELECTION_OBSERVED` dans le reçu
**diagnostique** ; `24` couvre un refus, un essai inefficace ou une absence d’essai ;
`2` couvre des arguments invalides ou un répertoire de preuve déjà présent.
`networkVerified` reste toujours `false`. L’échec initial ne devient jamais un PASS.

Le propriétaire du workflow doit conserver le code original. Exemple de composition
dans le même émulateur, à intégrer par ce propriétaire :

```sh
bash -c '
  PURAMA_QA_ORIGINAL_EXIT=0
  bash scripts/qualify-android-network.sh || PURAMA_QA_ORIGINAL_EXIT=$?
  if [ "$PURAMA_QA_ORIGINAL_EXIT" -ne 0 ]; then
    python3 -B scripts/qualify-android-data-settings.py \
      --artifact-dir "$PWD/qa/android-network-preflight" \
      --allow-settings-transition || :
  fi
  exit "$PURAMA_QA_ORIGINAL_EXIT"
'
```

Le script refuse les autres causes d’échec avant ADB. L’uploader existant du répertoire
de préflight peut conserver le sous-dossier. Aucune CI n’a été lancée par ce lot.

## Réception locale

```sh
node --test --test-concurrency=1 --test-reporter=tap \
  mobile/tests/watch-native/data-settings-qualification.test.cjs
```

Les tests utilisent le vrai parseur Python et des processus ADB synthétiques. Ils couvrent
l’autorisation explicite, le chemin ON/OFF, la géométrie réellement observée, les retards
UI, les changements d’abonnement/fenêtre, les ambiguïtés, les reçus mal formés, l’absence
d’effet DATA, les limites de durée/sortie, les empreintes des flux et la conservation
de l’origine. Ils ne qualifient aucun appareil réel.

Les cinq contre-exemples de revue ont été reproduits avant correction et sont conservés
dans `characterization.json` et `tests-characterization.log`. Le passage final comprend
46 réussites, sans échec ni test ignoré. Le premier passage de 37 cas appartient à la
version antérieure et n’est pas additionné au total final.

L’impact GitNexus reste **UNKNOWN** : index existant en retard d’un commit, FTS indisponible
et résolution partielle des symboles Python. Les tentatives pré-code sont conservées
dans `impact-before.json`. La revue directe confirme que les quatre fichiers réutilisés
et leurs empreintes restent inchangés. Aucun commit ni publication n’a été effectué ici.
