# Consolidation IAO / KARTA — 11 novembre 2026

## Résultat et portée

**PARTIEL avant qualification CI du candidat final.** Une seule branche de consolidation est retenue dans [PR45](https://github.com/puramapro-oss/purama-ai/pull/45). Elle conserve les corrections des PR37 à PR44, reprend le SHA immuable `ca47f4693ffb6440faa130043a4e79f85090a35b` de PR46, puis ajoute les corrections locales vérifiées de facturation hors ligne et de parrainage. Le suivi de fixtures PR46 `5e2342f` est également intégré, avec le correctif de lancement SQL décrit ci-dessous. Les résultats CI finaux seront consignés dans la PR sans modifier après coup l’arbre testé.

Ce lot ne fusionne pas main, ne déploie pas le produit et ne qualifie ni les fournisseurs ni les données de production. Le JSON associé conserve les commandes, empreintes, erreurs et preuves de chaque étape ; les résultats historiques y sont séparés du candidat retenu.

## Une seule lignée et un seul writer financier

Le premier candidat compose PR40 `ab6901c`, PR43 `0d38a925` (incluant PR39 `124a9e5`), PR41 `88dfee31`, PR37 `9907571`, PR38 `548c41d` et PR42 `70f6c5a`. PR44 `8c764d1` apporte ensuite le délai monotone de l’outbox. Les conflits de workflow et Vercel ont été résolus par union des contrôles et des désactivations de branche.

Le checkpoint local `9a3e84c2fd138139bd48a195452eea91b25ad089` avait aussi composé PR28 avec le correctif R2 de commission atomique, les changements hors ligne et R3. Sa qualification locale est conservée dans la branche d’archive `audit/unlazy-local-r2-checkpoint-20261111-ac3c`. **Ses écritures automatiques de commissions ne sont pas retenues dans le candidat publié.** Les 27 tests PostgreSQL de ce checkpoint prouvent ses transactions et son idempotence ; ils ne prouvent ni un droit contractuel à commission annuelle ni un règlement fournisseur.

La nouvelle PR46, descendante de notre tête distante `001bc66`, reprend PR28, la tranche financière de PR22 et cinq gardes d’annulation CHEF de PR18. Sa reprise est bornée à son SHA publié, dans notre propre branche. Aucun changement n’est fait sur sa branche d’origine. La partie sociale de PR22 et Entraide PR23 ne sont pas assimilées à cette composition.

Le handler retenu journalise les observations Stripe authentifiées et vérifie le reçu de persistance avant les effets applicatifs. Il refuse une projection périmée grâce à l’identité Stripe liée, l’identité de ligne et une révision imposée par la base. Une ancienne annulation, une confirmation concurrente ou un impayé d’un ancien abonnement ne doit pas écraser des droits plus récents. Le journal reste `reconciliation=required` : il ne prouve pas des revenus acquis et ne remplace pas le moteur contractuel, le rapprochement des frais ou la disponibilité des fonds.

La règle annuelle ancienne ne dispose pas d’une nouvelle autorité métier établie par cet audit. Le PDF actuel est un récapitulatif non signé qui renvoie au contrat original ; il ne crée pas une nouvelle assiette ni une durée de remise. Les règles d’un ledger ONE distinct ne sont pas transférées arbitrairement vers IAO.

## Corrections d’interface conservées

La première lecture d’abonnement suspendue hors ligne conserve le blocage des actions avec `Boolean(user) && query.isPending`. La contre-épreuve rend le vrai hook avec React 18.3.1 et TanStack Query 5.83.0, aux versions verrouillées. Elle passe 6/8 avant correction et 8/8 après. Une course propre à la fixture de cache a été corrigée avec `gcTime: Infinity` et un nettoyage explicite ; cinq répétitions de ses huit assertions passent sans assouplir le comportement attendu.

La reprise ciblée du donneur R3 `347f162e` conserve le contrat d’authentification `next`, les scopes de compte, la garde de double clic et le refus des réponses obsolètes. Elle retire la capture doublonnée de parrainage, vérifie le reçu de stockage et lie l’identité du checkout au prix et au code normalisé. Une répétition d’une même intention garde son identifiant ; un changement ou retrait de code en crée un nouveau. Aucun retrait ou changement ne lance automatiquement un paiement.

La contre-revue a reproduit une réapparition du code après remontage React lorsque le stockage refusait sa suppression. L’état de retrait partagé pendant la vie du document et la révision des captures corrigent ce défaut : ni une navigation interne ni une ancienne réponse ne réactivent le code. Une nouvelle capture explicite réussie peut le rétablir. Si la suppression persistante échoue, l’avertissement de réapparition possible après rechargement complet est conservé.

Les six préimages R3 de PR46 sont identiques à celles du checkpoint déjà qualifié. Le hook d’abonnement ne diffère que par la garde hors ligne ; le test correspondant était absent de PR46. La reprise des huit blobs ne remplace donc aucun contrôle serveur récent.

## Preuves et limites des campagnes

| État testé | Résultat effectivement acquis | Limite |
|---|---|---|
| Candidat publié `001bc66` | CI CHEF 42969409637 et mobile 42969409690 : PASS ; KARTA 1 984 tests, 114 fichiers | Précède la reprise facturation PR46 et R3 |
| Outbox PR44 | 42/42 tests ciblés, dont 15 nouvelles régressions de délai | Aucun Redis de production ni endurance 24/7 |
| Checkpoint local `9a3e84c` | Billing 128/128, commerce Deno 111/111, PostgreSQL commissions 27/27, essais unitaires 28/28, offres 17/17 ; typages, builds et SDK réels PASS | Historique local ; le writer de commission n’est pas retenu |
| R3 final du checkpoint | Stockage 21/21 ; retrait 4/4 ; typecheck, lint et contre-revue indépendante PASS | Aucun navigateur compatible installé sur le Mac |
| Collecte des parcours R3 | 101 cas dans trois fichiers, dont 35 d’attribution | Collecte seulement ; exécution réelle à obtenir en CI |
| PR46 d’origine `ca47f469` | PostgreSQL natif 7/7 ; billing 156/156 ; commerce Deno 86/86 | CI globale en échec : 14 fixtures KARTA et typage du faux client Stripe |
| Candidat final sur `ca47f469` + correctifs | Commerce Deno 86/86 ; crédits KARTA 41/41 ; typecheck et lint ciblé PASS ; collecte 101 cas | Billing local : 121 PASS, 2 annulations à 3 000 ms, donc NON VALIDÉ ; SDK npm revenus non disponible localement ; CI complète requise |

Les deux échecs PR46 sont conservés comme preuves. Le groupe KARTA utilisait une clé inerte sans le préfixe désormais exigé ; la fixture du SDK réduisait `customers.create` à `metadata` alors que l’appel réel comporte aussi `email`. Les corrections alignent les frontières de test sur les contrats réels, sans supprimer les gardes, les assertions, le typage ou les tests négatifs. Le cas de contradiction de mode a été reciblé sur un événement du mode configuré et une session contradictoire, avec son attendu 503 et zéro crédit conservés. Un nouveau cas distinct vérifie l’événement d’un autre mode, son report explicite, son rejeu et l’absence de crédit. Les passages intermédiaires 39/40 et 40/41 sont conservés ; la campagne finale passe 41/41. Le script billing conserve sa concurrence de 1 et son option de limite à 3 000 ms. Sur le Mac, Node annule deux fichiers à cette borne avant la fin de leur campagne ; zéro assertion échouée ne transforme pas cette annulation en succès. Le SDK npm Stripe 18.5.0 exact manque dans le cache Deno : son groupe est bloqué avant test, sans téléchargement ni substitution. Ces deux limites sont laissées à la qualification CI prévue sur Linux.

Le premier lancement KARTA local sous Node 26 avait atteint sa borne externe de 240 secondes sans résultat final : ce n’est pas un succès. La première suite de distribution avait 22 erreurs de fixtures dues au stockage Web natif de Node 26 ; les 330 mêmes assertions passent avec ce stockage natif désactivé. Les premières tentatives et leurs logs restent dans le JSON. La qualification finale cible Node 22.

## Analyse d’impact et dépendances

GitNexus a été utilisé avant modification et avant chaque commit. Les impacts critiques du délai, des pages de facturation, du hook d’abonnement et du parrainage ont été signalés. Les symboles nouveaux ou sans appelants résolus restent UNKNOWN ; une absence de relation dans le graphe ne prouve pas une absence d’usage. La reprise utilise aussi les différences Git, les empreintes, la revue indépendante et les contre-épreuves. L’index du checkpoint a été rafraîchi ; la détection signale 47 fichiers, 514 symboles et 38 flux, avec impact critique et limites de parcours conservées.

Les dépendances ont d’abord été réutilisées après comparaison de 622 versions verrouillées à la racine et 153 dans KARTA. PR28/PR46 ajoutent 14 paquets de développement dans KARTA, dont pg 8.23.1, sans changement de version, résolution ou intégrité d’un paquet préexistant. Le verrou racine est inchangé. Aucun paquet isolé supplémentaire de pilote n’est nécessaire dans le candidat final.

Les audits de production réellement exécutés sur la tête précédente rapportent zéro vulnérabilité KARTA et trois alertes faibles sur la chaîne OpenTimestamps/bitcore-lib/elliptic du site, aucune modérée, élevée ou critique. La proposition de retour vers OpenTimestamps 0.0.0 n’a pas été appliquée. Les étapes d’audit registre exclues par la condition `pull_request` ne sont pas comptées PASS. L’audit mobile nouveau avait été refusé par une revue automatique dans le chantier source ; aucun autre chemin n’a été utilisé pour le relancer. Le snapshot daté reste une preuve limitée, distincte d’un audit actuel.

## Correction du lancement SQL après la CI de `c694ccda`

La CI CHEF 42979110270 exécute 2 045 tests KARTA dans 117 fichiers, 18 tests OAuth SQL et 11 cas OAuth PostgreSQL natifs avec succès. Le typage et le build KARTA passent également. Le gate du journal Stripe s’arrête ensuite avant toute assertion : Node 22 refuse l’option `--test-isolation=none`, sortie 9. Ce run n’est donc pas présenté comme une qualification complète réussie.

La correction retire seulement cette option. Elle conserve `node --test --test-concurrency=1 --test-timeout=30000`. Le vrai groupe SQL passe 24/24 sous Node 22.23.4 et PGlite 0.5.8, en 9,861 secondes, avec les empreintes de ses sept entrées inchangées. Une contre-épreuve vérifie une concurrence maximale de 1 ; une opération prévue pour 35 secondes est effectivement arrêtée à 30 008 ms avec la sortie 1 attendue. Le lancement direct sans `--test` a été rejeté, car son succès apparent ignorait silencieusement le délai.

La reprise `5e2342f` évite deux versions divergentes de la fixture fournisseur : type réel, paramètres optionnels, email et métadonnées normalisées sont repris exactement ; notre cas supplémentaire d’événement d’un mode étranger et de rejeu sans crédit est conservé. Aucun handler, migration, règle métier ni source de parrainage n’est modifié par ce complément. Une nouvelle CI reste requise sur le commit qui contient cette fusion et la correction de commande.

## Conditions de livraison conservées

Les migrations doivent précéder les handlers sur une base admise dont le schéma et les données historiques sont qualifiés. Aucun client ou abonnement historique ambigu n’est inventé ; les cas non liés exigent rapprochement. L’identité réelle ONE→IAO, la base canonique, les contrats de commission, les règlements, les sauvegardes restaurables, les fournisseurs et les appareils mobiles restent des qualifications distinctes.

Aucune modification de DNS, migration réelle, donnée de production, paiement, email, ordre de trading, service actif ou worker de migration n’est effectuée par cette consolidation. La branche de validation reste désactivée dans Vercel. Les preuves portent sur le code et les environnements jetables explicitement indiqués.
