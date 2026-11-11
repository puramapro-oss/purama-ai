# Accessibilité IAO — mode vocal et saisie écrite

Ce document est un **relevé de qualification locale avant publication et CI**, horodaté dans `MANIFEST.json`. Ses statuts décrivent ce point de contrôle. Les résultats distants et l’état courant doivent être lus dans la PR de cette correction et dans le dossier partagé ONE associé à la PR #4 ; il n’est pas nécessaire de réécrire ce relevé après chaque exécution distante.

## Périmètre exact

Correctif local préparé le 11 novembre 2026 sur la tête active de la consolidation IAO, et non sur l’ancien `main` :

- dépôt : `puramapro-oss/purama-ai` ;
- PR active : <https://github.com/puramapro-oss/purama-ai/pull/45> ;
- branche distante : `audit/unlazy-consolidation-20261111-ac3c` ;
- base exacte arrêtée pour l’intégration : `7f26963c215ebfe6eb6c69dfb41140fd56e15363` ;
- arbre exact : `3774728bac87d936b309fffa00730dfe011be442` ;
- branche locale isolée : `feat/iao-accessibility-20261111`.

Le travail initial a été préparé sur `85cfd25a44913c77720842ca7f73a661854a447b`, arbre `d69b737ded2a720c7d75a0123ea9f592caa97bb2`, après vérification des 1 724 fichiers et de leurs modes. La provenance et les premières preuves sont conservées. La transposition vers la base arrêtée `7f26963` vérifie les 12 fichiers modifiés par les quatre commits amont, l’arbre complet de 1 729 fichiers et l’objet commit exact.

Aucun des fichiers produit ou de tests de cette correction n’a changé entre ces bases. Le seul chevauchement est le workflow : ses dix lignes KARTA sont conservées, avec les sept lignes d’archivage de cette correction. Les versions amont de `package.json` et `package-lock.json`, avec Vitest **4.1.12**, sont conservées à l’identique. Le runtime correspondant, déjà disponible, a été réutilisé sans installation. Aucun autre checkout n’a été modifié.

La transposition précise les signatures TypeScript des doubles `onClose` et `onSend` pour Vitest 4. Les assertions, les cinq parcours navigateur et leurs délais restent inchangés.

La map existante `git.deploymentEnabled` de `vercel.json` reçoit uniquement `feat/iao-accessibility-20261111: false`, pour désactiver le déploiement Vercel de cette branche de travail ; les autres règles et réécritures sont conservées. Cela ne constitue pas un déploiement sur la cible Hostinger.

## Changements produit

`VoiceMode.tsx` réutilise le moteur de dialogue Radix et les primitives du projet. Le panneau possède un titre, une description et une sémantique modale ; le clavier reste dans le dialogue, Échap appelle le mécanisme d’annulation existant, et le focus revient au déclencheur connecté, y compris lorsque le parent contrôle l’ouverture sans `DialogTrigger`. Le focus initial va au bouton de fermeture situé en haut du panneau.

La réponse n’est plus limitée à six lignes. La transcription et la réponse intégrale se trouvent dans une région nommée, défilable au clavier, avec retours à la ligne conservés et coupure des longues chaînes. Les commandes restent accessibles quand la fenêtre est courte. Le bouton principal nomme son action selon la phase : activer le micro, terminer l’enregistrement, traitement en cours désactivé, ou interrompre la réponse.

Les mouvements de la forme d’onde et des textes respectent la préférence de réduction des animations. L’état est annoncé par une région de statut stable ; la forme d’onde décorative est masquée aux technologies d’assistance.

`AgentChatTab.tsx` nomme explicitement le champ et le bouton d’envoi, affiche « Écris à… », prévoit une cible d’envoi d’au moins 44 px à la taille de police standard et supprime le défilement animé lorsque la réduction des mouvements est demandée.

Les traitements de capture, transcription, synthèse, autorisations, consentement, destination réseau, lecture automatique et annulation ne sont pas réécrits. Une comparaison des portions de source et des fichiers concernés est enregistrée dans `evidence/voice-boundaries.json`. Le comportement antérieur de synthèse du mode vocal reste celui de l’application : ce patch ne le transforme pas en moteur de parole local.

## Tests et preuves

Le manifeste `MANIFEST.json` donne les commandes, statuts et empreintes exactes de livraison. Les journaux bruts sont conservés localement dans `evidence/` et exclus de la liste de publication. Le commit candidat peut inclure le manifeste et les deux preuves JSON sélectionnées, sans index GitNexus, journal ni binaire.

