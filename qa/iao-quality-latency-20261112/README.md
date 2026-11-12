# IAO : qualité du contexte, délais et travail évité

Qualification du 12 novembre 2026. Cette tranche prolonge la consolidation PR45
de `puramapro-oss/purama-ai`. Base initiale `8259b84e65ca89b01bd1b1fc46576cb60bb8a1ec`,
réconciliée sur `cbd60006552f27771ef0f8b67623087c296fcf67` après l'intégration IME de PR56.
Les cinq fichiers de cette avance sont conservés ; son delta KARTA est vide.

## Problèmes reproduits et corrections

### Contexte complet avant décision

Les agents juridique, comptable et partenaires ignoraient les erreurs renvoyées
par Supabase. Une configuration illisible pouvait être traitée comme inactive,
et une lecture métier échouée comme une liste vide. Les promesses rejetées
pouvaient également transmettre un diagnostic privé du transport.

Les trois `buildContext` vérifient maintenant toutes leurs lectures et produisent
un diagnostic fixe en cas d'échec. Le cycle réel échoue avant le modèle, les
outils et les approbations. La configuration réellement absente/inactive garde
son sens antérieur. Les champs, filtres utilisateur, plafonds et l'ordre des
résultats sont préservés.

Après configuration valide, juridique et comptabilité lancent leurs deux
lectures indépendantes en parallèle et attendent les deux résultats. Aucune
nouvelle requête, aucun cache de décisions ni nouveau service n'est ajouté.
Les délais des lectures Supabase elles-mêmes ne sont pas modifiés par ce lot.

### Délai complet du modèle et reprises explicites

Le SDK Anthropic installé est `0.65.0`. Un transport HTTP 408/409/429/500 inerté
a reproduit trois requêtes pour un appel applicatif. Son délai par défaut est
de 600 000 ms et son timer de fetch s'arrête à la réception des en-têtes.

Le client réutilise maintenant `runtime/lifecycle.ts:bounded`, inchangé, pour
couvrir aussi le décodage JSON ou le corps d'une erreur. La borne monotone
refuse les réponses tardives, même si le transport ignore l'annulation ou si
le callback du timer est retardé. Le SDK reçoit le signal et `maxRetries: 0`.
`KARTA_MODEL_TIMEOUT_MS` vaut 60 000 par défaut et est validé, lors de la
construction du client réel, comme entier entre 1 000 et 120 000.

Le signal facultatif de l'appelant n'entre jamais dans le prompt. Les erreurs
fournisseur et raisons privées d'annulation sont remplacées par un message
fixe. Le logger SDK est désactivé explicitement afin qu'un environnement
`ANTHROPIC_LOG=debug` ne publie pas les prompts ; les traces minimisées de KARTA
restent en place. Les contrôles existants de complétude et de schéma des outils
sont conservés.

Le worker actuel fournit une clé d'exécution durable : un délai modèle dépassé
est alors non rejouable automatiquement. Les appels directs à `runAgentCycle`
sans cette clé gardent leur contrat antérieur. Le worker ne fournit actuellement
pas de signal dynamique au modèle : ce lot ne revendique pas l'annulation
immédiate d'une inférence lors d'un changement du kill switch. L'arrêt du calcul
ou de la facturation chez un fournisseur externe n'est pas prouvé par un abort
côté client.

### Routage conservateur pour les décisions sensibles

La longueur d'un prompt ne mesure pas la qualité nécessaire. Le modèle principal
configuré est désormais conservé pour les outils sensibles, les agents
personnalisés et les catégories `legal`, `compta`, `facture-pro`,
`rapports-financiers`, `chasseur-de-paiements`, même pour un contexte court.
L'heuristique rapide préexistante reste disponible hors de ces catégories.

Cette protection peut augmenter le coût des cas qui utilisaient le modèle rapide.
Elle n'est ni une comparaison de qualité entre modèles ni une économie mesurée.
Les noms de modèles configurés et le plafond de sortie de 1 024 tokens restent
identiques. Aucune baisse de qualité n'est présentée comme démontrée équivalente.

## Preuves et recette

Les nouveaux tests exercent les fonctions et le cycle KARTA réels. Les tests
transport utilisent le SDK réel, avec `fetch` et les frontières externes inertés.
Aucun appel payant ni envoi de message n'est nécessaire à cette qualification.

