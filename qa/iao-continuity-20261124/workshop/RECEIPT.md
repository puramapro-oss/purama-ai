# Reçu — préparation d’une création depuis la conversation

## Résultat et périmètre

**PASS pour les vérifications locales ci-dessous. PARTIEL pour la qualification navigateur : la réception native est conduite séparément par l’agent principal.** Base du travail : `e81129a56e07535129827c95211d82815df8dc5a`.

Un compte connecté peut désormais sélectionner **Préparer dans l’atelier** dans le chat. Le clic prépare localement une demande modifiable à partir de son objectif et de la conversation affichée. Les notices, le message d’accueil synthétique et les réponses provisoires arrêtées sont exclus. Une réponse en cours, le chargement d’une conversation ou une transition d’authentification bloque ce transfert. Aucun appel au modèle n’est ajouté par la préparation.

La demande conserve au maximum 6 000 unités UTF-16, sans couper une paire de substitution Unicode. L’objectif récent est prioritaire. Si du texte doit être omis, la demande contient un avertissement explicite invitant à la relire et à la compléter. La conversation et la saisie non envoyée restent dans le chat ; le transfert ne les efface pas.

L’Atelier reçoit un transfert identifié et lié au compte. Il préremplit une zone vide et propose un choix explicite lorsque la zone contient déjà une demande : **Utiliser cette demande** ou **Garder ma demande actuelle**. Un transfert répété avec la même identité ne remplace pas de nouveau le texte sur l’Atelier déjà monté. Le lancement reste déclenché par **Lancer la création**, avec la demande éventuellement modifiée et l’identité idempotente du lancement existant.

Le formulaire OriginForge conserve la reprise avant connexion. Si un visiteur ne peut pas stocker son idée pour traverser l’authentification, il reste sur le formulaire avec une erreur visible et son texte disponible. Un compte connecté dispose du transfert par état de navigation lorsque le stockage est bloqué.

## Défauts reproduits et corrigés

| Défaut | Preuve avant correction | Résultat local final |
| --- | --- | --- |
| Ancien brouillon prioritaire après échec d’écriture du nouveau | `handoff-red.json` : nouveau texte attendu, ancien texte reçu | PASS : la route fraîche identifiée prime sur la copie stockée |
| Texte de la route Alice exposé après passage à Bob | `handoff-red.json` : zone de texte Bob contenant la demande Alice | PASS : rejet du transfert dont le compte ne correspond pas |
| Deuxième transfert ignoré sur un Atelier déjà monté | `handoff-red.json` : nouvelle demande absente | PASS : réception et choix explicite, sans lancement automatique |
| Ancien slot ressuscité après refus de get/set/remove puis rétablissement | `storage-outage-red.json` : ancienne demande réimportée | PASS : invalidation éphémère, puis nettoyage au rétablissement |
| Même transfert réimporté via une copie impossible à supprimer | `storage-outage-red.json` : copie de la demande reçue à nouveau | PASS : le slot connu obsolète est ignoré jusqu’à son nettoyage |
| État de navigation primitif provoquant une erreur sur l’opérateur `in` | Revue de l’agent principal | PASS : garde runtime objet/non-tableau ; cas texte, nombre et tableau testés |

La première séquence RED compte **12 tests existants PASS et 3 nouvelles régressions FAIL**. La seconde compte **25 PASS et 2 nouvelles régressions FAIL**. Les rapports bruts sont conservés sans modification.

## Vérifications locales

| Vérification | Statut | Résultat et portée |
| --- | --- | --- |
| Quatre suites Vitest ciblées | PASS | **82/82**, rapport `unit-green.json` |
| Filtre indépendant de récupération du stockage | PASS | **7/7**, 39 cas hors filtre, rapport `unit-filter-green.json` |
| Typage application | PASS | `node node_modules/typescript/bin/tsc --project tsconfig.app.json --noEmit`, code 0 |
| Vérification du diff | PASS | `git diff --check`, code 0 |
| Collecte Playwright conversation → Atelier | PASS | 3 scénarios collectés dans `tests/chat/workshop.spec.ts` |
| Collecte Playwright Atelier existant | PASS | 5 scénarios collectés dans `tests/workshop-state/workshop.spec.ts` |
| Exécution réelle des navigateurs | NON TESTÉ par ce reçu | Réception native séparée ; la collecte ne prouve pas l’exécution |
| Services IA/DB de production et déploiement | NON TESTÉ | Les essais utilisent des transports simulés et des fixtures locales |