- **PASS — régression reproduite :** la première série de neuf contrôles DOM a produit huit échecs sur la base initiale : dialogue absent, cycle de focus absent, Échap absent, texte tronqué et contrôles écrits insuffisamment nommés.
- **PASS — dix tests DOM après transposition, avec Vitest 4.1.12 :** vrai React et vrai moteur de focus Radix ; animations décoratives et services de voix remplacés par des doubles. Contrôles du cycle Tab/Maj+Tab, du bouton désactivé pendant l’attente, d’Échap et de la fermeture, du retour du focus, des libellés de phase, de l’annulation d’une réponse tardive, du texte intégral et du défilement réduit.
- **PASS — lint ciblé et TypeScript application :** voir les journaux et le manifeste.
- **NON TESTÉ localement — build du candidat transposé :** sur l’ancienne base, une première compilation du correctif avait réussi ; après l’ajustement des libellés, une compilation a été tuée par l’environnement avec le code 137. La relance a été arrêtée volontairement avec le code 130 pour laisser une autre compilation du groupe utiliser les ressources. Aucun build local n’a été relancé après transposition ; le build du candidat doit être validé par la CI.
- **PASS — découverte Playwright :** 26 scénarios `voice-consent`, dont les 21 scénarios existants et cinq nouveaux ; 17 scénarios `async-ui`. La découverte valide le chargement des fichiers de scénarios, pas leur résultat dans un navigateur.
- **NON TESTÉ — exécution navigateur sur cette correction :** les scénarios sont préparés pour la CI existante. Ils ne constituent pas encore une preuve d’exécution Chromium.
- **NON TESTÉ — matériel et technologies d’assistance :** aucun microphone physique, synthèse réelle, lecteur d’écran, clavier de contacteur ou appareil mobile réel n’a été essayé.

Le harnais navigateur réutilisé est `tests/voice-consent/harness.tsx`, avec les doubles définis par `tests/voice-consent/transport.ts`, et sa configuration `tests/voice-consent/playwright.config.ts`. Aucun accès au microphone réel ou service vocal distant n’y est autorisé. Un scénario ouvre et ferme uniquement au clavier et vérifie zéro appel, même au double de `getUserMedia`.

Les autres scénarios nouveaux vérifient le texte intégral sur 1 280 × 800 et sur 320 × 640 avec texte agrandi à 200 %, le défilement clavier jusqu’à la fin, le retour au déclencheur, et la réduction des animations. L’agrandissement testé par ce scénario est celui du texte CSS ; ce n’est pas une preuve de zoom de navigateur ni de test sur appareil physique. Les captures sont écrites via `testInfo.outputPath` puis jointes aux résultats Playwright. Les nouveaux scénarios enregistrent aussi une capture en cas d’échec, si la page est encore disponible.

## Exécution dans la CI existante

Le workflow `.github/workflows/purama-chef-hardening.yml` exécute déjà ces suites. Aucun nouveau workflow ni harnais concurrent n’est ajouté.

```sh
bash scripts/ci/run-site-browser.sh npm run test:voice-consent
bash scripts/ci/run-site-browser.sh npm run test:async-ui
```

Le chargement de `tests/voice-consent/accessibility.spec.ts` est automatique par la règle `*.spec.ts`. Les anciens scénarios de consentement et d’isolation sont conservés ; seuls leurs sélecteurs sont adaptés aux noms accessibles actuels. Les sélecteurs des pages Creator, dont la saisie n’a pas changé, restent inchangés.

Une étape d’archivage est ajoutée au job `site` existant, avec `if: always()`, pour conserver `test-results/voice-consent` pendant 14 jours. L’action `upload-artifact` est épinglée au commit `ea165f8d65b6e75b540449e92b4886f43607fa02`. Le nom de l’archive inclut le SHA du candidat. La comparaison YAML vérifie que les autres étapes et leur environnement d’exécution restent identiques.

## Analyse d’impact et limites de la preuve

GitNexus a été exécuté avant modification. Les fonctions visuelles partagées ont un impact déclaré HIGH/CRITICAL sur les parcours Email, Compta, Partner, Creator et Legal ; cet impact a été signalé avant de modifier le code. Le contrôle final du diff retrouve uniquement les quatre fonctions produit attendues et les trois aides de test modifiées. L’analyse n’indexe pas les nouveaux fichiers non suivis à ce stade et n’est pas une preuve d’absence de régression. Les journaux conservent les limites de parcours et l’absence d’extension FTS.

Au moment de ce relevé local, l’état est **PARTIEL** : le build et les suites navigateur sont à qualifier sur le commit intégrant cette correction. Le responsable de l’intégration peut reprendre les six fichiers de code et de tests, le workflow, la configuration Vercel et les quatre documents ou preuves JSON sélectionnés dans le manifeste. Aucun commit, push, fusion ou déploiement n’a été effectué par cette sous-tâche. Les résultats ultérieurs font foi dans la PR correspondante et le dossier partagé ONE de la PR #4.
