# Vérification — API natives du Conseil IAO

Date : 27 novembre 2026, Europe/Paris. Base : `a18e6a0ed78a891827b2fb76ce44b97fb110a854`, branche de consolidation `audit/reliability-oauth-20261110`. Branche de travail : `feat/iao-provider-capabilities-20261127`.

## Résultat

**PASS pour l'intégration locale ciblée. PARTIEL pour la qualification globale. NON TESTÉ en production.**

Le host, le catalogue, les adaptateurs et la base utilisent le même choix de fournisseur et de modèle. La migration est additive ; les formats historiques et les réservations existantes restent conservés. Les détails de fonctionnement et d'activation sont dans [le contrat d'intégration](../iao-connected-providers.md).

## Preuves automatiques

| Contrôle | Résultat observé |
| --- | --- |
| Campagne finale ciblée KARTA, 23 suites | PASS — 770 tests, 15,78 secondes. |
| `ConsultationPanel.test.tsx` | PASS — 29 tests React. |
| TypeScript du frontend et de KARTA | PASS. Une exécution concurrente supplémentaire a été tuée avec le code 137 ; les contrôles achevés et le dernier contrôle KARTA réussissent. |
| Build Vite du frontend, avec contrôle des assets offline | PASS — build en 15,72 secondes. |
| Build KARTA | PASS. |
| Migration 038 | PASS sur PostgreSQL/PGlite : fondation applicative réelle, chaîne KARTA 001 à 037, application de 038 deux fois, conservation des données historiques, ACL, RLS et fonctions financières. |
| Revue indépendante du client et du transport | Deux défauts reproduits puis corrigés : élargissement indu du profil de raisonnement et marqueur Gemini `thought` mal typé. Tests de régression ajoutés. |
| `git diff --check` | PASS. |

La campagne ciblée regroupe :

```text
connectedModelCatalog, modelCatalog, executionProfile, programmaticModelQualification,
connectedProvider, nativeProviderHttp, nativeModelUsage, nativeModelUsageMigration,
modelUsage, programmaticUsage, modelUsageMigration, programmaticUsageMigration,
claudeUsageTransport, claudeProgrammaticTransport, loopModelUsage,
loopProgrammaticReads, programmaticFlowIntegration, modelConsultationStoreSql,
consultationHost, consultationIntegration, consultationTransport,
consultationProfileMatrix, modelConsultation
```

Les noms ci-dessus correspondent aux fichiers `karta/test/<nom>.test.ts`. Le scénario intégré exerce les vrais chargeurs/adaptateurs avec HTTP factice, quatre fournisseurs, huit générations, réservation avant chaque POST et reçus conservés en privé. Il ne prouve pas une inférence réelle chez les fournisseurs.

Après les derniers contrôles des erreurs Gemini et des arguments `null`, les trois suites `connectedProvider`, `nativeProviderHttp` et `consultationHost` ont été rejouées : **83 tests PASS**, puis typecheck/build KARTA PASS. Ces 83 tests sont un sous-ensemble des 770, pas un nombre supplémentaire de tests distincts. Les empreintes des fichiers source et tests accompagnent ce rapport dans `qa/iao-connected-providers-20261127/verification.json`.

## Campagne globale et limites du runner

La campagne globale a exécuté 242 suites / 6 112 tests : **6 076 succès et 36 échecs initiaux**, en 163,33 secondes. Elle a démarré pendant la finalisation du catalogue.

- Un échec concernait la nouvelle exclusion Google `thinking:false` pendant cette finalisation. Il est résolu ; les 105 tests catalogue/profils et la campagne finale de 770 tests passent.
- Les 35 autres échecs concernent trois suites historiques de transport local Unix : `localComputeFabricCancellation`, `localComputeFabricProvider` et `localComputeFabricResponseBoundary`. Le runtime refuse `server.listen` avec `EPERM` avant exécution du parcours produit. Une sonde Node sans import du projet reproduit ce refus sur un chemin de 16 octets dans `/tmp`. Le chemin du checkout n'en est pas la cause. Ces fichiers et les implémentations concernées sont inchangés par ce lot.

