# Consolidation IAO / KARTA — 11 novembre 2026


## Checkpoint Social/Entraide — avant CI commune

Ce complément est figé **avant la CI du commit qui le contient**. Les lots locaux sont qualifiés ; les résultats de la future tête commune doivent être lus dans PR45 et ses runs, sans les confondre avec les preuves historiques ci-dessous.

### Socle déjà qualifié

La tête **f7660e43bb72b29408611593d62c1bcee53ce4a1**, arbre **6e842d921de93b94a1540da43e8820f5ef6f1e40**, a terminé avec succès les trois jobs [CHEF 42981609057](https://github.com/puramapro-oss/purama-ai/actions/runs/42981609057) et le [mobile 42981608972](https://github.com/puramapro-oss/purama-ai/actions/runs/42981608972). L'arbre du checkout GitHub bcdb3afe est identique à celui de cette tête.

Les résultats incluent KARTA 2 045/2 045 dans 117 fichiers, billing 164/164, SDK Stripe réel 39/39, journal SQL 24/24, OAuth natif 11/11, concurrence abonnements native 7/7 et quality Chromium 156/156. Les 35 cas de parrainage sont inclus dans quality, et ne sont pas additionnés une seconde fois. Les étapes d'audit registre exclues par leurs conditions ne sont pas qualifiées PASS.

### Deux lots repris avec leurs preuves

| Lot | Commit local | Qualification locale |
|---|---|---|
| Social | deb01eb0cd6921bab3f69adb300988b8579222b4 | Deno 104/104 ; SDK réel 14/14 ; SQL 40/40 ; policy 55/55 ; navigateur 29/29 ; hook 11/11 ; types, build, contrats et lint sans erreur |
| Entraide | 8fecab1c3fd60c9fffd12aaaab3e111d7ebcf4f4 | PostgreSQL natif 92/92 ; HTTP/SDK/transport 30/30 ; portée UI 9/9 ; types et build sans paquet frontend privé ; quatre entrées Edge vérifiées localement |
| Entraide navigateur/HTTP/SQL | Même commit 8fecab1c, sources identiques | Trois scénarios existants PASS dans Chrome 157 ; 57 événements HTTP ; deux confirmations perdues après le vrai commit SQL ; zéro retry/skip/flaky ; cleanup complet |

Les 22 cas du gate public Entraide comprennent 13 tests de transport déjà inclus dans les 30 et les neuf cas UI. Les trois parcours navigateur utilisent des identités synthétiques et des ports de profil reliés au PostgreSQL isolé ; ils ne qualifient pas Supabase Auth ou PostgREST hébergés. Firefox est absent : la preuve nouvelle concerne Chromium, avec les assertions et délais d'origine conservés.

Les reçus versionnés se trouvent sous qa/social-reconciliation-20261111 et qa/entraide-integration-20261111. Le complément navigateur est intégré au JSON de consolidation ; il lève seulement la limite historique de non-exécution du parcours navigateur local sur ce commit.

### Défauts reproduits et réparés

- **Entraide :** une réponse de mutation obsolète traversait le changement de compte, le logout ou A → B → A ; elle pouvait remplacer le profil dans le cache et le champ affiché, puis provoquer une relecture. Les mêmes neuf contre-cas passent de 3 PASS / 6 FAIL à 9 PASS. Les sept requêtes de mutation, identifiants de reprise, révisions et règles serveur sont conservés.
- **Autopilot social :** une continuation lancée en arrière-plan survivait au démontage ou au retour vers le compte initial. Les neuf contre-épreuves navigateur passent de 5 PASS / 4 FAIL à 9 PASS et rejoignent les 20 scénarios précédents. Une portée séparée maintient l'annulation jusqu'au règlement sans empêcher une nouvelle génération.
- **Hook d'exécution :** les continuations utilisaient le client global après changement de compte et pouvaient écraser un résultat plus récent. Les dix cas initiaux passent de 1 PASS / 9 FAIL à 10 PASS. La contre-revue avec le vrai SDK trouve ensuite une fenêtre supplémentaire avant le commit React : Bearer B avec user_id A dans PostgREST. Les deux requêtes conservent désormais le bearer A capturé ; la suite étendue passe de 10 PASS / 1 FAIL à 11 PASS. La sonde indépendante recouvre ce onzième cas et n'est pas comptée comme un douzième.

### Composition et dépendances

Le lot social conserve l'ascendance de PR22, tout en gardant les blobs financiers récents de f766. Entraide reprend 78 des 80 chemins de PR23, les deux migrations préalables de main d116dc8 et le raccord minimal de la route protégée/navigation. L'adaptateur historique sans consommateur applicatif et ses deux tests privés ne sont pas importés ; leur provenance reste dans PR23. Le protocole de mission réconcilié est unique, avec ses reçus et révisions.

Le matching canonique reste généré à partir du paquet privé et ignoré par Git. Aucun moteur recopié, module permissif, secret ou dépendance artificielle ne le remplace. La compilation frontend réussit sans ce paquet ; le runtime serveur conserve son prérequis privé explicite.

L'union automatique des workflows correspond exactement à la fusion revue indépendamment : six gates ajoutés, aucun ancien step retiré, aucun doublon Stripe/journal/billing. La seule adaptation supplémentaire impose 30 secondes au fichier du nouveau gate public Entraide, comme lors de sa qualification locale. CHEF reste sous Node 22 ; le natif Entraide hérité reste distinct sous Node 24/PostgreSQL 18.6. Le workflow mobile, les verrous racine et les protections d'identité sont conservés.

L'assemblage est vérifié avec les 33 tests publics ciblés, le typage du site et actionlint. Les tests natifs et navigateur des enfants ne sont pas relancés artificiellement : leurs empreintes et leurs frontières sont conservées, puis la nouvelle CI doit qualifier l'arbre commun.

### Portée de l'analyse et limites

Le lot social est classé CRITICAL par GitNexus (51 fichiers, 1 138 symboles rapportés, 49 processus), et Entraide HIGH (113 fichiers, 819 symboles rapportés, 15 flux). Ces nombres appartiennent aux comparaisons à f766. La comparaison historique beaucoup plus large avec main n'est pas présentée comme la portée de ce complément. Les listes et parcours du graphe sont bornés ; UNKNOWN ne signifie pas absence d'impact. Le workflow YAML n'est pas résolu comme symbole et a fait l'objet d'une comparaison structurelle explicite.

L'index de l'assemblage a ensuite révélé des associations incohérentes : `DynamicAgentFormContent` puis `root` étaient répétés dans des parcours sans rapport. **Les sorties incrémentales `phase2-index.log` et `phase2-detect-*.log` sont conservées avec le statut `UNRELIABLE_INSTRUMENTATION` ; elles ne fondent pas la portée finale.** Une reconstruction complète de l'index privé avec `--force --no-parse-cache --index-only --skip-fts --workers 1` a terminé en 145,489 secondes, sortie 0, sous Node 22.23.4 et GitNexus 1.6.12, avec 2 GiB et mémoire désactivée. HOME et la configuration globale sont inchangés.

| Comparaison sur le source figé | Fichiers | Symboles avant, non fiables | Symboles après reconstruction | Processus avant, non fiables | Processus après reconstruction | Risque |
|---|---:|---:|---:|---:|---:|---|
| Stage contre le premier parent 8fecab1c | 53 | 196 | 1 147 | 598 | 48 | CRITICAL |
| Assemblage depuis le socle f7660e43 | 165 | 349 | 1 972 | 598 | 61 | CRITICAL |
| Comparaison historique avec main d116dc8a | 1 298 | 2 171 | 11 785 | 609 | 578 | CRITICAL |

Le nouveau graphe contient 19 573 nœuds, 54 690 relations et 609 processus. Les aperçus associent désormais les parcours sociaux à leurs fonctions ; les répétitions erronées observées ont disparu de ces aperçus. Cette correction ne prouve ni la cause exacte du défaut incrémental ni l'exactitude de chaque relation. Les limites restent explicites : listes affichées tronquées, 1 262 candidats d'entrée sur 1 462 écartés, 3 580 branches omises, 36 parcours interrompus par le budget, 2 172 liens interlangues non résolus et FTS désactivé. Deux gros JSON de preuves dépassent la limite de taille ; aucune absence de parcours ne démontre une absence de code.

La reconstruction et les trois détections n'ont modifié ni les 1 720 fichiers du manifeste, ni le stage, ni HEAD, ni la configuration globale. Le manifeste source reste `07f2807f2d795a39ae1caf4cef8404be1b28bfb2aeade5eac1e015a292ca41c3` ; le reçu complet, son empreinte `0326d512463bd9005ab92d47467b4639f3a6a870bb7c4054f283900551b6178a` et les empreintes Git sont intégrés au JSON associé. La finalisation suivante porte seulement sur les deux preuves root : les 69 fichiers protégés sont revérifiés identiques à f766 dans le stage et sur disque, les autres blobs des deux enfants sont conservés, et leur seul chemin commun est le workflow CHEF dont l'union est contrôlée. L'assemblage compte 163 chemins avant ces deux preuves, 165 avec elles, et 53 stagés contre 8fecab1c ; les parents attendus sont 8fecab1c et deb01eb0. La nouvelle CI reste à exécuter sur le commit commun.

La qualification locale des fournisseurs utilise des frontières inertes. Aucune publication sociale réelle, migration hébergée, donnée de production, opération financière ou activation de fournisseur n'est effectuée. L'identité ONE, l'admission de la base canonique et la restauration distante restent des qualifications distinctes.

## Historique des checkpoints précédents

Les sections suivantes conservent les essais, échecs et corrections des étapes antérieures. Leurs résultats restent rattachés aux commits et dates indiqués.


## Résultat et portée

**PARTIEL avant qualification CI du candidat final.** Une seule branche de consolidation est retenue dans [PR45](https://github.com/puramapro-oss/purama-ai/pull/45). Elle conserve les corrections des PR37 à PR44, reprend le SHA immuable `ca47f4693ffb6440faa130043a4e79f85090a35b` de PR46, puis ajoute les corrections locales vérifiées de facturation hors ligne et de parrainage. Les suivis PR46 `5e2342f` et `1d78e272` sont également intégrés, avec les correctifs de lancement SQL et de bornes des tests décrits ci-dessous. Les résultats CI finaux seront consignés dans la PR sans modifier après coup l’arbre testé.

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
| R3 final du checkpoint | Stockage 21/21 ; retrait 4/4 ; typecheck, lint et contre-revue indépendante PASS | Parcours navigateur non exécutés dans cette campagne historique ; qualification Chromium acquise ensuite |
| Collecte des parcours R3 | 101 cas dans trois fichiers, dont 35 d’attribution | Collecte seulement ; exécution réelle à obtenir en CI |
| PR46 d’origine `ca47f469` | PostgreSQL natif 7/7 ; billing 156/156 ; commerce Deno 86/86 | CI globale en échec : 14 fixtures KARTA et typage du faux client Stripe |
| Checkpoint `c694ccda`, avant correction de la borne fichier | Commerce Deno 86/86 ; crédits KARTA 41/41 ; typecheck et lint ciblé PASS ; collecte 101 cas | Billing local : 121 PASS, 2 annulations à 3 000 ms, donc NON VALIDÉ ; SDK npm revenus non disponible localement ; CI complète requise |

Les deux échecs PR46 sont conservés comme preuves. Le groupe KARTA utilisait une clé inerte sans le préfixe désormais exigé ; la fixture du SDK réduisait `customers.create` à `metadata` alors que l’appel réel comporte aussi `email`. Les corrections alignent les frontières de test sur les contrats réels, sans supprimer les gardes, les assertions, le typage ou les tests négatifs. Le cas de contradiction de mode a été reciblé sur un événement du mode configuré et une session contradictoire, avec son attendu 503 et zéro crédit conservés. Un nouveau cas distinct vérifie l’événement d’un autre mode, son report explicite, son rejeu et l’absence de crédit. Les passages intermédiaires 39/40 et 40/41 sont conservés ; la campagne finale passe 41/41. La première commande billing conserve alors sa concurrence de 1 et son option de limite à 3 000 ms. Sur le Mac, Node annule deux fichiers à cette borne avant la fin de leur campagne ; zéro assertion échouée ne transforme pas cette annulation historique en succès. La correction de cette borne est décrite ci-dessous. Le SDK npm Stripe 18.5.0 exact manque dans le cache Deno : son groupe est bloqué avant test, sans téléchargement ni substitution. Ces deux limites sont laissées à la qualification CI prévue sur Linux.

Le premier lancement KARTA local sous Node 26 avait atteint sa borne externe de 240 secondes sans résultat final : ce n’est pas un succès. La première suite de distribution avait 22 erreurs de fixtures dues au stockage Web natif de Node 26 ; les 330 mêmes assertions passent avec ce stockage natif désactivé. Les premières tentatives et leurs logs restent dans le JSON. La qualification finale cible Node 22.

## Analyse d’impact et dépendances

GitNexus a été utilisé avant modification et avant chaque commit. Les impacts critiques du délai, des pages de facturation, du hook d’abonnement et du parrainage ont été signalés. Les symboles nouveaux ou sans appelants résolus restent UNKNOWN ; une absence de relation dans le graphe ne prouve pas une absence d’usage. La reprise utilise aussi les différences Git, les empreintes, la revue indépendante et les contre-épreuves. L’index du checkpoint a été rafraîchi ; la détection signale 47 fichiers, 514 symboles et 38 flux, avec impact critique et limites de parcours conservées.

Les dépendances ont d’abord été réutilisées après comparaison de 622 versions verrouillées à la racine et 153 dans KARTA. PR28/PR46 ajoutent 14 paquets de développement dans KARTA, dont pg 8.23.1, sans changement de version, résolution ou intégrité d’un paquet préexistant. Le verrou racine est inchangé. Aucun paquet isolé supplémentaire de pilote n’est nécessaire dans le candidat final.

Les audits de production réellement exécutés sur la tête précédente rapportent zéro vulnérabilité KARTA et trois alertes faibles sur la chaîne OpenTimestamps/bitcore-lib/elliptic du site, aucune modérée, élevée ou critique. La proposition de retour vers OpenTimestamps 0.0.0 n’a pas été appliquée. Les étapes d’audit registre exclues par la condition `pull_request` ne sont pas comptées PASS. L’audit mobile nouveau avait été refusé par une revue automatique dans le chantier source ; aucun autre chemin n’a été utilisé pour le relancer. Le snapshot daté reste une preuve limitée, distincte d’un audit actuel.

## Correction du lancement SQL après la CI de `c694ccda`

La CI CHEF 42979110270 exécute 2 045 tests KARTA dans 117 fichiers, 18 tests OAuth SQL et 11 cas OAuth PostgreSQL natifs avec succès. Le typage et le build KARTA passent également. Le gate du journal Stripe s’arrête ensuite avant toute assertion : Node 22 refuse l’option `--test-isolation=none`, sortie 9. Ce run n’est donc pas présenté comme une qualification complète réussie.

La correction retire seulement cette option. Elle conserve `node --test --test-concurrency=1 --test-timeout=30000`. Le vrai groupe SQL passe 24/24 sous Node 22.23.4 et PGlite 0.5.8, en 9,861 secondes, avec les empreintes de ses sept entrées inchangées. Une contre-épreuve vérifie une concurrence maximale de 1 ; une opération prévue pour 35 secondes est effectivement arrêtée à 30 008 ms avec la sortie 1 attendue. Le lancement direct sans `--test` a été rejeté, car son succès apparent ignorait silencieusement le délai.

La reprise `5e2342f` évite deux versions divergentes de la fixture fournisseur : type réel, paramètres optionnels, email et métadonnées normalisées sont repris exactement ; notre cas supplémentaire d’événement d’un mode étranger et de rejeu sans crédit est conservé. Aucun handler, migration, règle métier ni source de parrainage n’est modifié par ce complément. Une nouvelle CI reste requise sur le commit qui contient cette fusion et la correction de commande.

## Bornes individuelles de facturation : reprise `1d78e272`

Le plafond CLI à 3 secondes bornait le fichier isolé complet. La reprise `1d78e272` distingue ce budget du délai de chaque cas : le fichier reste isolé et dispose de 30 secondes ; le wrapper applique 3 secondes à chaque test et conserve tout délai explicite plus strict. Nos huit tests du hook utilisent ce même wrapper, tandis que leurs hooks `after`, `beforeEach` et `afterEach` restent ceux de `node:test`. Les assertions et sources applicatives ne changent pas.

Sur cet assemblage exact, **164/164 tests de facturation passent localement**, sans échec, annulation ni exclusion, sous Node 22.23.4 en 18,820 secondes. La contre-revue indépendante vérifie le vrai wrapper : interruption à 3 001,87 ms par défaut ; à 402,01 ms pour une limite explicite de 400 ms ; à 3 003,94 ms pour une demande de 10 secondes plafonnée à 3 secondes. Les trois sorties 1 sont attendues dans ces contre-épreuves de délai, distinctes des 164 tests applicatifs.

Entre-temps, le site de la CI `c694ccda` termine également avec succès : billing 164/164, SDK Stripe 18.5.0 réel 39/39 et quality Chromium 156/156, dont les 35 cas de parrainage et les 35 cas de scopes de facturation. Les 101 cas précédemment collectés sont donc réellement exécutés sur cet arbre intermédiaire. Ils ne sont pas présentés comme des parcours R3 WebKit ni comme la qualification du futur commit. Le run CHEF `c694ccda` reste globalement en échec à cause du lancement SQL, corrigé et contre-vérifié séparément.

Les reçus conservent cette chronologie, les anciennes annulations et les limites avant test du cache SDK. Une nouvelle CI doit qualifier la tête réunissant les deux corrections et leurs imports de test.

## Conditions de livraison conservées

Les migrations doivent précéder les handlers sur une base admise dont le schéma et les données historiques sont qualifiés. Aucun client ou abonnement historique ambigu n’est inventé ; les cas non liés exigent rapprochement. L’identité réelle ONE→IAO, la base canonique, les contrats de commission, les règlements, les sauvegardes restaurables, les fournisseurs et les appareils mobiles restent des qualifications distinctes.

Aucune modification de DNS, migration réelle, donnée de production, paiement, email, ordre de trading, service actif ou worker de migration n’est effectuée par cette consolidation. La branche de validation reste désactivée dans Vercel. Les preuves portent sur le code et les environnements jetables explicitement indiqués.
