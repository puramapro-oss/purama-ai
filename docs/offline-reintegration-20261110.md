# IAO — Réintégration et vérification du socle de textes hors connexion

Date : 10 novembre 2026. Statut global : **PARTIEL**. Ce lot est un candidat local isolé ; il ne qualifie ni l’ensemble de PURAMA ONE ni les capacités natives décrites dans la spécification.

## Source et propriété du travail

Base Git exacte : `bc5076fc2c8589e54c09559ed246ae0022ae3a4c`.
Branche de ce candidat : `audit/iao-offline-reintegration-20261110`.
Le code de départ a été cloné sans hardlinks depuis le snapshot committé du chantier d’isolation des comptes. Les checkouts actifs ont été consultés sans modification.
Le lot historique du 25 octobre a fourni l’espace de textes et sa recette ; seuls les fichiers hors connexion pertinents ont été repris, jamais le patch cumulé de 173 fichiers.
Les ressources hors connexion étaient identiques entre la référence GitHub `1daf6314d60f6dd336c3a3601ddf73cf432ef4b3` et cette base locale lors de la comparaison.

Dossier du candidat : `/Users/matissdornier/purama-patches/iao-offline-reintegration-20261110/code`.
Preuves : `../evidence/`. Réservation du périmètre : `../CLAIM.json`.
Spécification canonique : https://chatgpt.com/space/page_cd00f5cf6018819196a13229e4906276

## Défauts établis avant correction

- L’installation du service worker ignorait l’échec du téléchargement obligatoire et pouvait activer un mode hors connexion incomplet.
- Son activation supprimait les caches étrangers présents sur la même origine.
- Les tests du manifeste pouvaient réussir sans assertions lorsque le manifeste ou son lien était absent.
- La tranche historique acceptait un HTTP 200 sans vérifier le contenu : une page HTML de repli à la place du JavaScript pouvait être déclarée prête.

Ces défauts ont été reproduits avant correction. Les résultats historiques du 25 octobre restent des résultats historiques ; ils ne sont pas additionnés aux nouvelles exécutions.

## Comportement obtenu

L’espace accessible à `/offline.html` permet de créer, enregistrer, rechercher, importer et exporter des textes dans IndexedDB. Le lien « Textes hors connexion » rejoint cet espace depuis les réglages. La sauvegarde est annoncée après confirmation de la transaction. Les conflits entre onglets conservent la version locale récupérable ; une modification périmée ne ressuscite pas un document supprimé. Un export inclut le texte courant non enregistré, sans le déclarer sauvegardé.

Les imports de cette tranche sont des textes UTF-8 limités à 1 Mio. Les octets UTF-8 invalides, NUL et dépassements sont refusés sans remplacer le contenu existant. Le texte HTML est affiché comme texte.

Le worker vérifie MIME, absence de redirection, taille décodée exacte et SHA-256 des deux ressources requises avant toute écriture. Les lectures sont bornées et les téléchargements annulés après dix secondes. L’état prêt vérifie les deux ressources effectivement présentes ; un simple HTTP 200 ne suffit plus. Une préparation défaillante ne remplace pas des octets déjà valides. Le cache porte une version propre à la livraison et le nettoyage conserve les autres espaces de cache.

Les écritures Cache API ne sont pas une transaction atomique : la sûreté vient de fichiers identiques pour une version donnée et de la revalidation du jeu complet avant l’état prêt. Le manifeste de taille/empreintes ne constitue pas une signature de provenance indépendante de l’origine Web.

## Garde des mises à jour

`npm run build` commence par `npm run check:offline-assets`.
Le vérificateur lie le manifeste à la version du cache et refuse une modification des ressources avec réutilisation de la version, une régression de version ou une divergence entre worker et espace local. Un manifeste historique sans marqueur ne peut être amorcé que si les descripteurs correspondent déjà aux fichiers.

Pour modifier une ressource d’une prochaine livraison :

1. Incrémenter explicitement les deux constantes `CACHE_NAME` vers le même numéro supérieur.
2. Exécuter `npm run prepare:offline-assets`.
3. Rejouer les tests du lot et la compilation.
4. Qualifier l’intégration réelle et le comportement de mise à jour.

Cette garde empêche un oubli de maintenance ; une édition manuelle volontaire de toutes les métadonnées peut la contourner. Le worker vérifie séparément les octets effectivement reçus du serveur.

## Recette exécutée

| Contrôle | Résultat | Preuve |
| --- | --- | --- |
| Cycle de vie du cache et validation des octets | PASS — 20 tests Node | `../evidence/offline-unit-final.log` |
| Garde de version des ressources | PASS — 14 tests Node | `../evidence/offline-unit-final.log` |
| Espace local dans un vrai navigateur | PASS — 11 scénarios, aucun ignoré | `../evidence/browser-final.log` et `browser-report-final.json` |
| Manifeste PWA et lien depuis la page d’accueil | PASS — 2 scénarios, aucun ignoré | Même rapport navigateur, 13 scénarios au total |
| Typage TypeScript de l’application | PASS — sortie 0 | `../evidence/typecheck.log` |
| Compilation avec contrôle d’intégrité | PASS — sortie 0 | `../evidence/build-final.log` |
| Lint des fichiers TypeScript modifiés | PASS — sortie 0 | `../evidence/lint-changed.log` |
| Revue visuelle | PASS sur les captures du scénario testé à 390 px ; qualification matérielle distincte | Captures dans `test-results/offline/` |

