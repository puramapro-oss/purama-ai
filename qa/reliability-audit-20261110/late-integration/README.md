# Réconciliation du runtime publié en parallèle

## Identité et portée

Le premier commit de la PR40, `54971f5a511be752fa70ed94306cdb322f29ff81`,
a terminé sa CI avec succès : site et KARTA, 1 739 tests KARTA dans 101 fichiers,
18 tests SQL et 11 groupes PostgreSQL natif. Le checkout de fusion de la CI
possède exactement son arbre. Ce résultat est conservé dans
[initial-published-ci.json](initial-published-ci.json) ; il ne qualifie pas
automatiquement une composition ultérieure.

Deux évolutions parallèles ont ensuite été examinées :

- PR39, `2e2f71375986d3a1adb3f8b791a668ca739683f3` : reprise durable des
  approbations, reçus des notifications, disponibilité du runtime et arrêt
  coordonné. Son ancêtre commun avec le premier lot est `ca2f92b`.
- PR36, `42d508b46dc7e7cda7efe3c6bfd4396450afedef` : recontrôle du délai
  monotone de recherche Web après adoption de la promesse. Deux fichiers
  changent depuis `0bfd44c`.

Le seul fichier modifié par les deux lots runtime et fiabilité est
`karta/src/scheduler/cron.ts`. La version PR39 attend les traitements en cours
pendant l'arrêt, valide toutes les expressions avant de créer un timer et
nettoie une construction interrompue. La version PR40 conserve l'instant
programmé, invalide aussi les appels `destroy`, retire les timers du registre
et neutralise les erreurs. La réconciliation doit conserver ces deux ensembles
de propriétés, ainsi que leurs assertions de régression.

Les quarante et un autres fichiers du runtime et les deux fichiers Web ont été
intégrés depuis leurs commits exacts. Le
[manifeste d'entrée](incoming-manifest.json) conserve leurs empreintes. Les
adaptations éventuelles des bancs sont identifiées séparément ; elles ne valent
pas suppression de garanties ni nouvelle fonctionnalité de production.

## Qualification de la composition

La même union de tests, avec des adaptateurs conformes au contrat réel de
node-cron, obtient 14 PASS et 10 FAIL sur le planificateur initial, puis
**24/24 PASS** sur la réconciliation. La comparaison AST conserve les
**65 assertions et 24 scénarios**, dans le même ordre. Le test utilisant le
véritable node-cron est entièrement inchangé. Le typage et la compilation
passent. Les tests voisins comptent 36 PASS, puis 27/27 PASS lors du rejeu
isolé du worker interrompu. Ces ensembles ne s'ajoutent pas à un futur total CI.

Les interruptions initiales et la reprise du typecheck avec heap 512 Mio sont
conservées dans le [reçu du planificateur](scheduler/receipt.json). La
[revue indépendante](independent-review.json) ne relève aucun défaut concret
bloquant. Elle confirme les assertions et la
[préservation des sources entrantes](preservation-final.json) : quarante
fichiers runtime et les deux fichiers Web exacts, un adaptateur de test runtime
identifié séparément. Les autres adaptations concernent le mock statique du
premier lot ; aucune assertion n'a été retirée.

Le [manifeste courant](../source-manifest.json) contient 62 entrées contrôlées :
35 du lot initial, 25 du runtime entrant hors chevauchement et deux du correctif
Web. Deux des 35 entrées initiales changent, le contrôleur cron et son mock
statique. Les entrées OAuth, frontend, commerce, dépendances et workflow sont
inchangées. Le premier [manifeste](initial-source-manifest.json) reste attaché
au commit initial.

GitNexus 1.6.12 a reconstruit l'index puis exécuté les comparaisons préparée et
principale : trois commandes, trois codes zéro, 62 entrées opérationnelles
inchangées et arbre identique sur les deux machines. La première détection de
ce complément porte sur 73 fichiers, 398 symboles et 27 flux, avec un signal
**CRITICAL**. Le [reçu](gitnexus/receipt.json) conserve les empreintes et
[l'analyse](gitnexus/analyze.txt) explicite les limites : grand fichier de preuve
ignoré, résolution entre langages et budgets de parcours incomplets. Le graphe
est complété par la revue des chemins et les tests de composition ; il ne
constitue pas une preuve exhaustive de sûreté.

Les reçus d'impact et la notice finale sont ajoutés après cette indexation,
sans changer les 62 entrées opérationnelles. La détection préparée est encore
exécutée sur l'arbre exact envoyé à GitHub avant le commit. La nouvelle CI doit
qualifier cet assemblage publié ; son résultat est consigné dans la description
de la PR40, sans réussite anticipée dans ce document.

## Déploiement coordonné

Le lot hérite de la migration KARTA `027_approval_continuation_outbox.sql`,
après la chaîne canonique précédente, et de la procédure du
[runtime PR39](../../iao-runtime-20261110/README.md). Les anciens et nouveaux
producteurs d'approbations ne doivent pas coexister pendant la bascule. Les
réservations existantes, les historiques ambigus et les reçus fournisseurs
doivent être rapprochés sans réinitialisation destinée à produire un succès.

La migration Supabase des états OAuth doit toujours précéder les handlers
Google/Gmail. L'identification des bases et volumes de référence, les sauvegardes,
le routage et les fournisseurs restent des conditions de mise en service.
Aucune activation de production n'est effectuée par cette réconciliation.
