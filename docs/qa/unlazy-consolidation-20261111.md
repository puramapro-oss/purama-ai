# Consolidation IAO / KARTA — 11 novembre 2026

## Problème corrigé

Les correctifs des PR37 à43 étaient vérifiés séparément, sans candidat commun. La PR40 gardait une ancienne version du délai maximal, ne contenait ni le bornage des paramètres de continuation de la PR41 ni la revalidation avant appel modèle de la PR37. Le journal/voix, la distribution et le mobile avaient aussi des contrôles séparés.

## Composition

Base PR40 `ab6901c` ; intégration des têtes PR43 `0d38a925` (inclut PR39 `124a9e5`), PR41 `88dfee31`, PR37 `9907571`, PR38 `548c41d` et PR42 `70f6c5a`. Les parents complets sont dans le reçu JSON. La composition conserve l’ascendance, les correctifs et les tests existants.

Les deux conflits de configuration ont été résolus par union : toutes les désactivations Vercel sont conservées, la nouvelle branche est également désactivée ; le workflow CHEF conserve OAuth, Stripe, PostgreSQL natif et contrats, ajoute voix/distribution et les onze endpoints Deno, et installe Chromium et WebKit. Le script commerce conserve les refus réseau/processus et les variables exactes.

## Vérifications avant soumission

Une revue indépendante a comparé les blobs : planificateur et drainage exacts de PR40 ; délai de PR39 ; paramètres et reprise de PR41 ; boucle de PR37 ; tous les quatorze fichiers mobiles de PR43. Les différences de PR38/PR42 sont limitées aux configurations composées. Aucun préfixe de migration dupliqué détecté dans les deux répertoires SQL. Les parcours React de continuation, changement de compte, annulation, partage et introduction ont été relus.

L’analyse GitNexus du candidat initial a détecté un impact critique :85 fichiers,111 symboles,21 flux. Ses limites d’inférence et de parcours sont conservées ; elle ne prouve pas l’exhaustivité du produit. Les dépendances ont été réutilisées seulement après vérification de622 versions verrouillées à la racine et153 dans KARTA, sans installation et avec caches propres au candidat.

Le typage et la compilation KARTA passent. La campagne KARTA complète locale a atteint sa borne externe de240 secondes sans rapport final :ce résultat est NON VALIDÉ, pas un succès ni une liste de tests passée. Les autres résultats locaux acquis et leurs commandes figurent dans le JSON. Les gates locaux site sont terminés : typages site/distribution, compilation, contrats de base, OAuth, voix, contrats et contrôles de distribution passent. La première passe Vitest sous Node26 a échoué sur22 fixtures car son stockage Web natif interférait avec jsdom. La même suite, sans modification du code ni des assertions, passe330/330 dans11 fichiers avec `NODE_OPTIONS="--max-old-space-size=2048 --no-experimental-webstorage"`. Le premier échec reste dans le reçu. La CI cible Node22 et doit encore qualifier l’arbre composé exact.

Les audits de dépendances de production ont été réellement exécutés sans modification des verrous :KARTA zéro vulnérabilité remontée ; site trois alertes faibles dans la chaîne OpenTimestamps/bitcore-lib/elliptic, aucune élevée ou critique. La proposition automatique de changement majeur OpenTimestamps vers0.0.0 n’a pas été appliquée. Le nouvel audit mobile avait été refusé par une revue automatique dans le chantier source ; aucun nouvel appel mobile n’a été tenté. Le snapshot daté et ses limites restent inchangés.

## Limites de livraison

Ce lot prépare un candidat commun. Il ne fusionne pas main et ne qualifie pas la production, les données réelles, le Redis déployé, l’endurance24/7, les appareils natifs ou les fournisseurs. Les autres lots de facturation/promotion/Entraide ne sont pas assimilés à cette intégration et restent à rapprocher séparément. La base canonique et l’autorité ONE→IAO restent des gates indépendants.

Aucun garde-fou, test, assertion ou délai de test n’a été affaibli pour produire un résultat vert. Aucun service actif, DNS, paiement, ordre de trading, source d’un autre propriétaire ou worker de migration n’a été modifié.

## Complément PR44 : délai de l’outbox d’approbation

La PR44 `8c764d1` est intégrée au même candidat après `8585b0b`. Son relais utilisait encore un `Promise.race` privé qui pouvait accepter une résolution trop tardive lorsque la boucle d’événements était bloquée. Il réutilise maintenant `bounded`, déjà renforcé avec une échéance monotone. Le code et les quinze nouvelles régressions sont identiques aux blobs de la PR44 ; le seul conflit concerne l’union des branches désactivées dans Vercel.

L’index GitNexus a été rafraîchi avant cette intégration. L’impact de `deadline` est CRITICAL : six appelants directs, 153 processus et vingt modules signalés par le graphe. L’avertissement a été communiqué et une revue indépendante demandée. Ces nombres décrivent l’analyse statique et ne constituent pas une preuve de portée dynamique exhaustive. Les trois fichiers de tests ciblés passent : 15 tests de délais de l’outbox, 18 tests de relais et 9 tests de délais génériques, soit **42 sur 42**, sans test ignoré.

La CI du premier candidat `8585b0b` a déjà validé KARTA (1 969 tests dans 113 fichiers) et la qualification mobile. Sa campagne site était encore en cours lors de ce reçu. Ces résultats sont conservés comme preuves intermédiaires ; ils ne remplacent pas une nouvelle CI du commit intégrant PR44. Les résultats finaux seront consignés dans la PR45 sans modifier après coup l’arbre testé.