Environnement observé : macOS 26.7 (25G229), arm64, Node 26.0.0, npm 11.12.1, Playwright 1.59.1 et Chromium Headless Shell 147.0.7727.15. La compilation emploie des paramètres Supabase publics fictifs ; aucun secret de production n’est nécessaire à cette recette.

Les onze parcours de l’espace local contrôlent les tentatives HTTP et WebSocket, y compris le second profil de restauration. Aucune requête applicative ou externe interdite n’y a été observée. Les deux contrôles du manifeste sont distincts de cet audit réseau.

La coupure comprend la destruction effective des connexions du serveur de test, en plus du mode hors ligne du contexte navigateur. Le quota épuisé et le stockage refusé sont des fautes injectées ; le disque du Mac n’a pas été rempli pour les provoquer. La restauration vérifiée concerne un texte exporté dans un profil séparé dont le programme a été préparé avant la coupure.

## Commandes reproductibles

```bash
npm run test:offline
npm run typecheck
npm run build
npm run test:offline:browser
```

Le navigateur Playwright doit être disponible dans le cache déclaré par `PLAYWRIGHT_BROWSERS_PATH`. La configuration dédiée emploie uniquement des origines de test en boucle locale, un port de preview strict, des profils neufs et aucune réutilisation de serveur existant. Elle n’utilise pas le profil personnel du navigateur.

Le lint des quatre fichiers TypeScript modifiés et `git diff --check` font également partie des contrôles. Les journaux conservent les commandes, sorties et résultats exacts. Les dépendances proviennent d’une copie isolée du snapshot dont le verrou est identique ; aucun paquet applicatif n’a été ajouté.

## Portée de l’analyse GitNexus

L’analyse et les requêtes d’impact ont été exécutées dans un registre privé au candidat. Les impacts initiaux des points d’entrée Web étaient UNKNOWN avec zéro appelant résolu : cela n’a pas été interprété comme une absence d’impact. Les références de route et d’enregistrement du worker ont été vérifiées directement.
L’extraction des processus du CLI GitNexus 1.6.12 borne les points d’entrée à 200 et peut omettre des parcours. Les options publiques du CLI ne permettent pas de lever ce plafond ; il n’a pas été modifié. L’indexation finale et `detect-changes --scope all` doivent être lus avec cette limite, même si leur exécution se termine sans erreur. Les nouveaux fichiers sont explicitement indexés par Git avant ce contrôle afin de figurer dans le diff. Les preuves correspondantes restent dans `../evidence/`. La revue directe du périmètre et les tests ciblés complètent cette analyse ; ils ne la rendent pas exhaustive. Ce lot reste un candidat local sans promotion automatique.

## Limites explicites

- Les textes appartiennent au profil du navigateur, pas au compte PURAMA ; une autre personne utilisant le même profil peut y accéder. L’interface le signale. Ce lot ne remplace pas le chantier ONE ID/VAJRA d’isolation des comptes.
- La génération IA n’est pas disponible dans cet espace. Aucun modèle local, archive Wikipédia, carte, moteur de routage ou pack vocal n’a été installé par ce lot.
- Les capacités Bluetooth, Wi-Fi pair à pair, partage volontaire 4G/5G et satellite ne sont pas implémentées ou qualifiées par ces tests.
- Aucun test sur iPhone, iPad, Android physique, Safari, installation mobile signée, veille native, batterie ou température n’a été réalisé.
- L’effacement du stockage du navigateur reste une perte possible ; un export indépendant est nécessaire à la sauvegarde du texte.
- Le lien ajouté aux réglages a passé typage, lint et compilation ; le parcours de réglages avec authentification réelle n’a pas été testé.
- Ces tests couvrent ce lot. Les centaines de tests historiques, les paiements, les autres agents et les autres applications n’ont pas été réexécutés dans cette passe.
- Aucun push, fusion ou déploiement n’a été effectué.

## Remise au chantier d’intégration

Le propriétaire du chantier d’intégration reprend uniquement le commit de ce lot après comparaison avec sa base actuelle. Ne pas fusionner implicitement toutes les branches parentes de la base locale. Examiner en particulier `package.json`, `DashboardSettings.tsx`, le service worker et l’emplacement des tests. Rejouer les contrôles pertinents sur l’assemblage obtenu : les résultats de ce candidat ne qualifient pas automatiquement une autre base.

Les étapes suivantes restent rattachées aux modules existants : isolation ONE ID/VAJRA, modèle génératif et recherche locale IAO/AKASHA, gestionnaire de packs dans App DNA Registry, cartes et routage, puis transports et relais autorisés. La Page canonique contient leurs critères d’acceptation et les compléments de restauration, horloge, effacement dérivé et import.