- Contexte : 21 échecs reproduits avant correction ; 33 cas de contrat après correction.
- Transport : cinq cas rouges avant correction ; 20 cas couvrant erreurs, annulation,
  corps bloqué, remise tardive, concurrence, confidentialité et cycle durable.
- Routage : sept échecs de politique reproduits avant correction ; neuf cas après correction.
- Les groupes ciblés se recouvrent avec la suite complète : leurs nombres ne s'additionnent pas.

Les résultats finaux, commandes, empreintes et limites figurent dans
`verification.json`. Les commandes principales, depuis `karta`, sont :

```bash
NODE_OPTIONS=--max-old-space-size=384 npm test -- --maxWorkers=1 --no-file-parallelism --reporter=dot
node --max-old-space-size=512 node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node --max-old-space-size=512 node_modules/typescript/bin/tsc -p tsconfig.build.json
```

## Mesure contrôlée, distincte de la production

`context-benchmark.json` compare les sources exactes avant/après avec 25 ms
artificiellement ajoutées à chaque lecture, deux échauffements et 20 mesures par
variante. Les deux variantes sont alternées. Aucun réseau ni modèle n'est appelé.

| Construction du contexte | Médiane avant | Médiane après |
|---|---:|---:|
| Juridique | 77,32 ms | 50,64 ms |
| Comptable | 78,26 ms | 54,07 ms |

La diminution médiane observée est de 34,5 % et 30,9 % sur ce montage contrôlé.
Le p95 comptable est bruité et presque inchangé. Ces résultats ne prouvent aucun
gain de latence d'inférence, de latence globale ou de débit en production.

Pour refaire la mesure depuis la racine du dépôt, après installation des
dépendances KARTA, vers un fichier distinct :

```bash
node qa/iao-quality-latency-20261112/context-benchmark.mjs /tmp/iao-context-benchmark.json
```

## Continuité, analyse d'impact et limites

Les impacts GitNexus ont été exécutés avant les changements : LOW pour la
factory et `selectModel`, UNKNOWN pour la méthode `decide` et les trois méthodes
appelées dynamiquement. L'appel réel `runAgentCycle → definition.buildContext`
est également couvert par les tests. `bounded` a une portée CRITICAL dans le
graphe et son code est intégralement conservé.

La reconstruction de l'index neuf a échoué. L'index conservé du commit
`3714510a824010f4b705c0e5171e062735f5f22b` présente exactement le même sous-arbre
`karta/src` que les deux bases de ce lot. La recherche FTS est indisponible et
les appels dynamiques restent partiellement résolus : ce graphe ne constitue
pas une preuve exhaustive. La détection de changements finale est conservée
avec ces réserves.

La branche de travail possède une exclusion Vercel dédiée et conserve les
21 règles préexistantes de la base réconciliée. Les autres équipes, le checkout
Mac et la production ne sont pas modifiés par cette tranche.

## Suite des optimisations à qualifier

Les recherches primaires sont référencées dans `sources.json`. Les prochaines
mesures doivent comparer des tâches PURAMA représentatives : réussite réelle,
exactitude, appels d'outils corrects, coût total par tâche réussie, temps du
premier token, latence complète p50/p95 et mémoire sous charge.

1. Réutilisation exacte des préfixes, avec séparation des utilisateurs et
   invalidation contrôlée. Les caches de préfixe accélèrent le préremplissage,
   pas nécessairement la génération des nouveaux tokens.
2. Déduplication des lectures simultanées identiques seulement lorsque leur
   identité, leurs droits et leurs règles d'annulation sont établis. Les actions
   exécutables et variations créatives ne sont pas des résultats réutilisables
   par défaut. La déduplication durable existante reste la référence.
3. Qualification du moteur local déjà installé avant toute nouvelle installation,
   puis batching et concurrence selon mémoire disponible. Aucun gain de qualité
   n'est garanti par une quantification plus forte ou une fenêtre de contexte réduite.
4. Décodage spéculatif uniquement si le modèle et le moteur le supportent, avec
   vérification standard et mesure d'acceptation. Les variantes approximatives
   exigent une évaluation de qualité distincte.

Ces pistes ne sont pas annoncées installées. Les fournisseurs réels, la cible
Hostinger, l'intégration Mac de la version courante et la supériorité face aux
autres IA restent NON TESTÉS dans cette tranche.