Les tests Unix doivent être rejoués dans le runner local/CI autorisant les sockets. Aucun test n'a été désactivé ou modifié pour transformer ce blocage en réussite.

**BLOQUÉ — navigateur :** les 26 scénarios de `tests/chat/consultation.spec.ts` n'ont pas atteint l'application. Le binaire Chromium attendu est absent ; le lanceur système pointe vers un exécutable manquant ; l'installation Playwright locale a été refusée avec HTTP 403 par le point de téléchargement. Aucune capture desktop/mobile n'est présentée comme vérifiée. Les tests React ne remplacent pas cette observation.

## Vérifications réelles des comptes, sans inférence

Les clés déjà configurées ont servi à des requêtes de catalogue en lecture seule. Elles n'ont été affichées, copiées dans le dépôt, remplacées ou facturées par une génération.

| Fournisseur | Observation au moment du contrôle |
| --- | --- |
| Anthropic | HTTP 200 ; catalogue lisible, 15 modèles listés. |
| OpenAI | HTTP 200 ; catalogue lisible, 103 modèles listés. |
| Google | HTTP 200 ; catalogue lisible, 65 modèles listés. La clé existante utilise `GOOGLE_AI_API_KEY`, désormais reconnue par le host. |
| xAI | HTTP 403 sur `/v1/models` et `/v1/language-models`. Le corps d'erreur a été classé localement comme lié à la facturation ou au crédit, sans être journalisé. |

Ces nombres sont des observations ponctuelles, pas un nombre de fonctionnalités qualifiées pour IAO. La réussite de la découverte ne prouve ni un crédit d'inférence disponible ni le fonctionnement de tous les modèles.

La configuration du checkout Mac inspecté est en simulation et ne contient pas de `KARTA_CONSULTATION_POLICY_JSON`. Cela ne constitue pas un audit de toutes les configurations distantes ou de la production. Aucun budget utilisateur, secret, service de production ou migration distante n'a été modifié pendant cette livraison.

## Impacts et suite à terminer

GitNexus a été exécuté avant les modifications des symboles existants. Les reçus ont un impact HIGH : les chemins historiques ont donc été préservés et couverts par les régressions. Les fonctions SQL ne sont pas résolues par le graphe ; la vérification utilise leurs définitions, appelants et migrations réelles. Le graphe final a été rafraîchi : 37 972 nœuds, 114 702 arêtes et 757 flux. Sa recherche plein texte reste indisponible, faute d'extension téléchargeable ; les limites de couverture du graphe sont conservées.

`detect-changes --scope staged` a été exécuté avant commit : 18 fichiers, 37 symboles et un signal **critical** avec 743 flux annoncés. Ce signal est conservé. Le contexte du helper privé `invalid` relie aussi des accès homonymes dans des modules non importateurs et même d'autres langages ; cette analyse ne fournit donc pas, à elle seule, une borne fiable de l'impact réel. Le périmètre est contrôlé par le diff Git exact et les régressions ; la qualification globale reste PARTIEL et aucun déploiement n'est déduit du graphe. La comparaison demandée contre `origin/main` couvre la lignée de consolidation entière : 3 570 fichiers / 6 481 symboles, et non les seuls 18 fichiers de ce lot.

Avant activation de l'environnement cible :

1. Intégrer la branche revue dans la lignée IAO choisie, en conservant les autres travaux ouverts.
2. Appliquer la migration 038 dans cet environnement et vérifier le circuit financier existant.
3. Utiliser une politique de modèles et des provisions valides ; qualifier les snapshots acceptés et les paramètres réellement disponibles.
4. Résoudre le refus du compte xAI si cette route doit être activée. Une nouvelle tentative ne doit pas être remplacée par une autre clé ou une dépense non autorisée.
5. Effectuer les essais d'inférence bornés dans le circuit d'autorisation IAO, puis vérifier le parcours réel desktop/mobile et les tests de sockets dans un runner adapté.

Ce lot ne certifie pas toutes les fonctionnalités de toutes les IA, ni une disponibilité universelle, ni une sécurité absolue. Les fonctionnalités supplémentaires restent à intégrer et à qualifier dans les composants IAO correspondants.