## Extension : sauvegarde complète de la bibliothèque de textes

Cette seconde passe du 10 novembre 2026 repart de `347f162e03a84cb873e181ed5c6476bc978978ab`, dans la branche isolée `audit/iao-offline-library-restore-20261110`. Le premier correctif hors connexion est déjà repris par contenu dans cette base : onze de ses douze fichiers sont identiques ; les quatre scripts offline et le contrôle de compilation sont conservés dans le douzième, `package.json`. Il ne s’agit pas d’une nouvelle copie du produit. Le checkout donneur est resté en lecture seule ; aucune source active d’un autre chantier n’a été modifiée.

Les résultats de la première passe ci-dessus restent historiques. Les preuves de cette extension sont dans `../evidence/library-restore-20261110/`, notamment les reçus JSON des gates, les journaux et le rapport navigateur final.

### Comportement livré

Le bouton « Télécharger la sauvegarde » lit toutes les lignes enregistrées dans une transaction readonly cohérente, indépendamment du filtre de recherche. Il crée un fichier JSON versionné avec les identifiants, titres, corps, types, révisions, dates et noms de fichiers sources éventuels. Le sérialiseur projette exclusivement ces champs : aucune permission, clé, opération en attente, donnée de compte ni métadonnée interne de déduplication n’est exportée. Un élément invalide fait refuser la sauvegarde entière ; il n’est jamais omis silencieusement. Le succès affiché signifie que le téléchargement a été lancé, pas que le navigateur a garanti sa conservation sur disque.

La sélection d’un fichier de restauration vérifie entièrement son format avant d’afficher une prévisualisation. « Ajouter ces textes » déclenche l’ajout ; « Annuler » abandonne cette prévisualisation sans écrire. Une sélection invalide annule aussi la prévisualisation précédente. L’éditeur ouvert n’est jamais remplacé par ces opérations. Ses modifications non enregistrées restent exclues de la sauvegarde de la bibliothèque ; le bouton d’export individuel permet de les conserver.

La restauration parcourt les données existantes et décide de tous les ajouts dans une seule transaction readwrite IndexedDB. Le calcul SHA-256 précède l’ouverture de cette transaction. Les ajouts utilisent exclusivement `add`, jamais `put` ou `delete`. Le statut réussi attend `transaction.complete`. Une erreur de quota, une collision inattendue ou un abort annule tous les ajouts de cette tentative. Les textes précédents et le brouillon sont conservés, et une nouvelle tentative reste possible.

### Identité, conflits et répétitions

Un identifiant libre est conservé. Un texte déjà exactement présent est compté comme présent. Un identifiant occupé par une autre version produit une nouvelle copie, avec un identifiant aléatoire libre, un titre suffixé « — restauré » borné à 160 unités UTF-16 et une révision initiale de 1. Les dates d’origine restent conservées. Les identifiants de tous les textes entrants sont réservés avant la création des copies, pour éviter de prendre celui d’un autre élément de l’archive.

Les lignes effectivement ajoutées portent un marqueur interne SHA-256 calculé sur l’enregistrement canonique, avec son identifiant et sans la date d’export. Une édition normale conserve ce marqueur. Réimporter la même version de la même archive dans cette bibliothèque n’en crée donc pas de nouvelles copies, même après édition d’une ligne restaurée. Deux identifiants différents avec un même corps restent deux textes distincts.

Cette garantie est précisément bornée : une ligne préexistante simplement reconnue comme identique est laissée intacte et ne reçoit pas de marqueur. Si elle est éditée puis que son ancienne archive est réimportée, une copie de cette ancienne version est créée. Supprimer une ligne importée puis restaurer explicitement son archive permet aussi de la recréer. Les marqueurs ne sont pas transportés par les sauvegardes ; cette version ne promet pas une conservation de tout l’historique de déduplication à travers plusieurs exports et restaurations intermédiaires. Elle n’effectue aucune synchronisation ni résurrection automatique.

### Format et limites

- Format `purama-offline-texts`, version 1 ; dates ISO UTC canoniques.
- JSON UTF-8 complet limité à 32 Mio, borne comprise ; 2 000 textes maximum par archive.
- Corps limité à 1 Mio UTF-8 ; titre de 1 à 160 unités UTF-16 ; nom de source de 1 024 unités UTF-16 au maximum.
- Champs inconnus, types incohérents, révisions invalides, identifiants dupliqués, dates invalides et versions non reconnues refusés.
- Les dates restent acceptées si l’horloge a reculé : aucun ordre artificiel entre création et modification n’est imposé.
- Les contenus et noms restent du texte littéral. Aucun HTML, script ou ordre inclus dans une archive n’est exécuté.
- Fichier lisible sans chiffrement, explicitement indiqué dans l’interface. La bibliothèque est liée au profil du navigateur, pas à un compte IAO.

Le premier garde d’export utilise le même sérialiseur pour mesurer chaque ligne et l’en-tête, avec une date d’export figée. Il ne compte pas les marqueurs internes dans la limite du fichier final. Les empreintes sont calculées séquentiellement, les lectures sont bornées avant concaténation finale, et une archive dépassant la limite n’est pas émise partiellement.

