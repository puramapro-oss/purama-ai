# IAO — fiabilité des recherches Apollo et de la synthèse vocale

## Périmètre et continuité

Ce lot corrige des défauts reproduits dans les parcours existants. Il applique les exigences de délais complets, de protection des données et de résultat vérifiable déjà définies dans la stratégie IAO du 12 novembre, dans le périmètre validé le 21 novembre 2026. Il ne crée ni nouvel orchestrateur, ni nouveau fournisseur, ni nouveau mode hors ligne.

Base examinée : `d150c87ff9e3c7530765c4abaf5412c637b74366`, tête de la consolidation `audit/reliability-oauth-20261110`. Branche de travail : `fix/iao-provider-boundaries-20261123`. La PR partenaire 93 a été examinée : ses fichiers ne recouvrent pas les trois fichiers produit corrigés ici.

## Problèmes et comportement corrigé

### Apollo / agent de partenariats

L'ancien outil pouvait attendre indéfiniment le fournisseur, recopier son corps d'erreur dans une exception et retourner plus de contacts que demandé. Il acceptait aussi certaines réponses incohérentes comme une liste vide réussie.

Le correctif réutilise `provider-http.ts`, sans le modifier : budget monotone de 30 secondes pour le transport, le décodage et la validation du résultat ; 1 Mio maximum ; refus des redirections ; une seule tentative ; nettoyage sans attendre un transport qui ignore l'annulation. La validation initiale des paramètres précède ce budget. La sortie est limitée à la quantité demandée et aux trois champs métier autorisés.

Les champs email et organisation absents ou nuls deviennent `null`. `people: []` demeure valide. Une propriété `people` absente/nulle est désormais refusée ; `limit: null` est refusé conformément au schéma entier existant. Les messages d'erreur sont fixes et ne contiennent ni réponse fournisseur ni diagnostic transport.

L'endpoint historique `/api/v1/mixed_people/search` est conservé. La documentation actuelle décrit `/api/v1/mixed_people/api_search`, avec une autre réponse et sans emails. Ce lot ne réalise pas cette migration et n'ajoute aucun enrichissement. La compatibilité avec un compte Apollo réel est **NON TESTÉE**.

### Serveur vocal

L'ancien handler avait des lectures et appels sans borne, une validation uniquement déclarative TypeScript, un paramètre OpenAI `format` incorrect, un repli implicite vers un autre fournisseur et des erreurs privées renvoyées et journalisées.

Le handler réutilise les lecteurs et échéances Edge existants. Un budget de 30 secondes couvre l'authentification, l'entrée, la génération et la lecture complète de l'audio. L'entrée est bornée à 32 Kio d'UTF-8 valide ; le texte à 4 000 unités UTF-16 après suppression des blancs périphériques ; le corps d'authentification à 1 Mio ; l'audio décodé à 8 Mio. Ces valeurs sont des limites produit, pas des garanties universelles des fournisseurs.

Le serveur valide fournisseur, voix et vitesse avant génération. OpenAI reçoit `response_format: "mp3"`. ElevenLabs reçoit un identifiant de voix dans un seul segment, le format `mp3_44100_128` et une vitesse bornée dans `voice_settings`. Une clé absente du fournisseur choisi renvoie 503 ; le texte n'est pas envoyé silencieusement à l'autre fournisseur. Il n'y a aucun retry automatique de génération.

Les réponses audio vides, trop grandes, redirigées ou de type incompatible sont refusées. `audio/mpeg`, `audio/mp3` et `application/octet-stream` sont acceptés. Cela vérifie un contrat de transport, pas la décodabilité complète ni la qualité acoustique d'un MP3 réel.

La revue indépendante a trouvé une fuite supplémentaire dans le SDK Supabase : il journalise les exceptions de son adaptateur HTTP. Une erreur fixe est maintenant produite à cette frontière, sans conserver sa cause. Une régression avec le SDK 2.91.0 réel reproduit l'échec avant correction puis valide sa neutralisation. Le SDK est épinglé à cette version déjà utilisée dans le dépôt.

Les statuts sont 400 pour une entrée invalide, 413 pour l'entrée trop grande, 408 pour une annulation, 504 pour le délai global, 502 pour un résultat fournisseur invalide et 503 pour une configuration absente. Les réponses JSON et audio utilisent `Cache-Control: no-store`.

### Réglages vocaux

Changer de fournisseur sauvegarde en une opération le fournisseur, sa voix par défaut et une vitesse compatible. Le curseur respecte 0,5–2 pour l'interface OpenAI existante et 0,7–1,2 pour ElevenLabs. Le bouton d'essai est désactivé pendant la sauvegarde.

Ce changement empêche de nouvelles combinaisons incohérentes. Il ne migre pas les anciennes préférences déjà enregistrées par le défaut antérieur. Une sélection explicite d'une voix valide ou une nouvelle bascule les corrige ; aucune substitution silencieuse n'est effectuée côté serveur.

## Qualification locale

| Contrôle | Résultat et portée |
| --- | --- |
| Apollo avant correction | 34 tests : 32 échecs attendus, 2 réussites. |
| Apollo après correction | 34/34 réussis. |
| Transport commun et finalisation | 22/22 réussis ; helper non modifié. |
| Serveur vocal avant correction | 74 tests et sous-tests : 57 échecs attendus, 17 réussites. |
| Authentification avec SDK réel, avant neutralisation | 5 tests : 1 fuite reproduite, 4 réussites. |
| Serveur vocal final, SDK inclus | 79/79 tests et sous-tests réussis. |
| Interface vocale | 21/21 tests réussis, dont 8 nouveaux ; 13 tests antérieurs conservés. |
| TypeScript frontend | PASS. |
| TypeScript KARTA complet | PASS, après remplacement du plafond mémoire insuffisant de 512 Mio par 1 024 Mio. |
| ESLint global | PASS : 0 erreur, 22 avertissements déjà présents. |
| Build de production frontend | PASS. |

