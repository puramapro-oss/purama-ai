# Réconciliation des planificateurs PR39 / PR40

**PASS local : 24/24 cas de l’union, 63/63 voisins après une reprise ciblée, compilation et typage finaux réussis.** La qualification de la composition finale sur GitHub Actions et la détection des changements sur le nouvel index appartiennent au lot d’assemblage.

PR39 (`2e2f71375986d3a1adb3f8b791a668ca739683f3`) ajoute le drainage attendu par `createRuntime`, la validation préalable et le nettoyage d’une construction partielle. PR40 (`54971f5a511be752fa70ed94306cdb322f29ff81`) conserve le créneau programmé, invalide aussi `destroy()`, retire les timers et neutralise les détails fournisseur. La comparaison exacte des deux sources montre que remplacer entièrement l’une par l’autre perd des garanties.

## Avant et après

Les adaptateurs de tests ont d’abord été alignés sur le contrat réel de node-cron : `TaskContext` fourni au callback de PR39, `validate()` disponible dans le mock statique et attente de la lecture effectivement suspendue avant l’assertion puis l’arrêt. Les assertions ne changent pas.

La même union, avec le cron PR40 initial, donne 14 PASS et 10 FAIL. Le cron réconcilié donne 24 PASS. La comparaison AST conserve 65 assertions et les 24 scénarios dans leur ordre. Le fichier utilisant le vrai node-cron reste entièrement identique. Les cadences et `runScheduledCycle` restent identiques à PR40.

Le contrôleur expose une seule promesse idempotente pour `stop()` et `destroy()`. Il invalide les callbacks immédiatement, suit chacun des travaux chevauchants avant leur exécution, retire le timer même si son arrêt échoue, puis attend tous les travaux et les opérations de nettoyage. Les méthodes natives ne sont pas surchargées. Les erreurs retournées et journalisées restent neutres. Toutes les expressions sont validées avant le premier timer ; une construction partielle invalide chaque contrôleur déjà créé.

## Interruptions conservées

- La première sonde en mémoire a échoué sur une limite de son adaptateur VM : node-cron vérifie `instanceof Function` et refusait le callback d’un autre contexte. Ce résultat ne décrit pas une panne du produit. La sonde corrigée, conservée séparément, a réussi et retiré tous ses timers.
- La première campagne voisine a passé 36 cas dans cinq fichiers, puis le worker de `queueDeliveryIdentity` a reçu SIGKILL. La cause précise n’est pas établie. La reprise isolée du fichier, avec heap 256 Mio, a passé ses 27 cas.
- Le typage initial lancé simultanément a fini 137. La reprise séquentielle avec heap 256 Mio a explicitement atteint cette limite et fini 134. La reprise avec heap 512 Mio a fini 0, sans diagnostic. Aucun source ni assertion n’a été modifié entre ces essais.
- La compilation avec heap 256 Mio a fini 0.

Les fichiers JSON conservent les commandes, paramètres et sorties textuelles réellement retournées par les outils, avec leurs codes de sortie. Ils ne sont pas présentés comme des journaux bruts reconstruits. Les scripts de comparaison et d’analyse AST étaient fournis sur stdin ; pour les rejouer depuis la racine du dépôt, utiliser `node < chemin/du/fichier.js.txt`.

## Impact et portée

Les impacts des trois fonctions principales sont LOW dans l’index Mac, dont le hash de cron correspond à PR40. L’UID exact de la fermeture `stop` retourne CRITICAL : 30 symboles, dix directs et quatre processus, avec trois appels non résolus. Cette alerte a été communiquée avant édition. Plusieurs liens concernent des méthodes homonymes à confiance 0,7 ; la relecture manuelle a donc complété le graphe avec le nouveau parcours `index.main → createRuntime → Stopper`, absent de cet index. Le contrôle final `detect_changes` sur la composition reste un gate parent.

Ce lot a modifié trois fichiers : `cron.ts` et deux adaptateurs de tests. Il n’a modifié aucune assertion, ni `staticAgentSchedulerCron.test.ts`, ni un autre fichier runtime. Aucun commit, staging, déploiement, fournisseur ou service de production n’a été déclenché par cet agent. Les preuves et scripts de ce dossier sont du matériel de qualification.
