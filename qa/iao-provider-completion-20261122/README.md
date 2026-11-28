# IAO — confirmations fournisseurs et fin d’action bornée

Date : 22 novembre 2026. Base inspectée : `4c81084e18b34c6bda60f615853887ca51f0e45e`, branche de consolidation `audit/reliability-oauth-20261110` (PR #40). Branche du correctif : `fix/iao-provider-completion-20261122`.

## Problème et périmètre

Les POST Gmail de création de brouillon et d’envoi, ainsi que la création de demande DocuSeal, pouvaient attendre indéfiniment le transport ou le corps de réponse. Ils conservaient ainsi une place dans le worker ou une approbation en cours. DocuSeal lisait également `created.id` sur une réponse qui est un tableau de signataires : la réponse officielle pouvait devenir `{ submissionId: "undefined" }` et être annoncée comme un succès.

La contre-revue a identifié une autre incohérence : un reçu portant un identifiant et un indicateur explicite d’échec pouvait être transformé en un résultat ne contenant plus que l’identifiant. La validation du moteur ne voyait alors plus l’échec du fournisseur.

Ce lot modifie les adaptateurs existants. Les règles d’autonomie, les approbations durables, les files, les migrations et le moteur de missions CHEF restent les autorités existantes. Aucun second orchestrateur ni dépendance produit supplémentaire n’est introduit. Une entrée `false` est ajoutée dans `vercel.json` pour désactiver le déploiement automatique de la seule branche de revue `fix/iao-provider-completion-20261122` ; les autres valeurs sont comparées à la base et conservées.

## Comportement obtenu

### Délai partagé et consommation bornée

`provider-http.ts` fournit une échéance monotone, un signal d’annulation et une attente bornée, y compris pour un transport qui ignore `AbortSignal`. Les contrôles ont lieu avant le lancement et après chaque attente. Une réponse reçue après expiration est nettoyée sans réactiver la suite de l’action.

Les actions Gmail ont un budget total de **40 secondes**, couvrant lecture ou renouvellement OAuth, vérification du profil et persistance conditionnelle, parent du message, réservation de quota, POST et lecture de sa réponse. Le chemin autonome de `getGmailAccessToken(userId)` conserve son budget antérieur de **20 secondes**. Une deadline empruntée est fermée par son propriétaire ; les étapes internes ne la réinitialisent pas et ne la ferment pas.

DocuSeal a un budget total de **20 secondes** pour le POST et sa réponse. Les reçus d’écriture sont limités à **64 Kio** ; le parent Gmail conserve son plafond de **2 Mio**. Ces valeurs sont des plafonds de ressources, pas des mesures de latence habituelle. Les octets reçus font foi, indépendamment de `Content-Length`. UTF-8 et JSON doivent être valides ; les flux de fragments vides ou pathologiquement fragmentés sont bornés. Les redirections sont refusées, les nettoyages ne sont pas attendus et les erreurs ne recopient pas les corps fournisseurs.

### Reçus métier

Gmail exige un identifiant de forme valide et applique `assertToolResult` au reçu brut. DocuSeal exige un tableau non vide, des objets avec un `submission_id` entier positif sûr, un identifiant commun à tous les éléments et la présence de l’email demandé. L’ID du signataire n’est jamais utilisé comme ID de soumission. Chaque élément passe également par `assertToolResult` : `ok: false`, `success: false` et les erreurs explicites ne peuvent pas être masqués.

La réservation Gmail exige un entier sûr entre 1 et 400. Une fraction ou `NaN` ne vaut plus autorisation. Le quota déjà réservé est conservé après une issue incertaine.

### Signification exacte du résultat

Un reçu Gmail valide confirme l’acceptation de l’opération par l’API ; il ne prouve pas la lecture du message par le destinataire. Un reçu DocuSeal valide confirme la création d’une demande ; il ne prouve pas la signature du document.

Après un POST expiré ou un reçu invalide, le message indique une action **non confirmée** et demande une vérification avant reprise. L’expiration ne prouve pas l’absence d’effet externe. Aucun deuxième POST ni remboursement optimiste de quota n’est effectué par ces adaptateurs. Les protections existantes du moteur et des approbations empêchent le rejeu de la même exécution incertaine.

## Critères et preuves

| Critère | Preuve |
|---|---|
| Aucun POST après retour tardif du token, du parent ou du quota | `gmailActionDeadline.test.ts` |
| Une seule échéance, y compris refresh OAuth et persistance conditionnelle | `gmailTokenRefresh.test.ts` : parcours à 32 s et expiration cumulée à 40 s |
| Transport ignorant l’annulation, corps suspendu, cleanup suspendu | `providerHttp.test.ts`, `docusealTool.test.ts` |
| Contrôle monotone même avant l’exécution du timer | `gmailActionDeadline.test.ts`, `providerHttp.test.ts` |
| Aucun succès avec ID invalide ou signal d’échec contradictoire | `gmailActionDeadline.test.ts`, `docusealTool.test.ts` |
| Taille, encodage, redirection et confidentialité des erreurs | `providerHttp.test.ts`, `docusealTool.test.ts` |
| Arrêt de l’étape suivante et `retryable: false` | `providerCompletion.test.ts`, vraie boucle avec fournisseurs simulés |
| Refus de réapprobation avant et après reçu tardif | `providerCompletion.test.ts`, fonctions PostgreSQL existantes exécutées dans PGlite |
| Succès possible avec un vrai reçu de fixture conforme | Deux témoins positifs dans `providerCompletion.test.ts` |

Les régressions Gmail initiales ont produit **21 échecs et 7 réussites** avant correction (`gmail-baseline-red.log`). La contre-revue a reproduit **6 échecs Gmail supplémentaires** (`gmail-review-red.log`) et **6 échecs DocuSeal** (`docuseal-review-red.log`) sur les indicateurs contradictoires, avant leur correction.

La campagne ciblée des six fichiers fournisseurs a passé **167 tests** (`focused-tests.log`). La campagne d’intégration séparée a passé **8 tests** (`integration-tests.log`). La suite DocuSeal à 45 cas incluse dans les 167 est aussi conservée dans `docuseal-green.log`. Ces nombres se recoupent avec la suite globale : ils ne doivent pas être additionnés au total global.

Après une interruption de l’environnement, les fichiers originaux ont été retrouvés intacts. La campagne finale groupée a passé **175 tests dans 7 fichiers**, avec code de sortie 0 (`final-focused-tests.log`). TypeScript et le build ont ensuite réussi, y compris le fichier d’intégration final (`final-typecheck.log`, `final-build.log`).

La suite KARTA complète a réellement été exécutée : **4 093 réussites et 24 échecs sur 4 117 tests**, dans 183 fichiers ; code de sortie **1** (`final-full-tests.log`, `full-test-exit.json`). Les 24 échecs surviennent sur `server.listen` avec `listen EPERM: operation not permitted` pour les sockets Unix de `localComputeFabricCancellation.test.ts` (14) et `localComputeFabricProvider.test.ts` (10). Les mêmes deux fichiers ont été exécutés séparément sur la base exacte `4c81084e`, avec les mêmes dépendances : **24 échecs identiques et 5 réussites**, code 1 (`baseline-unix-tests.log`, `baseline-unix-exit.json`). Cette comparaison établit que ces refus préexistent au lot ; elle ne qualifie pas le comportement de transport empêché par l’environnement. Aucune exclusion ni permission de test n’a été modifiée.

**Réception du lot : PARTIEL.** Le code et les vérifications ciblées sont prêts à relire. La qualification des sockets Unix nécessite un environnement qui les autorise, notamment la CI existante. La livraison reste une proposition de code, sans activation sur le Mac ni déploiement de production. `verification.json` relie les résultats aux empreintes des fichiers testés ; les 175 tests ciblés sont inclus dans les 4 117, et ne s’y additionnent pas.

### Commandes reproductibles

Depuis `karta/` :

```bash
node --max-old-space-size=256 node_modules/vitest/vitest.mjs run --maxWorkers=1
NODE_OPTIONS=--max-old-space-size=1536 npm run typecheck
NODE_OPTIONS=--max-old-space-size=1536 npm run build
```

Les plafonds mémoire servent au banc local Linux/Node 24.22.3. Les premiers essais avec 256 puis 512 Mio pour TypeScript ont atteint leur plafond mémoire ; ce sont des interruptions d’environnement, pas des résultats de typage. Le lancement à 1536 Mio est utilisé pour la vérification finale. Les scripts et versions verrouillées du produit ne sont pas modifiés.

## Contrôle d’impact et contre-revue

GitNexus 1.6.12 a indexé la base avant les modifications. Les huit résultats sont conservés dans `impact-before.json`. `getGmailAccessToken` a été classé **HIGH** : trois consommateurs directs (collecte, brouillon, envoi) et huit éléments affectés dans la profondeur interrogée. Ce risque a été signalé avant édition, et les contrats existants de refresh, identité, CAS et parent ont été retestés.

Les méthodes `execute` sont classées **UNKNOWN** parce que certains récepteurs dynamiques ne sont pas résolus. Les registres d’agents et les parcours `runAgentCycle` / `resolvePendingAction` ont donc été relus et couverts par les tests d’intégration. La recherche plein texte GitNexus était indisponible faute d’extension FTS ; l’analyse de symboles et de dépendances a fonctionné. Les extractions de processus sont plafonnées : une absence dans le graphe ne prouve pas l’absence d’un chemin.

Une contre-revue indépendante par un autre agent a identifié les reçus contradictoires. Leur correction a été relue après les régressions rouges et vertes. Ce contrôle automatisé ne remplace pas une qualification avec les fournisseurs réels.

L’index final a été reconstruit avec succès : 28 265 nœuds, 88 295 relations et 551 processus, en 106,7 secondes. FTS a été explicitement omis ; le contrôle demandé concerne les symboles et les dépendances. `detect_changes --scope staged` a examiné les dix fichiers de code et de tests avant ajout des preuves : **183 symboles et 2 processus, risque moyen**. Le contrôle final après préparation de la configuration et des preuves rapporte **32 fichiers, 194 symboles et les mêmes 2 processus, risque moyen**, avec code 0 (`gitnexus-final-staged.log`). Son propre journal est ajouté ensuite aux preuves ; il ne modifie aucun symbole produit.

La comparaison avec `main` couvre toute la consolidation héritée : **1 890 fichiers, 19 892 symboles et 530 processus, risque critique**. Ce résultat ne décrit pas le seul correctif ; la PR cible la consolidation `audit/reliability-oauth-20261110` et ne fusionne pas cet ensemble dans `main`. Le graphe ne trouve pas la propriété JSON `deploymentEnabled` : ce point reste **UNKNOWN** dans GitNexus, complété par une comparaison JSON exacte prouvant que seule l’entrée de la branche de revue a été ajoutée.

## Limites de la réception

- Les fournisseurs, le modèle et certains services d’admission sont simulés dans les tests. PGlite exécute les fonctions PostgreSQL avec un backend unique ; cela ne remplace pas les campagnes de concurrence PostgreSQL natif de la CI existante.
- Aucun message, demande de signature, appel modèle payant ou déploiement n’a été envoyé pour ce lot.
- Le signal local borne l’adaptateur ; il n’ajoute pas de signal d’arrêt global au `ToolExecutionContext` et ne peut pas annuler rétroactivement un effet déjà accepté par le fournisseur.
- Les délais ne couvrent pas, par ce lot, tous les autres outils et fournisseurs d’IAO.
- La réussite d’un cycle d’outils ne certifie pas l’achèvement de toute mission utilisateur. L’Atelier/CHEF possède déjà son propre parcours de réalisation, revue et preuves ; ce lot le préserve.
- L’activation sur le Mac et la disponibilité publique ne sont pas qualifiées ici : MacDevBridge a renvoyé une erreur et Desktop Commander a déclaré son quota mensuel épuisé. Ces limites d’accès n’ont pas été contournées.

## Source du contrat externe

[Documentation officielle DocuSeal, création d’une soumission](https://www.docuseal.com/docs/api), consultée le 22 novembre 2026 : `POST /submissions` renvoie un tableau de signataires avec `id` et `submission_id` distincts. Le chemin du connecteur auto-hébergé existant `/api/submissions` est conservé ; sa version déployée n’a pas été interrogée.
