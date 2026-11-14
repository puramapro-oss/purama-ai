# IAO — conservation du journal et des choix vocaux

Date : 10 novembre 2026. Branche : `fix/iao-preference-persistence-20261110`.

## État de réception

**PASS : correctifs ciblés, contre-épreuves et CI hébergée complète de la composition finale testée `99ca770…`, arbre `64ff44e…`.** Le run 42918344435 a terminé ses jobs `karta` et `site` avec succès. Il comprend 1 733 tests moteur, 28 tests bien-être, 21 tests de consentement vocal et 11 tests de sauvegarde vocale. Les deux étapes conditionnelles `npm audit` ont été ignorées et ne sont pas comptées comme exécutées. Le lint termine avec zéro erreur et 16 avertissements `react-refresh/only-export-components` ; aucun « zéro avertissement global » n’est revendiqué.

**BLOQUÉ — disponibilité publique :** le frontend canonique et l’authentification répondent en erreur lors des sondes décrites plus bas. La réception des parcours de production est **NON TESTÉE** ; les résultats CI n’attestent pas une remise en ligne.

**Limites conservées :** les essais globaux locaux ont été interrompus par les ressources de l’environnement ; ils restent des interruptions historiques. La première tentative GitNexus Mac limitée à 240 secondes reste un essai incomplet, distinct de la qualification structurelle ultérieure réussie. Les classements de risque et les limites sémantiques et de couverture du graphe sont explicités ci-dessous.

Le correctif initial conservait le parent `ca2f92b2887c711d152cbfd7e3615c3264a875a8`, arbre `fe3368ed274a79d56b1dce3496914f9f85ae0e6d`, tête vérifiée de la PR36 lors de cette première composition. Ce parent prolonge `1a49ad646b529c6fb95335105c8a4e5f28468d76` avec le contrôle des rejets de lecture après interruption. Les fichiers du périmètre journal/voix et les deux verrous de dépendances étaient identiques entre la base initialement examinée `90d8f30322e864ccfd186e97cbfe7edf3afec9a9` et ces parents. Les avances ont été effectuées sans conflit ; les modifications amont sont conservées. Les contre-épreuves vocales utilisent la source historique 1a49, identique dans ce périmètre.

## Réception CI et identité de l’arbre testé

### Composition finale contrôlée

