# Diagnostic de résolution Android — 22 novembre 2026

## Incident observé

Le [job Android 137075535165](https://github.com/puramapro-oss/purama-ai/actions/runs/44979130729/job/137075535165) échoue avant compilation : le résolveur Foojay `0.5.0` ne trouve pas le POM de Gson `2.9.1`. L’artefact `14737032607`, SHA-256 `367fc3c67dffcea1779addfc20dfd32683b157bb165f43717de683b788c7b3bc`, confirme le checkout `7f22a024ff4aa5c3c2cf01b905ba50ea4d997f52` et l’arbre `f4168c9fb0e768fa83aeaecf84b7358f9d135173`.

Le [job antérieur 137037561678](https://github.com/puramapro-oss/purama-ai/actions/runs/44966800234/job/137037561678) a compilé avec succès à 00:43 UTC. Les 17 empreintes du prebuild, le verrou mobile, la commande Gradle, Gradle `8.14.3` et Java `21.0.13` sont identiques. Aucun fichier `mobile/` ni le workflow natif ne change entre `4b618bca` et la base locale `e95e282251a4e0ea19bda69675e31ce2c4af4cae`. Les images de runner diffèrent (`20261116.376` puis `20261116.133`) ; ce constat ne prouve pas leur responsabilité.

Les catalogues officiels [Maven Central — Gson 2.9.1](https://central.sonatype.com/artifact/com.google.code.gson/gson/2.9.1) et [Gradle — Foojay 0.5.0](https://plugins.gradle.org/plugin/org.gradle.toolchains.foojay-resolver-convention/0.5.0) attestent les versions publiées. Le journal ne contient pas les réponses HTTP initiales et aucun cache Gradle n’est restauré par le workflow. **Cause exacte PARTIELLE : problème de résolution observé, transport/cache non départagés ; aucune correction de dépendance justifiée.**

## Modification bornée

- La compilation conserve les trois tâches et son échec ; ajout de `--info --stacktrace` et d’un identifiant d’étape.
- Le diagnostic exige `failure()` et l’échec de cette compilation. Un échec de préparation seul ne l’active pas. Aucun `continue-on-error` n’est ajouté.
- Six chemins Gradle fixes : empreinte, taille, lignes de marqueurs et versions strictement filtrées. Les contenus complets, secrets et environnements ne sont pas copiés ; liens directs ou hors du dossier mobile refusés, lecture limitée à 65 537 octets.
- Trois GET sur les URL POM exactes du journal, sans redirection ni retry. HTTPS, connexion 5 s, requête 15 s, processus 20 s, corps 65 536 octets maximum. Corps et stderr jetés ; seuls code de sortie, statut HTTP et durée numériques sont retenus.
- Le reçu `mobile/qa/watch-native/android-dependency-diagnostics.json` rejoint l’artefact existant conservé avec `always()`. Tous les autres contrôles et artefacts restent identiques ; ni version ni dépôt Maven ne change.

## Vérifications

| Contrôle | Résultat et portée |
| --- | --- |
| YAML chargé, Python embarqué compilé, tous les scripts examinés par `bash -n` | **PASS**, sortie 0 |
| Comparaison structurelle à `e95e282` après retrait des ajouts attendus | **PASS** : toutes les données antérieures du workflow sont identiques |
| Compilation simulée quittant avec 17, même pipeline Bash/tee | **PASS** : code 17 et journal conservés |
| Configuration contenant des valeurs privées simulées | **PASS** : empreintes/repères utiles, aucune valeur privée en sortie |
| Fichiers absent, trop grand et lien hors du dossier mobile | **PASS** : états explicites, aucune lecture extérieure |
| Double curl avec HTTP 200/404/303 puis erreur réseau 7 | **PASS** : trois URL exactes par passe, limites présentes, aucun retry ni fuite du stderr |
| Revue indépendante en lecture seule | **PASS** pour les conditions, bornes, confidentialité et préservation du workflow |
| GitNexus `detect_changes --scope staged` | Exécuté, sortie 0 : fichier YAML modifié sans symbole indexé chevauché ; **couverture UNKNOWN**, pas une preuve fonctionnelle |
| GitNexus `detect_changes --scope compare --base-ref 42d508b46dc7e7cda7efe3c6bfd4396450afedef` — base de PR40, `audit/iao-reconciled-20261110` | **BLOQUÉ**, sortie 1 : objet Git `099a717f719e4ed10194615d367271ecf18d6659` absent ; ce repère ne désigne pas la tête courante de `main` |

Le graphe est une copie isolée officiellement enregistrée avec `gitnexus index --force` pour ce clone ; son commit historique `812830f9bba392f8fcb109a844f083638520a273` et sa date du 21 novembre 23:24 UTC sont conservés. `gitnexus status` le signale toujours **stale**. Aucun rafraîchissement ou résultat sans symbole n’est présenté comme une couverture actuelle du YAML.

**NON TESTÉ :** diagnostic sur un runner GitHub réel et nouvelle compilation native. Les vérifications locales utilisent des doubles inertes, sans requête réseau ni compilation Android. Aucune CI n’a été relancée. La prochaine CI naturelle apportera la preuve distante ; un HTTP 200 ultérieur ne prouvera pas la cause de l’échec antérieur. Aucun merge vers `main` ni déploiement n’est inclus.