### Préparation hors connexion

Le cache passe à `purama-offline-v5`. Les trois ressources obligatoires sont `offline.html`, `offline-workspace.js` et `offline-library-backup.js`. Le workspace devient un script ES module ; sa dépendance est servie par le même worker. Taille, MIME et SHA-256 des trois ressources sont vérifiés. La préparation ne peut être annoncée réussie si le module de sauvegarde manque. Le garde de version et les tests de non-régression incluent cette nouvelle dépendance.

Une course d’activation a été reproduite pendant la recette : un worker pouvait déjà être présent dans `registration.active` tout en restant dans l’état `activating`. Le code attend désormais son événement `activated`, avec le même délai borné de 12 secondes, puis contrôle explicitement l’actif avant la préparation. Cinq tests déterministes extraient et exécutent le vrai helper ; le test du cas `active/activating` échouait avant correction.

### Vérifications de cette extension

PASS — 65 tests Node (25 du format et du plan de restauration, 20 du service worker, 15 du garde de publication et 5 de l’activation) et 23 scénarios Chromium (20 parcours du workspace et 3 contrôles PWA), sans échec, ignoré ni retry. Compilation avec manifeste v5, typage de l’application et lint des tests modifiés passent. Le premier typage avait dépassé 240 secondes sans diagnostic ; sa reprise séquentielle a terminé avec succès en 104,68 secondes sur les mêmes sources TypeScript. Le premier navigateur avait révélé la course d’activation ; le passage final réussit sur le correctif, après son RED/GREEN déterministe. Les empreintes des douze fichiers de code et de test sont restées identiques pendant tous les gates finaux. Les 20 audits réseau de l’espace local ne relèvent aucune requête applicative ou externe interdite. Les résultats détaillés figurent dans `final-gates.json`, `static-gates.json`, `browser-final-report.json` et `browser-observations.json` du dossier de preuves.

Le RED initial vérifie, dans Chromium réel, que le nouveau bouton n’existait pas avant l’implémentation. La recette navigateur couvre une archive réellement téléchargée, un profil neuf préparé avant coupure des connexions du serveur, des modifications ouvertes, des conflits, des répétitions, douze archives invalides, l’annulation, le quota au deuxième ajout et un abort après les succès des deux requêtes add. La frontière de taille est exercée avec 32 textes synthétiques et un fichier contractuel de 32 Mio moins 128 octets. Ces données de test ne proviennent pas de la bibliothèque personnelle de l’utilisateur.

### Dépendances et limites de livraison

Les dépendances déjà présentes chez le donneur ont été reprises uniquement dans les chemins modifiés par son verrou, avec conservation locale des versions précédentes. Dix-sept entrées nouvelles ou modifiées sont vérifiées, six chemins retirés ne sont plus présents, et un lien d’exécutable devenu orphelin a été mis à l’écart. Aucune installation réseau n’a été lancée. Le SHA-256 du verrou de cette base est `7d6aa7a9cc26f6cdb8738d06eff6de1c3bcd77031ccd1ae5789ef3ba0d511d63`.

Ce lot n’intègre pas le moteur génératif natif. Au relevé, Ollama répond et des poids existent, mais le socket Compute Fabric refuse la connexion. Les sources du gateway présentes restent en RPC/1 tandis que le client du chantier T3 exige le contrat v2. Le garde matériel exige l’état RUN : ses seuils disque par défaut sont 40 Gio durs et 60 Gio souples, ce qui ne permet pas une génération admise à l’espace disponible observé. Aucun accès direct à Ollama n’a été utilisé pour contourner le pont, aucun seuil n’a été abaissé, et aucun service de ce chantier réservé n’a été démarré.

La restauration du compte, des annotations, de la mémoire et de ses index reste distincte. La génération IA hors réseau intégrée, Wikipédia, cartes/routage, voix, Bluetooth, relais volontaires, partage 4G/5G et satellite ne sont pas qualifiés par ce lot. L’installation sur téléphone physique, Safari, batterie, veille et température ne sont pas testées. Aucun push, fusion ou déploiement n’est inclus.


## Reprise du 12 novembre 2026 — lecture française locale

**Statut global : PARTIEL.** Extension du candidat existant, depuis `2a69954ec357819c5b936858db4344f1e94dd225`, sur la même branche `audit/iao-offline-library-restore-20261110`. La bibliothèque de textes, ses identifiants, ses sauvegardes et son format restent ceux déjà présents. Aucun second produit, moteur génératif, connecteur distant ou paquet applicatif n'est ajouté.

### Comportement ajouté

La section « Écouter mon texte » lit, après un clic explicite, le corps courant de l'éditeur, y compris les modifications non enregistrées. Elle sélectionne uniquement une voix française dont le navigateur expose `localService === true`. Une voix distante, une voix implicite par défaut, une API absente ou une liste non vérifiable ne permet pas de lancer la lecture. Une liste fournie plus tard par `voiceschanged` est prise en compte. La règle correspond au sens documenté de `localService` dans la [spécification Web Speech](https://webaudio.github.io/web-speech-api/).