Les cas de transport utilisent des identifiants synthétiques et des réponses contrôlées, sans appel aux fournisseurs ni dépense de génération. Les tests SDK emploient le vrai `createClient` avec un transport simulé. Les horloges contrôlées vérifient expiration, annulation, réponses tardives et absence de nouveau budget entre les phases. Les durées d'exécution de tests ou de compilation ne sont pas des benchmarks de latence utilisateur.

Une contre-épreuve indépendante Apollo a avancé l'horloge à 30 001 ms pendant la validation métier, avant le callback du timer : refus neutre, un seul fetch, aucun timer restant et aucun succès tardif.

### Commandes principales

```bash
# Depuis karta/
node node_modules/vitest/vitest.mjs run test/apolloTool.test.ts test/providerHttp.test.ts test/providerCompletion.test.ts --maxWorkers 1 --no-file-parallelism
node --max-old-space-size=1024 node_modules/typescript/bin/tsc --noEmit -p tsconfig.json

# Depuis la racine
node --experimental-vm-modules --test --test-concurrency=1 --test-timeout=15000 tests/voice-tts-boundaries.test.mjs
node node_modules/vitest/vitest.mjs run src/components/voice/VoiceMode.accessibility.test.tsx --maxWorkers=1 --no-file-parallelism
npm run typecheck
npm run lint
npm run build
```

Les nouvelles régressions TTS et le contrôle Deno du handler sont intégrés à `.github/workflows/purama-chef-hardening.yml`. Le binaire Deno n'est pas disponible dans l'exécuteur local : le contrôle natif doit être qualifié par la CI, séparément des tests Node. Aucun déploiement ni appel audio réel n'est établi par ces résultats locaux.

## Analyse d'impact et limites

GitNexus a été reconstruit à partir de la base courante après un redémarrage de l'environnement. Les analyses d'impact ont précédé les modifications produit. Pour contenir les ressources, les appels directs ont été examinés à profondeur 1 et complétés par la lecture des références.

- `VoiceSettingsCard` : LOW, appelé par `DashboardSettings` ; `update` est local au composant.
- Helper JSON du handler vocal : LOW ; appel local du handler.
- Apollo `execute` et fichier du handler vocal : UNKNOWN. Les dispatchs d'objets et appels HTTP ne sont pas intégralement résolus par le graphe. Zéro lien résolu ne signifie pas absence d'impact.
- Références manuelles Apollo : `partnerAgent.ts` et export `tools/registry.ts`.
- Référence HTTP vocale : `src/lib/voice.ts`, utilisée par le hook vocal existant.

Les fichiers `impact-*-current.txt` sont les reçus utiles. Les premiers reçus sans suffixe gardent l'échec d'accès à l'index lors du redémarrage. Les contrôles de changements avant commit et la comparaison à `main` sont consignés séparément ; cette comparaison inclut les travaux antérieurs de la branche de consolidation.

Le contrôle global des changements classe le lot **critical** : 27 processus sont reliés aux fonctions `getter`/`cancel` du nouveau fichier de tests Apollo. L'inspection des identifiants confirme leur emplacement dans `karta/test/apolloTool.test.ts` ; aucun de ces résultats n'autorise à conclure que tous les appels dynamiques du produit sont connus. L'avertissement a été communiqué, les fichiers modifiés ont été contrôlés et les scénarios réels des trois composants ont été vérifiés séparément. La comparaison à `main` observe l'ensemble de la consolidation, soit 20 349 symboles et 525 processus ; sa liste de symboles est plafonnée par l'outil, et n'est pas présentée comme un audit exhaustif du portefeuille. La tête distante de `main` vérifiée est `ae84415be0b9516422805910be999a2c1e6350c0`.

Les journaux de tests sont conservés avec uniquement un nettoyage des espaces en fin de ligne et des lignes vides finales pour leur versionnement. `log-formatting.json` conserve les empreintes avant/après ; les résultats et diagnostics ne sont pas modifiés. Les reçus UI indiquent leur transcription à partir des sorties déjà exécutées.

## Suites nécessaires, distinctes de ce correctif

1. Qualifier le handler dans Deno via la CI et les parcours d'authentification dans l'environnement déployé.
2. Vérifier la disponibilité du contrat Apollo historique avec le compte réellement configuré avant de déclarer ce connecteur utilisable en production.
3. Préparer la migration de la synthèse OpenAI avant l'arrêt annoncé de `tts-1` au 6 janvier 2027. Le remplacement recommandé change de workflow API ; changer uniquement le nom du modèle serait incorrect.
4. Tester les voix réelles, la qualité acoustique, les longs textes, les faibles vitesses et les limites 30 s/8 Mio avec un budget d'essai autorisé.
5. Reprendre la qualification des modes locaux et de l'atelier spatial dans leurs composants canoniques existants. Ce lot serveur n'ajoute ni moteur vocal local ni moteur AR.

## Sources officielles consultées le 23 novembre 2026

- [OpenAI : création audio](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create)
- [OpenAI : guide de synthèse vocale](https://developers.openai.com/api/docs/guides/text-to-speech)
- [OpenAI : dépréciations](https://developers.openai.com/api/docs/deprecations)
- [ElevenLabs : création audio](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)
- [Apollo : People API Search](https://docs.apollo.io/reference/people-api-search)
- [Stratégie IAO existante](https://chatgpt.com/space/page_fd645d0a04248191903c489a0830628c)
