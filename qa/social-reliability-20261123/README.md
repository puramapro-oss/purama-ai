# Fiabilité des publications sociales — qualification locale du 23 novembre 2026

**PASS pour les vérifications locales de comportement : 124 tests réussis sur 124. PARTIEL pour la livraison : les contrôles Deno natifs, les types, le véritable SDK et l’état CI du futur commit restent à établir.** Ce dossier capture les preuves avant publication de la PR. Consulter ensuite la PR pour les résultats CI et la décision d’intégration.

## Périmètre et identité

- Dépôt : `puramapro-oss/purama-ai`.
- Base : `5a01da79e810c8f4a900ebc95ae544006b9333d6`.
- Branche : `fix/social-publish-reliability-20261123`.
- Fichiers produit : `supabase/functions/social-publish-scheduled/handler.ts` et `supabase/functions/_shared/zernio.ts` ; tests correspondants dans `tests/social-publish`.
- La configuration `vercel.json` désactive le déploiement automatique de cette branche. Aucun déploiement n’a été effectué par cette qualification.
- Les travaux du checkout actif ont été préservés ; cette qualification porte sur un checkout isolé et ses empreintes explicites.

La composition a été exécutée le **23 novembre 2026 à 00 h 13, heure de Paris** (journal UTC : 22 novembre, 23 h 13). Les quatre empreintes du code et des tests étaient identiques avant et après l’exécution : [reçu composé](composed-node-exit.json) et [manifest final](source-manifest-final.json).

## Problèmes traités et comportement obtenu

### Équité entre publication et réconciliation

Le consommateur traitait les nouvelles publications avant les vérifications de résultats incertains. La reproduction initiale, avec des réponses inertes de 29 secondes simulées, a traité six nouvelles publications en trois invocations sans effectuer aucune lecture de l’ancienne publication incertaine.

Chaque tour admet désormais au plus une publication et une réconciliation indépendantes, puis attend les deux avec `Promise.allSettled`. Une branche déjà commencée est attendue même si l’autre échoue. Les contrôles conditionnels de statut, propriétaire et identité sont conservés. La réconciliation ne déclenche aucun nouvel envoi.

Les limites restent **50 éléments par file et par invocation**, avec **deux travaux concurrents au maximum dans une invocation**. Les **45 secondes** bornent l’admission de nouveaux tours ; elles ne garantissent pas la fin des opérations déjà admises. Un échec du chargement initial des publications incertaines retourne maintenant `503` avant toute nouvelle publication du tour. Cette différence de comportement possède un test explicite.

### Échéance du transport fournisseur

Le transport réutilise les helpers existants `request-deadline.ts` et `request-body.ts`, sans les modifier. Il applique une échéance absolue aux réponses et à leur lecture bornée, contrôle les passages avant et après parsing et normalisation, et nettoie les réponses tardives. Le nettoyage d’un corps ne doit pas retenir une réponse DELETE déjà confirmée par les statuts prévus. La normalisation des résultats partiels et l’absence de renvoi automatique des écritures incertaines sont conservées.

Le délai fournisseur est de **30 secondes par requête par défaut et au maximum**, avec des délais plus courts possibles par le contrat existant. Les contrôles d’échéance ne préemptent pas une opération CPU synchrone : ils refusent une confirmation tardive lorsque l’exécution rend la main. Ils ne garantissent ni annulation de l’effet distant ni arrêt instantané du fournisseur.

## Registre des preuves

| Vérification | Résultat local | Preuve |
|---|---|---|
| Composition des six fichiers sociaux | **PASS — 124/124**, sortie 0 | [Journal](composed-node.log), [reçu](composed-node-exit.json) |
| Scheduler corrigé, dont six nouveaux scénarios | **PASS — 19/19**, compris dans les 124 | [Journal](scheduler-green-final.log), [reçu](scheduler-green-final-exit.json) |
| Transport corrigé | **PASS — 21/21**, compris dans les 124 | [Reçu](provider-green-node-receipt.json), [vérification transport](provider-provider-verification.json) |
| Ancien scheduler avec les scénarios supplémentaires | Défaut reproduit : 15 réussites, 4 échecs attendus sur 19, sortie 1 | [Journal](scheduler-red-r2.log), [reçu](scheduler-red-r2-exit.json) |
| Ancien transport avec les régressions | Défauts reproduits : 8 réussites, 13 échecs sur 21, sortie 1 | [Reçu](provider-baseline-complete-node-receipt.json) |
| Deux revues indépendantes des auteurs des lots | **PASS** ; même relecteur pour les deux lots | [Revue indépendante](independent-review.json) |
| Deno natif, types, suites SDK réelles et CI | **NON TESTÉ dans cette capture locale** | À vérifier dans la PR |
| Comptes réels, plateformes réelles et production | **NON TESTÉ** ; aucun effet externe réalisé | Qualification distincte nécessaire |