Les énoncés sont bornés à 240 unités UTF-16 ; un seul est transmis à la fois. Les graphèmes sont préservés avec `Intl.Segmenter` lorsqu'il existe ; le repli préserve les paires de substitution et CRLF. Aucun espace ni caractère du texte n'est supprimé lors de l'assemblage des passages. Une séquence Unicode indivisible plus longue que la borne entraîne un arrêt explicite. La limite de 1 Mio est vérifiée uniquement au clic, sans encoder le document à chaque frappe.

La lecture s'arrête à la demande, lors d'une édition, lors du chargement d'un autre contenu et sur `pagehide`. Les identités de lecture et d'énoncé invalident les callbacks retardés. Une erreur synchrone, une erreur vocale ou l'absence de confirmation de fin pendant 45 secondes interrompt la progression ; le contenu de l'éditeur reste intact. « Lecture terminée » n'est annoncé qu'après la confirmation de fin de chaque passage.

La revue indépendante a identifié puis fait corriger un cas supplémentaire : si `cancel()` lève, un événement de changement des voix ne doit pas effacer l'incertitude de l'arrêt. L'état `stopUnconfirmed` maintient l'avertissement, bloque toute nouvelle lecture, conserve l'ancien objet de synthèse et laisse « Réessayer l'arrêt » disponible. Une nouvelle tentative réussie conduit à `stopped`, puis une nouvelle lecture exige un clic explicite. Les tests couvrent le remplacement de la voix, la disparition de l'API et l'échec de la lecture de la liste de voix.

La CSP `connect-src 'none'` est conservée. Aucun appel de facturation, compteur distant, génération IA, transcription, synchronisation ou fournisseur vocal n'est introduit. Le cache passe à **`purama-offline-v6`**, avec les tailles et SHA-256 recalculés par le garde existant. Les trois ressources obligatoires restent `offline.html`, `offline-workspace.js` et `offline-library-backup.js`.

### Vérifications de cette reprise

- **PASS** — 65 tests Node du cache, du format de sauvegarde, de la restauration et de l'activation ; exécution du processus sous interdiction de tout réseau.
- **PASS** — syntaxe JavaScript, lint des scénarios navigateur, compilation avec contrôle du manifeste et `git diff --check`, également sans réseau.
- **PASS** — 38/38 scénarios Chromium, dont 15 scénarios vocaux, sans échec, aucun ignoré et aucun retry. Les empreintes des sources contrôlées sont restées identiques pendant la recette. La suite finale a terminé en environ 2,5 minutes.
- **PASS documentaire** — les fichiers générés dans `dist` correspondent exactement aux quatre ressources publiques testées avant le lancement du navigateur.
- **PASS** — 35 audits réseau de l’espace local relus : aucune requête interdite relevée. Ce contrôle porte sur ces parcours, pas sur le trafic de tout le Mac. Les captures à 390 px et sur ordinateur ont été revues ; aucun débordement horizontal ni chevauchement constaté.
- **PARTIEL** — GitNexus exécuté avant les modifications et index rafraîchi sans réseau, en mode incrémental. Les impacts de l'éditeur sont MEDIUM, celui du cache LOW. L'index signale des limites de couverture de ses flux ; aucune absence de flux n'est interprétée comme une preuve de sûreté exhaustive. Une revue directe indépendante complète l'analyse.
- **NON TESTÉ** — écoute physique, Safari, iPhone/iPad/Android physiques, arrière-plan mobile, batterie et température. Les scénarios vocaux utilisent un double explicite de Web Speech. Un inventaire Chromium headless séparé a retourné zéro voix ; les captures de deux autres parcours ont ensuite affiché une voix « Thomas » déclarée locale. Ces observations ne qualifient pas la lecture audio : aucun son réel n'a été joué.

La première exécution navigateur sur la base inchangée a donné 22/23 : le scénario du texte dépassant 1 Mio à 390 px a dépassé son délai de 45 secondes. Sa reprise isolée a réussi en 26,7 secondes, sans changement de source ni de délai. Cette observation reste conservée ; elle ne constitue pas une mesure de performance garantie.

Preuves fraîches, toutes dans `../evidence/` :

- `offline-recheck-20261112.log` et `offline-browser-recheck-20261112-receipt.json` : état initial ;
- `offline-mobile-boundary-recheck-20261112.json` : reprise isolée de la frontière de taille ;
- `offline-voice-static-gates-20261112.json` et les journaux associés : commandes, dossier, sorties et durées ;
- `offline-voice-tested-source-sha256-20261112.json` : identité des sources qualifiées ;
- `offline-voice-browser-final-receipt-20261112.json` et `offline-voice-browser-final-20261112.json` : résultat final du navigateur, à lire plutôt qu'un résultat historique ;
- `offline-real-voice-inventory-20261112.json` : inventaire réel des voix, distinct du double de test ;
- `offline-voice-network-audits-20261112.json` et `offline-voice-visual-review-20261112.json` : contrôles réseau et revue des captures ;
- `offline-voice-cache-impact-20261112.json` et `offline-voice-index-20261112.log` : analyse d'impact et limites de l'index.