Commande des quatre suites :

```sh
node node_modules/vitest/vitest.mjs run src/lib/workshop.test.ts src/pages/Workshop.test.tsx src/components/ChatbotWidget.workshop.test.tsx src/components/ChatbotWidget.consultation.test.tsx --configLoader runner --reporter=json --outputFile=/workspace/scratch/6431e6d17379/iao-continuity-handoff-green.json
```

Commande du filtre de contre-réception :

```sh
node node_modules/vitest/vitest.mjs run src/lib/workshop.test.ts src/pages/Workshop.test.tsx --configLoader runner --maxWorkers=1 --no-file-parallelism -t 'resurrect|could not be removed|migrates a pre-authentication|fresh bound|Alice route|receives a handoff|repeated transfer|already received' --reporter=json --outputFile=/workspace/scratch/6431e6d17379/iao-continuity-handoff-filter-green.json
```

Runtime local : Node `v24.22.3`, Linux. Les preuves navigateur ajoutées capturent dynamiquement le nom/version du navigateur, la plateforme et le viewport ; elles ne présument pas une plateforme Linux.

## Scénarios de réception navigateur préparés

1. Conversation terminée → demande Atelier → retour à la conversation conservée → nouveau transfert sur la même route → choix garder/remplacer → modification → un seul lancement contenant la demande modifiée. Vérification du nombre inchangé d’appels au modèle.
2. Écriture du stockage refusée avec ancien brouillon : nouvelle demande transmise par route, puis changement de compte laissant la zone vide et sans texte privé précédent.
3. Format paysage 844 × 390 : préparation bloquée pendant un flux, arrêt du flux, bouton de préparation/compositeur/envoi entièrement dans le viewport (`ratio: 1`), transfert au clavier excluant le fragment provisoire et la notice d’arrêt.

Le banc Atelier conserve ses cinq scénarios existants et leurs assertions métier. Les captures vont dans `testInfo.outputPath`, afin de ne pas écraser les preuves historiques. Son garde réseau ne transmet que les ressources locales GET/HEAD du port 4198 et le WebSocket Vite local. Les feuilles de police externes sont remplacées par une réponse locale vide. Les mutations simulées doivent être prises par les routes de fixtures ; une mutation non interceptée est bloquée.

## Contre-revue et traçabilité du gel

La contre-revue en lecture seule a confirmé les invariants de compte, la conservation de la saisie, l’absence de lancement implicite, l’absence d’appel modèle supplémentaire et les deux reprises après panne de stockage. Elle a aussi révélé une dépendance d’ordre entre tests : une fixture de panne laissait l’invalidation éphémère active. Cette fixture termine maintenant sa récupération réelle avant de rendre la main ; les assertions existantes restent intactes. Le filtre qui révélait ce défaut passe ensuite 7/7.

Seul `src/lib/workshop.test.ts` a été ajusté après le gel du bundle natif ; aucun fichier produit ni scénario navigateur n’a changé pour cette correction de fixture.

- SHA-256 avant correction de fixture : `92421f02fb53d207ee296abb6d9e54e078ee3a799b1f683274060b229234fe32`.
- SHA-256 après correction de fixture : `006e444f12fd3e2a4c206fec8dcf5a7cd88a2a01c0851644d225d87da910cd31`.

`manifest.json` et `SHA256SUMS` donnent les empreintes des 13 fichiers du lot, du présent reçu et des quatre rapports de test.

## Limites explicites

Le transfert utilise la clé unique `purama.workshop.draft.v1` et sa durée de 20 minutes. Son indicateur d’invalidation ne contient aucun texte privé et vit seulement pendant l’incarnation du module. Si tous les accès persistants sont refusés et que la page est détruite avant nettoyage, une suppression durable du slot ne peut pas être attestée. La durée de validité du brouillon reste appliquée à sa lecture.

La fonctionnalité prépare un texte éditable issu de la conversation courante. Elle n’établit pas une relation durable entre un fil, ses fichiers, une mission et une scène de réalité augmentée. L’exécution réelle d’un projet reste dépendante des projets autorisés, des agents et services disponibles, et des contrôles existants. Ce reçu ne déclare ni une exécution de production, ni une publication, ni une qualification de tous les appareils.
