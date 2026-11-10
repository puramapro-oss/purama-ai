# IAO — conservation du journal et des choix vocaux

Date : 10 novembre 2026. Branche : `fix/iao-preference-persistence-20261110`.

## État de réception

**PASS : correctifs ciblés, contre-épreuves, types des trois modules modifiés et lint du delta.**

**BLOQUÉ localement : validation globale du frontend et de la suite navigateur complète, interrompue par les limites de ressources de cet environnement.** La CI hébergée de cette révision reste à exécuter. Ce reçu initial ne qualifie pas une mise en production.

Parent conservé : `ca2f92b2887c711d152cbfd7e3615c3264a875a8`, arbre `fe3368ed274a79d56b1dce3496914f9f85ae0e6d`, tête vérifiée de la PR36. Ce parent prolonge `1a49ad646b529c6fb95335105c8a4e5f28468d76` avec le contrôle des rejets de lecture après interruption. Les fichiers du périmètre journal/voix et les deux verrous de dépendances étaient identiques entre la base initialement examinée `90d8f30322e864ccfd186e97cbfe7edf3afec9a9` et ces parents. Les avances ont été effectuées sans conflit ; les modifications amont sont conservées. Les contre-épreuves vocales utilisent la source historique 1a49, identique dans ce périmètre.

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
| Suite bien-être complète | **BLOQUÉ**, processus tué par SIGKILL au marqueur 10/28 ; aucun bilan complet réussi |
| Types et build globaux | **BLOQUÉ**, arrêts SIGKILL ou erreur de mémoire V8 avec allocations bornées ; aucun succès global revendiqué |
| SQL, PostgREST hébergé, authentification et RLS de production | **NON TESTÉ** |
| CI hébergée du nouveau correctif | **NON TESTÉ à la rédaction initiale**, exécution prévue sur la branche de correction pour compléter les contrôles locaux |

Les quatre nouveaux cas du journal ont chacun réussi : trois dans une exécution partiellement interrompue, puis le cas anglais dans une exécution isolée. Ce résultat ne constitue pas une campagne intégrale de quatre ou de vingt-huit tests terminée avec succès. Les 24 anciens cas ne sont pas comptés comme relancés avec succès sur cette révision.

Les essais globaux sont conservés comme interruptions, pas comme erreurs corrigées ou réussites implicites. Les tentatives de types/build ont utilisé des allocations V8 de 512, 768 et 1 024 Mio. Le contrôle ciblé a utilisé 512 Mio. Aucune assertion, aucun timeout de test ni nombre de retries n’a été assoupli pour obtenir un résultat vert.

## Banc vocal et intégration

Le test Node charge le véritable `src/lib/voice.ts`, transpile uniquement pour son exécution dans la VM et injecte le véritable client Supabase. Les expressions Vite de la fonction TTS inutilisée sont adaptées pour ce chargement ; les fonctions de réglage ne sont pas recopiées. Deux clients distincts exécutent les requêtes contre un adaptateur HTTP déterministe en mémoire, avec délais contrôlés et vérification des corps, filtres de compte et en-têtes de résolution des conflits.

Le SDK chargé est **`@supabase/supabase-js 2.91.0`**, contrôlé contre le verrou racine. L’essai initial placé dans KARTA utilisait une autre version ; il a été remplacé par ce banc frontend. Il n’existe pas de second nouveau test KARTA. Aucune dépendance ni aucun verrou n’a été ajouté ou modifié.

Les défauts SQL sont lus depuis la migration, ce qui n’exécute pas SQL. L’essai PGlite a été interrompu avant toute assertion et n’est pas compté comme une preuve PostgreSQL. Les tests définitifs couvrent le contrat SDK/HTTP, les courses, le compte ciblé, les défauts à la création et les trois étapes d’erreur.

`test:voice-settings` est exécuté dans le job `site`, après les tests JWT et avant les contrôles plus lourds. Le job installe les dépendances racine. L’exécution locale utilise Node 24.22.1 et TypeScript 5.8.3 ; le workflow configure Node 22. La compatibilité des API Node a été relue, mais aucun nouveau run hébergé n’est revendiqué.

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

Les commandes `detect_changes` ont été exécutées sur les fichiers préparés puis en comparaison avec `origin/main`. La comparaison globale inclut l’historique consolidé, au-delà de ce petit correctif. La réindexation finale a été interrompue par SIGKILL ; le graphe disponible présente ensuite des identifiants incohérents pour certains nouveaux symboles de test. **Ses compteurs et son classement final ne constituent donc pas une qualification fiable du graphe complet.** Le périmètre du correctif est vérifié séparément par le diff Git, les empreintes ci-dessous et la revue du code. Une réindexation propre reste à effectuer dans un environnement disposant des ressources nécessaires.

## Accès public et remise en ligne

Contrôle HTTP du **10 novembre 2026 à 21:53 UTC**, depuis cet environnement :

- `https://purama.dev/` : réponse 404, en-tête `x-vercel-error: DEPLOYMENT_NOT_FOUND` et même message dans le corps.
- `https://auth.purama.dev/` : réponse 502 `Bad Gateway` via la passerelle d’accès. Cela constate un échec d’accès depuis ici, sans diagnostiquer l’état interne du serveur d’authentification.
- MacDevBridge et MacDevBridge Stable : appels en lecture seule en erreur interne MCP `-32603`. Un autre connecteur déjà présent, Remote Desktop Commander, a ensuite répondu sur `mac.home` ; son terminal confirme Darwin 25.6.0 arm64. L’accès au serveur de production reste distinct de cette preuve d’accès au Mac.

La réception de production, la connexion réelle et les fournisseurs externes restent à vérifier après rétablissement de l’accès d’administration. La branche désactive son déploiement Git automatique dans `vercel.json`. Les contrôles globaux et une réindexation fiable doivent précéder toute fusion de release.

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