**PASS — [run 42918344435](https://github.com/puramapro-oss/purama-ai/actions/runs/42918344435).** Les journaux des deux jobs confirment le checkout `99ca770b57ea48d1cc98955282ae99b3bd712bed`, arbre `64ff44eda6bcca1161737b91c31f75d29e35e56b`. Ses parents sont `42d508b46dc7e7cda7efe3c6bfd4396450afedef` et `0fb05413f6a54a7149dda0ef4e3ecd032eb26963`.

Ce checkout inclut l’avance de la base survenue avant le démarrage de la CI : `websearch.ts` recontrôle l’annulation et l’échéance après le retour de `Promise.race`. Trois cas supplémentaires contrôlent 29 999 ms accepté, 30 000 et 30 001 ms refusés. Le delta par rapport à l’arbre publié `669fd20…` est limité à ce module et à son test de transport, 32 lignes ajoutées et une retirée. Les neuf fichiers du correctif de persistance restent identiques. **Le checkout CI n’est donc pas présenté comme ayant le même arbre que le head initial `0fb0541…`.**

| Contrôle hébergé final | Résultat |
| --- | --- |
| [Job KARTA 130186477365](https://github.com/puramapro-oss/purama-ai/actions/runs/42918344435/job/130186477365) | **SUCCESS**, 1 733 tests sur 99 fichiers, typage et build réussis |
| [Job site 130186477846](https://github.com/puramapro-oss/purama-ai/actions/runs/42918344435/job/130186477846) | **SUCCESS**, dernière suite terminée le 10 novembre à 23:00:05 UTC |
| Journal et bien-être / consentement vocal / persistance vocale | **28 / 21 / 11 PASS** |
| Public / chat / qualité | **156 / 14 / 78 PASS** |
| État UI / opérations asynchrones / authentification mobile | **12 / 17 / 20 PASS** |
| Types, builds, contrôles Deno et autres étapes prévues | **PASS** |
| Lint | **0 erreur, 16 avertissements Fast Refresh** |
| Deux `npm audit` conditionnels | **SKIPPED**, pas de réussite d’audit revendiquée |

Ces suites ne sont pas additionnées comme des scénarios uniques. Les journaux n’indiquent aucun test TAP ignoré, annulé ou en échec. Le snapshot applicatif de référence est figé sur `99ca770…` ; une actualisation documentaire ultérieure doit conserver ses fichiers applicatifs, tests, dépendances et workflow à l’identique.

### Qualification initiale conservée

La [PR38](https://github.com/puramapro-oss/purama-ai/pull/38) a été contrôlée par le run [42912000240](https://github.com/puramapro-oss/purama-ai/actions/runs/42912000240), terminé avec succès. Les objets Git du commit source et du checkout de fusion utilisé par la CI ont été comparés localement : ils référencent exactement le même arbre.

| Objet qualifié | Identifiant |
| --- | --- |
| Commit source du correctif | `c44254b1b1a1acc4b819abb6899f3a69fb2fc128` |
| Checkout de fusion testé en CI | `0fa8c60aa0939c4026aca11af906527e01ac3df3` |
| Arbre identique pour les deux commits | `affb5c3a095a1ca18993fdbcea15151b95703fd8` |
| Job `karta` | [130164755605 — success](https://github.com/puramapro-oss/purama-ai/actions/runs/42912000240/job/130164755605) |
| Job `site` | [130164756020 — success](https://github.com/puramapro-oss/purama-ai/actions/runs/42912000240/job/130164756020) |

Les résultats comprennent **1 637 tests moteur**, **28 tests bien-être**, **21 tests de consentement vocal** et **11 tests de sauvegarde des réglages vocaux** réussis. Les contrôles de types et de build prévus par les deux jobs sont également passés. Les deux `npm audit` conditionnels sont **skipped**, conformément à leur condition sur les événements de pull request ; aucune réussite d’audit de dépendances n’est revendiquée pour ce run.

Cette actualisation documentaire est postérieure au run. Les résultats ci-dessus qualifient explicitement l’arbre `affb5c3…`, sans attribuer automatiquement cette preuve à un futur commit modifiant du code. La réussite de la CI ne constitue ni un déploiement ni une réception de production.

Depuis ce contrôle, la base PR36 a avancé à `0bfd44cbe9c87e9c58568a10210db15c6f20c89d`. Sa réconciliation avec le correctif a été publiée sur la PR38 au commit **`0fb05413f6a54a7149dda0ef4e3ecd032eb26963`**, avec les parents `c44254b…` et `0bfd44c…`, et l’arbre **`669fd20f7870ca2cdf52c88e94b4a3d46353bd28`**. Cet arbre est exactement celui indexé avant commit dans le worktree détaché Mac, comme détaillé dans la qualification structurelle ci-dessous.

Le run de composition 42918344435 a ensuite qualifié le checkout `99ca770…`, qui inclut aussi l’avance `42d508b…` de la base, comme expliqué ci-dessus. La CI réussie de `c44254b…` reste une preuve historique de son arbre `affb5c3…`.

## Deux défauts corrigés

### Journal enregistré mais refusé à la relecture

L’ancienne écriture vérifiait le nombre de notes et la longueur de chaque note, sans contrôler la longueur du JSON final. Une contre-épreuve de 210 notes valides, avec des caractères échappés, a écrit **2 536 338 caractères** et renvoyé une réussite. Le décodeur refusait ensuite ce même document, au-delà de sa limite de 2 500 000 caractères.

Une constante commune, `MAX_JOURNAL_SERIALIZED_LENGTH`, régit désormais les deux chemins. La mutation retourne `sizeLimit` avant `localStorage.setItem` lorsqu’elle dépasse le plafond. L’interface explique le refus en français et en anglais, conserve le brouillon et laisse le stockage existant exactement intact.

Le cas exactement à la limite, avec 207 notes, reste accepté et intégralement relisible. Le contrôle mesure les unités de chaîne JavaScript comme le lecteur existant ; ce n’est pas une mesure en octets UTF-8. Ce correctif prévient les nouvelles écritures trop grandes. Il ne restaure pas automatiquement un éventuel ancien document déjà refusé par le lecteur ; aucun cas de production n’a été observé.

### Sauvegardes vocales concurrentes

L’ancienne fonction lisait tous les paramètres puis réécrivait cet instantané avec le patch demandé. Une sauvegarde de vitesse retardée pouvait ainsi réactiver la voix désactivée par un autre client, ou annuler sa langue choisie. Le même défaut existait lors d’une création concurrente des premiers réglages.

La fonction envoie maintenant un PATCH limité aux champs demandés, avec le compte imposé et une date de modification. Si la ligne manque, elle initialise les valeurs applicatives et le choix demandé avec `ignoreDuplicates: true`, puis applique le PATCH partiel. Une création concurrente ne remplace donc pas les réglages déjà créés. La lecture automatique conserve le défaut applicatif `false`, malgré le défaut SQL historique `true`. Un premier choix `enabled: false` est déjà présent dès l’insertion.

Les erreurs de chaque écriture sont propagées. L’absence de ligne après l’initialisation déclenche une erreur explicite, sans fausse confirmation de sauvegarde. Les écritures concurrentes portant volontairement sur le même champ conservent l’ordre d’arrivée du stockage ; aucune synchronisation immédiate de tous les appareils ni révocation globalement monotone n’est revendiquée.

## Vérifications exécutées

| Contrôle | Résultat et portée |
| --- | --- |
| Voix : trois courses sur la source historique 1a49 | **3 échecs attendus**, avec le SDK frontend 2.91.0 : réactivation, langue écrasée, réactivation à la création concurrente |
| Voix : module corrigé | **11/11 PASS**, aucun test ignoré ou annulé ; le script final `npm run test:voice-settings` a aussi terminé avec le code 0 |
| Journal : trois contre-tests sur le code initial | **3 échecs attendus**, dont sauvegarde réussie d’un document que son propre lecteur refuse |
| Journal : refus de conservation trop grande | **PASS**, `sizeLimit` et absence d’écriture |
| Journal : frontière exacte | **PASS**, 2 500 000 caractères et 207 notes intégralement relues |
| Journal : ajout trop grand en français | **PASS**, brouillon intact, absence de succès, empreinte SHA-256 du stockage inchangée, rechargement lisible |
| Journal : même parcours en anglais | **PASS**, exécution isolée terminée en 3,8 s |
| Types ciblés | **PASS**, configuration héritée de `tsconfig.app.json`, périmètre des trois modules modifiés et déclaration Vite ; code 0, 1,08 s |
| Lint ciblé | **PASS**, les trois modules et le nouveau test navigateur, zéro avertissement autorisé ; code 0, 1,59 s |
| Revue indépendante | **PASS de revue statique**, logique de sauvegarde, erreurs de fin de création, test Node et intégration CI |
| Suite bien-être complète | **PASS en CI : 28 tests**. Essai local historique **interrompu** par SIGKILL au marqueur 10/28 ; ce processus local n’a pas produit de bilan réussi |
| Consentement vocal | **PASS en CI : 21 tests** |
| Moteur KARTA | **PASS en CI finale : 1 733 tests**, 99 fichiers ; le premier run en avait exécuté 1 637 |
| Types et build globaux | **PASS en CI** dans les jobs `site` et `karta`. Essais locaux historiques **interrompus** par SIGKILL ou erreur de mémoire V8 avec allocations bornées |
| SQL, PostgREST hébergé, authentification et RLS de production | **NON TESTÉ** |
| CI hébergée du correctif | **PASS**, run 42912000240 sur l’arbre exact `affb5c3…` ; deux étapes conditionnelles `npm audit` ignorées |
| Qualification GitNexus de la composition finale | **PASS structurel**, reconstruction fraîche du checkout `99ca770…`, arbre `64ff44e…`, trois UID de production résolus et deux comparaisons terminées ; qualification initiale `669fd20…` et incident incrémental non qualifié conservés séparément ci-dessous |
| CI hébergée de la composition | **PASS**, run 42918344435, checkout `99ca770…`, arbre `64ff44e…` vérifié dans les deux jobs |

Lors des essais locaux, les quatre nouveaux cas du journal ont chacun réussi : trois dans une exécution partiellement interrompue, puis le cas anglais dans une exécution isolée. Ces essais locaux seuls ne constituaient pas une campagne intégrale terminée avec succès. La campagne hébergée ultérieure a bien terminé ses **28 tests** avec succès, couvrant les quatre nouveaux cas et les 24 cas existants sur l’arbre qualifié ci-dessus.

Les essais globaux sont conservés comme interruptions, pas comme erreurs corrigées ou réussites implicites. Les tentatives de types/build ont utilisé des allocations V8 de 512, 768 et 1 024 Mio. Le contrôle ciblé a utilisé 512 Mio. Aucune assertion, aucun timeout de test ni nombre de retries n’a été assoupli pour obtenir un résultat vert.

## Banc vocal et intégration

Le test Node charge le véritable `src/lib/voice.ts`, transpile uniquement pour son exécution dans la VM et injecte le véritable client Supabase. Les expressions Vite de la fonction TTS inutilisée sont adaptées pour ce chargement ; les fonctions de réglage ne sont pas recopiées. Deux clients distincts exécutent les requêtes contre un adaptateur HTTP déterministe en mémoire, avec délais contrôlés et vérification des corps, filtres de compte et en-têtes de résolution des conflits.

Le SDK chargé est **`@supabase/supabase-js 2.91.0`**, contrôlé contre le verrou racine. L’essai initial placé dans KARTA utilisait une autre version ; il a été remplacé par ce banc frontend. Il n’existe pas de second nouveau test KARTA. Aucune dépendance ni aucun verrou n’a été ajouté ou modifié.

Les défauts SQL sont lus depuis la migration, ce qui n’exécute pas SQL. L’essai PGlite a été interrompu avant toute assertion et n’est pas compté comme une preuve PostgreSQL. Les tests définitifs couvrent le contrat SDK/HTTP, les courses, le compte ciblé, les défauts à la création et les trois étapes d’erreur.

`test:voice-settings` est exécuté dans le job `site`, après les tests JWT et avant les contrôles plus lourds. Le job installe les dépendances racine. L’exécution locale utilise Node 24.22.1 et TypeScript 5.8.3 ; le workflow configure Node 22. Le run hébergé 42912000240 a exécuté les onze tests vocaux avec succès dans ce job.

Commandes de reprise :

```sh
npm run test:voice-settings
npm run test:wellbeing -- journal-size.spec.ts --workers=1 --retries=0
npm run typecheck
npm run build
```

Le banc navigateur requiert le Chromium prévu par Playwright, ou `PLAYWRIGHT_EXECUTABLE_PATH`. Les preuves locales utilisent Chromium 147.0.7727.0, un worker et zéro retry. `VOICE_SETTINGS_TEST_SOURCE` permet uniquement au banc vocal de lire une source historique isolée pour une contre-épreuve ; la commande normale charge le module de production courant.

## Analyse d’impact et limite du graphe

Avant modification, les impacts GitNexus ont été exécutés sur les fonctions réelles : risque **LOW** pour `saveVoiceSettings` (un appelant direct dans `useVoice`) et pour les fonctions de sérialisation et mutation du journal. Le chemin d’interface du journal a aussi été relu directement.

Les commandes `detect_changes` ont été exécutées sur les fichiers préparés puis en comparaison avec `origin/main`. La comparaison globale inclut l’historique consolidé, au-delà de ce petit correctif. La réindexation finale dans l’environnement Linux a été interrompue par SIGKILL ; le graphe disponible présentait ensuite des identifiants incohérents pour certains nouveaux symboles de test. **Ses compteurs et son classement final ne constituent donc pas une qualification fiable du graphe complet.** Cet index a été isolé. Le périmètre du correctif est vérifié séparément par le diff Git, les empreintes ci-dessous, la revue du code et la CI sur l’arbre exact.

Une nouvelle tentative a été effectuée le 10 novembre sur `mac.home`, dans le worktree détaché dédié `iao-persistence-cb46-20261110`, au commit source `c44254b…`. Le runner GitNexus 1.6.12 et son binaire natif étaient déjà installés ; aucune dépendance n’a été installée ou téléchargée. Le registre était isolé, l’index était neuf, et la commande utilisait `--index-only`, un worker, une limite V8 de 2 Gio, un pool Ladybug de 512 Mio et `GITNEXUS_MEMORY=off`. FTS était désactivé pour éviter un téléchargement d’extension. L’unique fichier explicitement écarté pour taille supérieure à 512 Ko était la preuve JSON `qa/ots-stamp-atomicity-20261110/native-final.json`.

Cette invocation, commencée à **22:15:25 UTC**, a été arrêtée par son superviseur à **22:19:25 UTC**, à la borne de **240 secondes**, avec **SIGTERM**. Elle n’avait pas terminé son graphe : `lastCommit` restait vide dans les métadonnées, sans base complète ni alias enregistré. Aucun SIGKILL ni échec mémoire n’a été observé pendant cet essai Mac. Le journal ne permet pas d’établir la cause précise de la lenteur. L’archive contient 82 fichiers de cache de parsing, dont le dernier a été modifié à **22:19:20 UTC** : le parsing produisait donc encore des résultats quelques secondes avant l’arrêt. Ce constat a motivé l’unique nouvel essai borné à dix minutes sur la composition réconciliée, décrit ci-dessous.

Le processus a été confirmé arrêté. Son index incomplet et son verrou, identifiés comme appartenant à cette invocation, ont été archivés dans le dossier de preuves dédié ; aucun index actif incomplet n’a été conservé dans le worktree. Les empreintes du HEAD, du statut, de l’index et des refs du dépôt principal sont restées identiques, avec ses 17 modifications préexistantes préservées. **Aucun `impact` ni `detect_changes` n’a été exécuté sur cet index incomplet.**

### Qualification structurelle réussie de la composition

La fusion automatique de `0bfd44c…` dans le worktree détaché au HEAD `c44254b…` a été préparée sans commit, sans conflit et sans modification non stagée. L’index Git contenait les 13 fichiers amont et produisait l’arbre `669fd20f7870ca2cdf52c88e94b4a3d46353bd28`, identique avant et après l’analyse, puis au commit publié `0fb0541…`. La version documentaire actualisée de ce reçu n’a pas été transférée dans ce snapshot.

L’indexation GitNexus fraîche a commencé à **22:43:11 UTC** et terminé à **22:46:17 UTC**, avec **exit 0 en 186,1 secondes**, sans atteindre sa borne de 600 secondes. Elle a conservé un worker, une limite V8 de 2 Gio, un pool de 512 Mio et un registre isolé sous l’alias `iao-persistence-cb46-composition-0bfd`. Aucun cache incomplet antérieur n’a été réutilisé. Le graphe contient **14 348 nœuds, 38 238 relations et 558 processus**. FTS est resté désactivé.

La preuve porte sur le couple **HEAD `c44254b…` / MERGE_HEAD `0bfd44c…` et sur l’arbre de staging `669fd20…`**, pas sur le seul `lastCommit` des métadonnées. Les 13 chemins modifiés sont enregistrés dans la couverture de l’index. Sept empreintes de fichiers, dont les trois modules modifiés, les deux nouveaux tests, `websearch.ts` et son test de nettoyage, correspondent exactement au contenu indexé.

| Commande `detect_changes` | Fichiers | Symboles | Processus affectés | Risque brut | `partial` | `truncated` |
| --- | ---: | ---: | ---: | --- | --- | --- |
| `scope: staged`, fusion amont | 13 | 133 | 7 | **HIGH** | false | false |
| `scope: compare`, base `0bfd44c…` | 9 | 95 | 184 | **CRITICAL** | false | false |
| `scope: compare`, base `d116dc8…` | 772 | 7 109 | 514 | **CRITICAL** | false | true |

Les trois appels ont terminé sans erreur. La comparaison globale liste 1 000 symboles, tout en conservant son compteur total de 7 109. Les alertes HIGH et CRITICAL ont été transmises avant la publication de la composition. Elles restent dans les preuves ; aucune valeur de risque n’a été abaissée pour obtenir une réception favorable.

L’examen des liens explique la portée excessive du classement du petit correctif. **182 des 184 processus** sont associés à trois callbacks du test `journal-size.spec.ts`, nommés `entries` par l’indexeur ; les deux autres concernent `decodeGratitudeJournal`. Le graphe relie notamment `Object.entries(extra)` de `minimalEnv` et `Object.entries(config)` de `ChartStyle` au callback `Array.from` du test journal. Les **sept processus** du delta stagé sont associés à `cancel` dans `webSearchCleanup.test.ts` ; le graphe relie entre autres `operations.cancel('settings')` de `useVoice` au callback `vi.fn` de ce test. Ces liens sont des faux rapprochements de nom démontrés par le code, pas des dépendances de production vers ces callbacks de test.

Les identifiants et chemins des 133 puis 95 symboles des petits deltas concordent ; aucun désaccord n’a non plus été trouvé parmi les 1 000 symboles affichés de la comparaison globale. Cette limite sémantique du graphe est distincte de l’incohérence de l’ancien index Linux. Les impacts amont ciblés sur les fonctions réelles ont été relancés :

| Fonction | Risque ciblé | Symboles affectés | Appelants directs |
| --- | --- | ---: | ---: |
| `saveVoiceSettings` | **LOW** | 1 | 1 |
| `mutateGratitudeJournal` | **LOW** | 5 | 1 |
| `decodeGratitudeJournal` | **LOW** | 9 | 2 |

La sauvegarde vocale retrouve l’opération de `useVoice`. Le résultat est marqué comme borne inférieure à cause de 14 appels avec receveur non résolu ; la recherche du code retrouve ces 14 appels dans `tests/voice-settings-concurrency.mjs`. Les résultats du journal sont marqués `epistemic: exact` par l’outil et retrouvent les chemins attendus de lecture, persistance, ajout, suppression, conservation et événement de stockage.

La couverture de processus demeure bornée : l’indexeur signale **965 candidats de points d’entrée non retenus, 28 parcours coupés par leur budget et 2 760 appels secondaires omis par la limite de branchement**. Ces limites sont distinctes de `partial` et `truncated` retournés par chaque détecteur. Le PASS structurel atteste l’exécution propre, l’identité du snapshot et l’examen des résultats ; il ne transforme pas le graphe en analyse exhaustive de tous les parcours.

Les preuves sont conservées dans le dossier dédié `iao-persistence-cb46-20261110-evidence/composition-0bfd`, notamment `qualification-summary.json`, les trois `detect-*.json`, les trois `impact-*.json`, les contextes des callbacks de test et `source-coherence.json`. Les empreintes du dépôt principal sont restées identiques et ses 17 modifications préexistantes sont préservées. Aucun changement applicatif supplémentaire n’a été effectué pour contourner les faux liens du graphe.

Après publication, le worktree Mac a été rattaché au commit publié `0fb0541…` en restant détaché : la fusion préparatoire a été quittée puis le HEAD a été déplacé avec `reset --soft`. Le contrôle du **10 novembre à 22:53:41 UTC** confirme un worktree propre, l’absence de `MERGE_HEAD`, le même arbre `669fd20…`, un index Git inchangé et des métadonnées GitNexus inchangées. Le dépôt principal conserve son HEAD, son statut, son index, ses refs et ses 17 modifications. Aucun nouvel index ni nouveau contrôle CI n’a été lancé pendant cette clôture ; les caches et preuves sont conservés. Le résultat est enregistré dans `published-checkout-result.json`.

### Qualification finale du snapshot CI `99ca770…`

Le périmètre final est figé sur **`99ca770b57ea48d1cc98955282ae99b3bd712bed`**, arbre **`64ff44eda6bcca1161737b91c31f75d29e35e56b`**, identique au checkout testé par le run CI 42918344435. Le worktree Mac est resté détaché. Par rapport à `0fb0541…`, seuls le contrôle d’échéance de `websearch.ts` et son test de transport changent ; les neuf fichiers du correctif de persistance restent identiques entre ces deux snapshots.

Une indexation incrémentale intermédiaire a terminé avec le code 0 en 45,7 secondes, mais **son résultat n’est pas qualifié**. Les UID exacts de `saveVoiceSettings`, `mutateGratitudeJournal` et `decodeGratitudeJournal` étaient devenus introuvables, malgré des sources inchangées. Le détecteur attribuait notamment un UID vide à `decodeGratitudeJournal`, puis 485 processus à ce symbole sans identité ; la comparaison des neuf fichiers annonçait 55 symboles et 543 processus. La comparaison main contenait aussi un UID vide pour `briefDrivenContext`. L’identité correcte du HEAD et des empreintes de fichiers ne suffisait donc pas à valider l’intégrité du graphe. Cet essai reste **BLOQUÉ** dans ses preuves. Après fermeture du backend et confirmation de l’arrêt des processus concernés, son index et son cache ont été intégralement archivés hors du worktree dans `composition-99ca/invalid-index`, sans réutilisation.

Une unique reconstruction finale fraîche a ensuite été exécutée, avec un registre neuf et l’alias distinct `iao-persistence-cb46-final-99ca`. Elle a commencé à **23:06:50 UTC** et terminé à **23:09:26 UTC**, avec **exit 0 en 156,153 secondes mesurées par le superviseur**, sous la borne de 300 secondes. Elle conserve un worker, une limite V8 de 2 Gio, un pool de 512 Mio et FTS désactivé ; aucune dépendance n’a été installée ou téléchargée. Le graphe contient 1 051 fichiers, 14 350 nœuds, 38 244 relations et 558 processus.

**PASS structurel :** le HEAD, l’arbre de staging et l’arbre du commit concordent avec `99ca770…` / `64ff44e…`, le worktree est propre, `meta.lastCommit` est exact et `dirtyPaths=[]`. Les sept empreintes ciblées correspondent aux sources et aux métadonnées. Les trois UID de production précédemment absents sont retrouvés avec les bons fichiers et lignes. Les **95 UID** du delta de persistance sont strictement identiques à ceux de l’indexation fraîche initiale de l’arbre `669fd20…`.

| Comparaison finale `detect_changes` | Fichiers | Symboles | Processus affectés | Risque brut | `partial` | `truncated` |
| --- | ---: | ---: | ---: | --- | --- | --- |
| Base `42d508b…`, correctif de persistance | 9 | 95 | 184 | **CRITICAL** | false | false |
| Base `d116dc8…`, main historique | 772 | 7 110 | 514 | **CRITICAL** | false | true |

La comparaison main expose **1 000 symboles** sur les 7 110 comptés. Aucun UID vide ni désaccord entre UID et fichier n’a été trouvé dans les résultats exposés : 95 sur 95 pour le correctif et 1 000 sur 1 000 pour main. Les valeurs brutes restent conservées. Les trois callbacks de test `entries` portent à nouveau 182 des 184 processus ; les deux autres concernent le véritable `decodeGratitudeJournal`. Le contexte final confirme les mêmes faux rapprochements avec les appels `Object.entries(...)` de `minimalEnv` et `ChartStyle`. La reconstruction résout l’incohérence d’identité de l’essai incrémental, sans supprimer cette limite de résolution des noms.

La **couverture reste PARTIELLE**, séparément des drapeaux de chaque détecteur : 965 candidats de points d’entrée écartés, 28 parcours coupés par leur budget, 2 760 appels omis et 822 accès de propriété entre langages non liés. Le PASS structurel ne constitue pas une preuve d’exhaustivité ni une réception de production. Les résultats CI sur le même arbre restent une preuve distincte.

Les preuves finales se trouvent dans `iao-persistence-cb46-20261110-evidence/composition-99ca-fresh`, notamment `qualification-summary.json`, les deux `detect-*.json`, les trois contextes de production, le contexte du callback de test, l’attribution des processus, les avertissements et les empreintes. L’essai incrémental invalide reste documenté dans `composition-99ca` ; les phases précédentes, dont l’arrêt initial à 240 secondes, restent conservées avec leur propre périmètre.

Le contrôle avant/après la reconstruction finale confirme le même HEAD, la même branche, le même statut, le même index et les mêmes références du dépôt principal, avec ses **17 modifications préexistantes préservées**. Une évolution de références observée avant cette phase provenait d’un autre worktree : la reconstitution de ses deux changements depuis les reflogs retrouve exactement l’empreinte antérieure. Ces travaux concurrents ont été laissés intacts. Aucun code applicatif, commit, push ou déploiement supplémentaire n’a été effectué pour cette qualification ; aucun nouvel index n’est requis.

## Audit distinct des dépendances de production

Les deux étapes d’audit ignorées par le workflow ont été complétées par deux lectures du registre npm, le **10 novembre à 23:19 UTC**, sur le snapshot propre `99ca770…`. La commande exécutée dans chacun des deux projets était `npm audit --omit=dev --package-lock-only --ignore-scripts --json --audit-level=low`, avec Node 26.0.0, npm 11.12.1, une borne de 90 secondes et des caches dédiés. Elle n’installe ni ne répare de dépendance. Les empreintes des quatre fichiers `package.json` et `package-lock.json`, ainsi que le dépôt principal, sont restées identiques.

| Périmètre | Résultat de l’audit à cette date |
| --- | --- |
| KARTA | **PASS**, code 0, aucun avis signalé pour les dépendances de production |
| Frontend racine | **PARTIEL**, code 1 : trois paquets concernés par un même avis faible ; aucun avis modéré, élevé ou critique |

La chaîne concernée est `opentimestamps@0.4.9` → `bitcore-lib@8.25.47` → `elliptic@6.6.1`. L’avis officiel [GHSA-848j-6mx2-7j84 / CVE-2025-14505](https://github.com/advisories/GHSA-848j-6mx2-7j84), classé faible, concerne certaines signatures ECDSA incorrectes ; des conditions supplémentaires peuvent permettre une récupération de clé. L’avis consulté ne fournit aucune version corrigée d’`elliptic`. La proposition automatique de npm, `opentimestamps@0.0.0`, est une rétrogradation majeure hors de la plage déclarée, sans preuve de compatibilité : elle n’a pas été appliquée.

Une revue statique ciblée a suivi `src/lib/opentimestamps.ts`, `supabase/functions/_shared/ots-library.ts`, leur client commun `src/lib/ots-core.ts` et les primitives réellement appelées. Les parcours examinés effectuent des hachages, le parsing et la fusion de preuves, la sérialisation et la comparaison d’une racine Merkle. Le registre de désérialisation sélectionne sept classes d’opérations prédéfinies, sans opération de signature ECDSA. Aucun chemin examiné n’atteint `EC.prototype.sign`. `elliptic` reste toutefois chargé par les imports transitifs de `Timestamp` et de `bitcore-lib` : **l’avis faible reste ouvert**. Cette revue n’est ni une observation dynamique ni une qualification du bundle déployé ; elle ne couvre pas les autres usages possibles de cette dépendance ou les services distants.

Cet audit porte sur les dépendances de production identifiées par les verrous et le registre à cette date. Il ne constitue pas une preuve d’absence de toute vulnérabilité, ni un audit des images système ou des secrets. Les reçus, les identités de dépendances et les réponses officielles sont conservés dans `iao-persistence-cb46-20261110-evidence/production-audit-99ca-20261110`.

## Accès public et remise en ligne

Les vérifications du **10 novembre 2026 au soir**, répétées à **23:36:38 UTC** après le nettoyage de l’inspection temporaire, distinguent l’accès d’administration et la disponibilité publique. Les quatre sondes finales ont terminé avec `curl` code 0 et vérification TLS réussie ; leurs réponses HTTP restent en erreur :

- `https://purama-ai.purama.dev/`, domaine canonique indiqué par le frontend : HTTP 402 `DEPLOYMENT_DISABLED`, confirmé depuis le Mac avec vérification TLS.
- `https://purama.dev/` : HTTP 404 `DEPLOYMENT_NOT_FOUND`. Ce domaine ne doit pas être remplacé par IAO sur la seule supposition qu’il désigne la même application.
- `https://auth.purama.dev/` et sa route `/auth/v1/health` : HTTP 502. La résolution DNS conduit encore à OVH ; le routage Traefik de cet hôte pointe vers le Kong Supabase arrêté.
- MacDevBridge et sa variante Stable échouent avec MCP `-32603`, mais l’accès au Mac par Remote Desktop Commander fonctionne. Les connexions SSH autorisées vers OVH et Hostinger ont également réussi. Une reconnexion utilisateur à MacDevBridge n’est donc pas une condition de poursuite.

Les deux conteneurs PostgreSQL génériques sont arrêtés. Deux diagnostics `pg_controldata`, exécutés avec l’image exacte déjà présente, sans réseau et avec les données montées en lecture seule, donnent l’état `shut down`. Le checkpoint OVH date du **17 octobre 2026 à 07:23:14 UTC**, celui de Hostinger du **3 octobre 2026 à 19:54:36 UTC**. Les empreintes de `pg_control` sont identiques avant et après chaque diagnostic et les deux conteneurs temporaires ont été supprimés. Un checkpoint plus récent ne prouve pas à lui seul l’intégrité ni le choix définitif de la base à reprendre.

La copie OVH occupe environ **17,65 Go**. À **22:45 UTC**, Hostinger présente **39,62 Go libres**, sous la réserve de stockage identifiée d’environ **82,98 Go**. Le contrôle de 23:21 UTC mesure ensuite **43,10 Go libres** sur ce même stockage, toujours sous la réserve. Aucune copie physique sur disque n’a été lancée et aucun seuil n’a été abaissé. Le conteneur concurrent de qualification Node 22 observé auparavant ne montait pas ces données PostgreSQL ; il a ensuite disparu indépendamment de cette intervention, qui ne l’a ni arrêté ni supprimé.

La topologie du stockage a été relue à **23:30:17 UTC** : le disque de 400 Gio est presque entièrement partitionné, avec environ 2,02 Mio hors partitions. Le système ext4 occupe sa partition à 3 584 octets près et son compteur de blocs réservés est nul. L’écart entre taille de partition et capacité utilisable correspond aux métadonnées du système de fichiers, pas à un espace libre extensible. À cet instant, les 43,06 Go disponibles laissent un déficit d’environ **39,92 Go avant toute nouvelle copie** pour satisfaire la réserve de 82,98 Go. Aucun achat, montage, redimensionnement ou nettoyage destructif n’a été effectué.

### Inspection temporaire en mémoire — tentative interrompue

La garde de réserve disque concerne la file d’exports chiffrés. Après lecture de son architecture et de son contrôleur de capacité, un espace distinct de laboratoire PostgreSQL 15 a été attribué uniquement en mémoire, sans admission dans cette file ni modification de ses règles. Le lot de sept fichiers a été relu indépendamment et vérifié par SHA-256 avant une unique exécution. Empreinte du contrôleur : `18ed269ea10c0f04134558c8bc97b1d2263d6717ac89be45b332c718d559df82`.

Le laboratoire utilisait l’image PostgreSQL déjà présente, deux conteneurs jetables, aucun réseau de conteneur ni port publié, une racine en lecture seule, aucune capacité Linux supplémentaire et des données source montées en lecture seule. Le conteneur cible était limité à **21 Gio**, avec un `tmpfs` de **20 Gio**, un swap de cgroup interdit et une réserve projetée de **8 Gio** pour l’hôte. Le délai total restait de 1 800 secondes, dont au plus 1 200 secondes pour le transfert. Les données transitaient par un pipe SSH ; aucune archive de base n’était écrite sur le Mac ou sur un disque serveur.

**BLOQUÉ — run `20261110T232523Z-d1c428bdeb2b`, lancé à 23:25:23 UTC et terminé après 514,17 secondes avec le code 1.** Le préflight, l’inventaire, le manifeste SHA-256 initial des **32 395 fichiers** et les contrôles effectifs d’isolation ont réussi. Le swap de cgroup nul a été vérifié avant le premier octet copié. Le transfert partiel a été interrompu à **23:33:43 UTC** après l’échec d’une sonde de surveillance cible : `read_only_probe_failed_target_no_safe_reason`.

Cette erreur signifie qu’un sous-processus SSH de sonde a renvoyé un code non nul, sans objet JSON d’erreur exploitable. Le code précis et le contenu de stderr n’ont pas été conservés par cette voie du contrôleur ; **la cause exacte reste indéterminée**. Le dernier échantillon mémoire disponible, à 23:33:34 UTC, respectait encore la garde avec 182 870 016 octets de marge. Ce reçu ne permet donc pas d’attribuer l’arrêt à une insuffisance de RAM, à une erreur PostgreSQL ou à la corruption des données.

| Étape de cette inspection | Résultat réel |
| --- | --- |
| Préflight, inventaire et manifeste source initial | **PASS** |
| Isolation, limites et swap interdit | **PASS**, valeurs effectives contrôlées |
| Transfert physique complet et égalité des manifestes | **NON ACQUIS**, transfert interrompu |
| Démarrage PostgreSQL de la copie | **NON EXÉCUTÉ** |
| Catalogue, migrations, agrégats SQL et droits de production | **NON TESTÉ** |
| Suppression des deux seuls conteneurs de ce run | **PASS**, absence confirmée sur les deux hôtes |
| Démarrage ou modification des bases d’origine | Aucun démarrage demandé ; empreintes de contrôle et états arrêtés reconfirmés |

Le diagnostic de clôture à **23:35:12 UTC** a de nouveau réussi ses deux connexions SSH. Les deux bases d’origine étaient toujours arrêtées, avec leurs dates d’arrêt, codes de sortie et empreintes de `pg_control` inchangés ; aucun conteneur du run ne subsistait. Les journaux noyau de la fenêtre inspectée ne signalaient aucun échec mémoire. Ces vérifications confirment le nettoyage et l’état observé des sources, pas une validation intégrale du contenu des bases. Aucune nouvelle copie n’a été lancée sans cause reproductible à corriger.

Les reçus privés de préparation, d’exécution, d’arrêt et de diagnostic sont conservés dans `iao-persistence-cb46-20261110-evidence/recovery-preflight/ram-review/run-20261110T232523Z-d1c428bdeb2b`. Le reçu public final est `public-availability-after-ram-20261110.json` dans le dossier de preuves principal. Aucun contenu de ligne utilisateur, secret, archive de base ou valeur de clé n’est inclus dans ce rapport.

### Conditions restantes de reprise

La disponibilité publique reste **BLOQUÉE**. Une reprise durable exige encore un espace de stockage admis par la garde de capacité, une copie complète vérifiée avec lecture SQL, puis la qualification de l’authentification et des droits du compte sur la pile à remettre en service. L’augmentation de capacité ou la suppression de données pour la libérer nécessite une décision explicite sur la ressource ou les chemins concernés ; aucun espace déjà provisionné et immédiatement utilisable n’a été trouvé sur ce disque. Les archives existantes et les autres services restent conservés.

La réception de production, la restauration, la connexion réelle, les droits SQL/RLS et les fournisseurs externes restent distincts des tests de code. Aucun redémarrage de la pile applicative, aucune migration de données et aucune bascule DNS n’ont été effectués par cette intervention. La branche désactive son déploiement Git automatique dans `vercel.json`. Les réussites CI ne démontrent pas que les routes publiques sont disponibles.

La CI historique [42881227306](https://github.com/puramapro-oss/purama-ai/actions/runs/42881227306) a été vérifiée comme réussie sur `90d8f30322e864ccfd186e97cbfe7edf3afec9a9`. Cette preuve porte sur cette base historique, pas sur le présent correctif.

## Empreintes des entrées du correctif

| Fichier | SHA-256 |
| --- | --- |
| `.github/workflows/purama-chef-hardening.yml` | `7d84192351dac9babd403fc0e475cec0581649edc7d2ef4bc89d693e83fe824c` |
| `package.json` | `c5b83c20567c864183426db82eeceb1f99edba38da31343f952fda257c2fa560` |
| `src/lib/gratitude-journal.ts` | `3a2754083b482459843dcfa50213e52951ce2c93b2cc3bb3980771f3183b79a7` |
| `src/lib/voice.ts` | `41416013a9783421dbc3af6bb6389bc160660182596623e4fca0e79d5401bdf8` |
| `src/lib/wellbeing-copy.ts` | `150a0d4801ae410ba4ce1b001a3a802ddaca0695b18ad9a6b8ff45056fa8ff0c` |
| `tests/voice-settings-concurrency.mjs` | `a8cd773a977f4e28c14a5ce122b618c0f83df0bcb30ebaea215b3d0ee1ecc040` |
| `tests/wellbeing/journal-size.spec.ts` | `9e785b8b3097e9756915200a9cbc7ed1ccd91808f7cc1553c9ce0c666c7c4616` |
| `vercel.json` | `032aefe2e71f27509f13e62f484b0c63873407f04b494fa4aac836f01053805b` |