**Les sous-suites ne s’additionnent pas au total de 124.** Les tests locaux ont utilisé Node 24 avec un adaptateur `Deno.test`, de vrais handlers et des fournisseurs inertes. Les accès réseau non injectés sont rejetés par le banc. Cela ne constitue pas une exécution Deno native ou une compilation de types. Les sources des bancs sont conservées en `.mjs.txt` avec les reçus ; les chemins de workspace des commandes sont ceux de cette exécution et ne doivent pas être supposés présents sur une autre machine.

Les nouveaux scénarios du scheduler couvrent le backlog continu dans les deux sens, l’admission des deux branches, l’attente après échéance, la persistance des résultats, l’erreur d’une branche avec une autre déjà engagée, les limites de batch/concurrence et l’échec du chargement initial. Les contrôles de course, d’identité et d’absence de republication existants sont conservés.

## Analyse d’impact et limites du graphe

L’index initial s’est terminé avec une sortie 0 : **28 318 nœuds, 90 554 arêtes, 1 215 clusters et 553 flux** ([reçu](gitnexus-initial-index-exit.json), [journal](gitnexus-initial-index.log)). Les impacts `requestZernioJson` et `publishPost` sont classés **HIGH** ; `readBoundedJson` et `disconnectConnectedAccount` sont **LOW**. Les rapports individuels sont conservés dans ce dossier.

La recherche FTS était désactivée. Les limites du graphe signalent 1 902 candidats d’entrée non retenus, 6 652 appels ignorés par la limite de branchement et 34 parcours interrompus par budget. La sauvegarde du cache de parsing a signalé `ENOSPC` sans empêcher la fin de l’indexation. Le risque `inspectPost` est **UNKNOWN** faute d’appelants résolus ; cette absence d’arêtes ne prouve pas une absence d’utilisation.

Le contrôle préparatoire `detect_changes` des 35 fichiers alors indexés a réussi : 34 symboles, deux flux, risque moyen. La comparaison avec `main` est critique et couvre 1 951 fichiers hérités de toute la consolidation, pas seulement ce lot. Les reçus `gitnexus-precommit-*` conservent ces résultats. Un dernier contrôle est exécuté après ajout de ces preuves et avant publication ; la PR en indique le périmètre final.

Les journaux exportés ont uniquement leurs espaces de fin de ligne et lignes vides finales retirés. Les assertions et résultats sont conservés ; les SHA-256 bruts et exportés figurent dans `log-normalization.json`. Cette normalisation ne touche aucun fichier produit ou test.

## Commandes CI existantes à exécuter

Ces commandes proviennent de `.github/workflows/purama-chef-hardening.yml`. Leur présence dans le workflow ne vaut pas résultat d’exécution sur le futur commit.

### Comportement social avec Deno natif et vérification des types

```bash
deno test --no-config --no-lock --no-prompt --deny-net --deny-run \
  tests/social-publish/client-intent.test.ts \
  tests/social-publish/provider.test.ts \
  tests/social-publish/publish.test.ts \
  tests/social-publish/scheduled.test.ts \
  tests/social-connection/connection.test.ts \
  tests/social-management/handlers.test.ts
```

### Trois suites avec le véritable SDK Supabase

```bash
deno test --no-lock --no-prompt --deny-net --deny-run \
  --allow-env=SUPABASE_URL,SUPABASE_ANON_KEY,SUPABASE_SERVICE_ROLE_KEY,SOCIAL_DB_SCHEMA,SOCIAL_STATE_SECRET,APP_URL,CORS_ALLOWED_ORIGIN,ZERNIO_API_KEY,ZERNIO_BASE_URL,CRON_SECRET \
  --config tests/social-connection/deno.json \
  tests/social-connection/handler-sdk.test.ts \
  tests/social-management/handler-sdk.test.ts \
  tests/social-publish/runtime.test.ts
```

Les noms de variables ci-dessus décrivent les permissions du banc ; ils ne contiennent aucun secret. Aucun identifiant de compte réel n’a été utilisé pour les tests locaux.

## État au moment de la capture

**PASS** : défauts reproduits, correctifs locaux, composition 124/124, empreintes stables et revues indépendantes. **PARTIEL** : réception globale en attente des gates d’intégration. **NON TESTÉ** : Deno natif, types, SDK réel, CI du commit à publier et production. Le statut de publication, d’intégration et de déploiement doit être lu dans la future PR et les systèmes concernés, sans l’inférer de cette preuve locale.