### État du moteur IAO natif, vérifié séparément

Au relevé du 12 novembre à 04:52 UTC / 05:52 Paris, le socket Compute Fabric existe mais refuse la connexion (`ConnectionRefusedError`, errno 61). Le disque de données dispose de 3,928 Gio libres. Le gouverneur existant retient 40 Gio au seuil dur et 60 Gio au seuil souple : ses protections n'ont pas été abaissées.

Les cinq modèles déclarés par Ollama sont retrouvés et tous leurs fichiers référencés sont présents avec les tailles attendues. Cette vérification de métadonnées n'est ni une vérification complète des empreintes des poids ni une inférence. `~/.ollama/server.json` contient `disable_ollama_cloud: true` ; le réglage du fichier ne prouve pas à lui seul l'état du processus vivant. La [documentation Ollama](https://docs.ollama.com/faq) distingue cette configuration et son application au redémarrage.

Le gateway observé reste en protocole RPC/1 alors que le client T3 exige le contrat v2 avec corrélation, idempotence, plafonds et absence de repli payant. Les trois correctifs T02 déjà préparés dans `T02-OSS-ENGINE-20261025/patch-20261102` doivent être réutilisés : ils ne sont pas appliqués à la source inspectée et ne réalisent pas à eux seuls le contrat v2. Le reçu `T1-T3-LIMITED-ROLE-TRANSFER-20261111-01a1cc25` reste `ROLE_TRANSFER_ACCEPTED_EXECUTION_HOLD`, `executionAllowed: false`, avec un périmètre de quatre fichiers ; il ne libère pas les sources du moteur ou des fournisseurs.

Cette reprise n'a modifié ni ces sources, ni leur attribution, ni leurs services. Elle n'a effectué aucune génération directe vers Ollama en contournant le pont ou le gouverneur. Les preuves sont `native-readiness-20261112.json`, `model-files-readonly-20261112.json` et `ollama-offline-config-readonly-20261112.json`.

### Ordre de qualification restant

1. Rendre l'espace disque compatible avec les protections existantes par le chantier de stockage déjà chargé de la conservation des données.
2. Réconcilier les correctifs T02 et le pont existant avec le responsable natif ; implémenter le véritable contrat v2, sans fabriquer de reçus ni supprimer les gardes.
3. Vérifier le chemin IAO → KARTA/KRIYA → moteur local → résultat et mémoire SMARANA/AKASHA, après démarrage à froid et sans accès externe.
4. Raccorder la dictée, la recherche dans les données locales et les packs préchargés aux modules déjà prévus. La lecture vocale de cette passe est une capacité distincte de la transcription et du dialogue génératif.
5. Qualifier chaque appareil : un téléphone dépendant du Mac sur le réseau local n'est pas encore un téléphone autonome sans connexion.

Aucune fusion, publication GitHub, mise en production ni installation sur téléphone n'est incluse dans ce lot. L'inférence IAO entièrement intégrée, les archives Wikipédia, les cartes/routage et les fonctions natives supplémentaires restent à qualifier sur leur propre chemin réel.

## 12 novembre 2026 — Intégrité Unicode et restauration concurrente

Reprise du candidat existant depuis `b63f15f29cd716c6981ce2e0a0a012db51c9b779`. Deux défauts ont été reproduits avant modification, avec des données synthétiques puis dans le vrai navigateur et son stockage IndexedDB.

### Défauts corrigés

La troncature brute pouvait conserver une moitié d’emoji dans un titre importé, une copie de conflit ou un nom téléchargé. `truncateText`, partagé avec la restauration dans le module existant, conserve les limites UTF-16 du format et revient à une frontière de graphème lorsque `Intl.Segmenter` est disponible. Le repli conserve les paires de substitution et CRLF. Les accents combinés, familles emoji et drapeaux sont exercés. Le corps du texte et le nom de source original sont conservés. La [spécification ECMA-402](https://tc39.es/ecma402/#sec-%intlsegmentsprototype%.containing) définit les indices de segmentation en unités de code ; aucune normalisation du contenu utilisateur n’est introduite.

Un second défaut concernait une suppression suivie d’une restauration : une archive pouvait recréer le même identifiant et le même numéro de révision avec une autre version, puis un onglet ancien pouvait écraser ou supprimer ce texte. La comparaison du numéro seul a été remplacée par une comparaison du snapshot complet, qui réutilise `coreEquals` et inclut `restoreKey`. Le contrôle final reste dans la transaction de sauvegarde ou de suppression ; l’actualisation de la liste utilise la même règle. Le cas où seul le marqueur de restauration change provoque également un conflit, préservant la déduplication future. Les modifications ouvertes restent dans l’éditeur ; un rechargement explicite adopte la nouvelle version.

Le format portable reste en version 1 ; aucune migration de données, dépendance ou ressource supplémentaire n’est ajoutée au candidat source. Le cache passe à `purama-offline-v7`, avec génération et contrôle des tailles et empreintes par le script existant. Une première génération a correctement refusé une mise à jour trop large du marqueur de version ; le bloc généré a été restauré exactement depuis HEAD, puis le générateur intact a produit v7.

### Vérification de ce correctif

- **RED confirmé** : les dix nouveaux scénarios Chromium échouaient sur les sources produit inchangées, pour les troncatures et conflits attendus. Le nouveau cas unitaire des graphèmes restaurés échouait également ; le repli sur les paires passait déjà.
- **PASS** : 67 tests Node du socle, syntaxe des deux modules, lint ciblé, compilation, manifeste et contrôle du diff, sous interdiction réseau du processus pour les gates statiques.
- **PASS** : 48/48 scénarios Chromium, dont les dix régressions nouvelles et les quinze scénarios vocaux ; aucun ignoré, aucun échec, aucun retry. Passage final terminé à 05:57:50 UTC / 06:57:50 Paris. Les sept empreintes produit/tests contrôlées sont restées identiques pendant cette exécution.
- **PASS** : 45 audits réseau du workspace, aucune requête interdite relevée sur ces parcours.
- **PASS revue indépendante** : comparaison transactionnelle, conservation du marqueur, limites Unicode et tests relus. Une erreur de pluriel dans le nouveau test de résultat de restauration a été corrigée pour correspondre au libellé existant « 0 ajoutés » ; les assertions sur les données exactes et les comptes sont conservées. Le premier passage interrompu reste disponible.
- **PARTIEL** : GitNexus complète la revue, avec impacts LOW/MEDIUM et des événements dynamiques non résolus. Les limites de couverture de l’index sont conservées, sans transformer un résultat UNKNOWN en preuve de sûreté.
- **BLOQUÉ / NON TESTÉ** : le moteur natif, l’audio physique et les appareils physiques ne sont pas qualifiés par ce correctif. Le relevé natif frais confirme le refus de connexion et les sources du pont inchangées ; aucune prise de contrôle de ce chantier n’a eu lieu.

Preuves dans `../evidence/` : `offline-integrity-red-receipt-20261112.json`, `offline-integrity-red-browser-20261112.json`, `offline-integrity-implementation-20261112.json`, `offline-integrity-final-gates-20261112.json`, `offline-integrity-test-label-correction-20261112.json`, `offline-integrity-browser-qualified-receipt-20261112.json`, `offline-integrity-browser-qualified-20261112.json`, `offline-integrity-tested-source-final-sha256-20261112.json` et `offline-integrity-network-audits-20261112.json`. Le résultat final navigateur est le rapport **qualified**, pas le premier rapport **final** interrompu.

La composition de livraison vers la PR45 est préparée dans une branche isolée issue de sa tête observée `5ca6add91f1c94ce0e0baf42a1934521270ebd47`. Elle doit conserver les protections de notification déjà présentes dans la consolidation, le manifeste public, les tests de distribution et les autres gates. Ce constat ne vaut pas encore publication ni qualification de cette nouvelle composition.

## 12 novembre 2026 — Composition de livraison vers la PR45

Cette section décrit la qualification locale de **cette branche de livraison**, distincte des recettes historiques du candidat source ci-dessus. La branche `audit/iao-offline-integrity-20261112-7f4d` part de la tête de consolidation `5ca6add91f1c94ce0e0baf42a1934521270ebd47`. Elle reprend le candidat qualifié `461e734056ea32a887bc40d3d5cfaf053f84afe9` pour une PR draft ciblant `audit/unlazy-consolidation-20261111-ac3c`.

### Composition et protections préservées

L’espace de textes existant, sa sauvegarde/restauration portable, sa lecture française déclarée locale et les deux correctifs d’intégrité sont repris ensemble. Le tableau de bord ajoute un accès « Textes hors connexion ». Aucun paquet applicatif, modèle ou connecteur supplémentaire n’est ajouté ; le fichier de verrouillage des dépendances reste inchangé.

Le worker est composé avec celui de la consolidation. Les helpers de validation des notifications, les handlers `push` et `notificationclick`, ainsi que leurs assertions de sécurité restent strictement identiques à la base. Une notification ouvre l’écran authentifié de revue ; elle n’exécute aucune approbation directement. Les navigations privées réussies ne sont pas mises en cache, les HTTP 404/500 restent des erreurs et un secours indisponible répond 503 avec `Cache-Control: no-store`.

Le cache partagé passe à **`purama-offline-v8`**. Ses quatre ressources sont `offline.html`, `offline-workspace.js`, `offline-library-backup.js` et le manifeste public `manifest.json`. Chaque taille et SHA-256 est contrôlé avant la mise en cache. La préparation utilise GET, `credentials: 'omit'`, `cache: 'no-store'` et `redirect: 'error'`. Le nettoyage vise les anciens noms canoniques de cache PURAMA, tout en conservant les caches de documents et ceux dont le nom ne correspond pas. Les gardes de version du générateur sont conservés.

### Recette locale de la composition

| Contrôle | Résultat |
| --- | --- |
| Tests Node du module hors connexion | **PASS — 69/69**, aucun ignoré |
| Tests Node du worker de distribution | **PASS — 25/25**, aucun ignoré |
| Manifeste, syntaxe JavaScript, lint ciblé, TypeScript application et distribution, compilation et diff | **PASS** |
| Navigateur de l’espace hors connexion et page compilée | **PASS — 46/46**, aucun échec, ignoré, retry ou flaky |
| Distribution et PWA, projet desktop | **PASS — 15/15**, aucun échec, ignoré, retry ou flaky |
| Audits réseau des parcours hors connexion | **PASS — 46**, aucune requête interdite relevée |
| Revue visuelle des captures ordinateur et 390 px | **PASS** pour les états examinés |
| Revues croisées indépendantes worker/sécurité et navigateur/CI | **PASS statique**, aucun défaut bloquant relevé |

Les gates Node, de typage et de compilation ont été exécutés sous interdiction réseau du processus. Les parcours navigateur utilisent des profils de test isolés, des fixtures loopback, un routage contrôlé et des restrictions de résolution DNS. Ce contrôle porte sur les parcours observés, pas sur le trafic de tout le Mac.

La page réellement compilée fournit les deux modules JavaScript attendus, avec leurs bons types MIME, sans redirection ni remplacement HTML. Les essais d’un POST synthétique et d’un script inline produisent chacun un événement CSP en mode `enforce`. Le parcours PWA part de l’application réelle, attend son worker actif, coupe le réseau et exige une réponse de secours provenant de ce worker. Les empreintes des dix-huit fichiers sont restées identiques pendant les recettes ; seule cette documentation est complétée après celles-ci.

La recette locale utilise **Playwright 1.64.1 avec Google Chrome 157.0.8103.52 installé**, sans téléchargement de navigateur. La suite distribution utilise une configuration locale ignorée par Git qui sélectionne seulement `desktop` et ce binaire. Les dépendances locales sont réutilisées avec des caches privés ; certains outils empruntés, dont Vitest 3.2.7, diffèrent du verrouillage cible. Aucun test Vitest n’est compté dans cette recette. Le passage `npm ci` et les moteurs officiels du projet sont à qualifier par la CI sur le commit de livraison.

Preuves locales dans le dossier adjacent `../evidence/` : `offline-pr45-local-gates-20261112.json`, `offline-pr45-browser-receipts-20261112.json`, les deux rapports `offline-pr45-browser-*-20261112.json`, `offline-pr45-browser-local-environment-20261112.json`, `offline-pr45-tested-files-before-20261112.json`, `offline-pr45-network-csp-audits-20261112.json`, `offline-pr45-network-summary-20261112.json` et `offline-pr45-visual-review-20261112.json`. Ces reçus locaux ne sont pas des artefacts GitHub ; le workflow archive séparément ses preuves.

### Vérification continue et portée

Le workflow CHEF conserve ses contrôles existants et ajoute `test:offline`, puis `test:offline:browser` après la compilation. Le navigateur passe par l’image Playwright déjà épinglée, exécutée avec Docker `--network=none`. Les preuves sous `test-results/offline` et `test-results/offline-report.json` sont archivées systématiquement pendant quatorze jours. Cette section rapporte des résultats locaux ; les résultats CI sont attachés à la PR et à sa tête exacte.

GitNexus a été exécuté avant composition. L’impact du harnais de distribution est MEDIUM, celui du composant de réglages est LOW ; les événements de worker, les configurations et certains appels dynamiques restent UNKNOWN. Les lectures directes et les tests complètent ces limites de couverture. L’index est rafraîchi et `detect_changes` contrôlé avant le commit ; aucune absence de flux ne vaut preuve de sûreté exhaustive.

### Limites natives maintenues

Au relevé natif séparé du **12 novembre à 06:10:14 UTC / 07:10:14 Paris**, le volume de données a **2,739 Gio libres** et le socket Compute Fabric refuse toujours la connexion, errno 61. Les empreintes du gateway, du gouverneur et du client T3 restent identiques ; le décalage RPC/1 versus v2 et les seuils disque 40/60 Gio restent inchangés. Aucun reçu de GO ciblé postérieur au HOLD du 11 novembre n’a été trouvé dans les deux registres canoniques.

Le reçu original `T02-RECEPTION-20261103.json` confirme la réception des **trois** patches T02 avec 21 PASS / 0 échec de livraison ; son type est `delivery_integrity_not_application_qa`. Leur réception est donc acquise, leur intégration et leur qualification applicative restent distinctes. La coordination T1/T3 conserve la responsabilité du pont et du runtime, exclus de cette branche.

**BLOQUÉ** : génération IAO entièrement raccordée au moteur natif. **NON TESTÉ** : son physique, Safari et appareils physiques, autonomie mobile, batterie et température. Les tests vocaux utilisent un double déclaré de Web Speech. La rédaction, la recherche dans les textes et les sauvegardes locales ne constituent pas une génération IA. La publication d’une PR draft ne vaut ni fusion de la consolidation ni déploiement en production.
