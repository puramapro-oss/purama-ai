# PURAMA — fiabilité des agents, des connexions et du commerce

## Périmètre et provenance

Ce lot corrige des défauts reproduits dans le planificateur KARTA, le webhook
Stripe et les connexions Google/Gmail. Il complète le travail réconcilié de la
PR36. Il ne constitue pas une qualification exhaustive de l'entreprise, des
fournisseurs ou de la production.

La base initialement examinée était `1a49ad646b529c6fb95335105c8a4e5f28468d76`.
Pendant l'audit, la branche amont a reçu
`ca2f92b2887c711d152cbfd7e3615c3264a875a8`, qui recontrôle l'interruption lorsqu'une
lecture de corps rejette. Cette avance a été intégrée sans conflit ; les
contre-épreuves conservent leurs sources initiales exactes et les reprises
indiquent leurs propres empreintes. Les dépendances et les deux lockfiles sont
conservés.

La branche amont a ensuite reçu les corrections indépendantes de recherche Web
`26abc70` et `0bfd44c`. Le candidat les conserve par avance rapide, sans recouvrir
les fichiers du présent lot. Sa base de publication est donc
`0bfd44cbe9c87e9c58568a10210db15c6f20c89d`. Les contrôles navigateur exécutés sur
`ca2f92b` restent liés à leurs entrées inchangées ; la CI doit qualifier la
composition KARTA finale comprenant les nouveaux tests de recherche Web.

La branche de revue est `audit/reliability-oauth-20261110`. Son déploiement
automatique est désactivé dans `vercel.json`. La publication en brouillon et les
contrôles GitHub sont distincts d'une fusion ou d'une mise en production.

### Réconciliation du runtime arrivé en parallèle

La première publication `54971f5` a terminé sa CI avec succès : site et KARTA,
dont 1 739 tests KARTA dans 101 fichiers. La PR39 `2e2f713` a ensuite été
examinée : elle modifie elle aussi le planificateur, pour que le runtime attende
les travaux en cours pendant son arrêt. Les deux ensembles de protections ont
été réconciliés dans un seul contrôleur. Quarante autres fichiers runtime sont
préservés exactement ; un adaptateur de test reçoit le contexte réel attendu
par node-cron, avec toutes ses assertions conservées.

La composition conserve également les deux fichiers du correctif Web `42d508b`
arrivé sur la PR36. Les sources initiales, le premier PASS hébergé, les entrées
importées et la nouvelle qualification sont distingués dans le
[rapport de réconciliation](late-integration/README.md). Le premier PASS ne
devient pas par anticipation une preuve du nouvel assemblage.

## Corrections

### Planificateur des agents

Le créneau de déduplication provient maintenant de l'instant programmé fourni
par node-cron, avant la lecture asynchrone des utilisateurs. Deux traitements du
même événement conservent donc la même identité même si leurs lectures n'ont
pas la même durée. L'arrêt invalide les continuations avant la destruction des
timers et la boucle vérifie cet état avant chaque nouvelle soumission.

Le callback attend la fin réelle de son travail. Les seize cadences statiques
et le rapport quotidien sont conservés. Une soumission déjà commencée, un
travail accepté par Redis ou un rapport déjà en cours ne sont pas annulés par
ce garde. La réconciliation avec la PR39 fait aussi attendre la fin des travaux
en cours à `stop` et `destroy`, pour que le runtime puisse arrêter ensuite ses
workers et ses files. Toutes les expressions sont validées avant création et
un démarrage partiel est nettoyé. Voir le
[rapport initial du scheduler](../static-scheduler-20261110/README.md) et la
[qualification de la composition](late-integration/README.md).

### Paiements et identité commerciale

Deux correctifs historiques omis lors de la consolidation ont été réintégrés
avec vérification de leur chaîne de provenance. Le webhook privilégie
l'identité du client Stripe, borne le secours de recherche des anciens comptes,
refuse les produits inconnus et exige un reçu de persistance avant d'annoncer
un traitement réussi. Un échec d'écriture demeure une erreur réessayable.

Le typage utilise le client Supabase concret, vérifié avec les véritables SDK.
Les tarifs, quotas, packs et règles de commissions existants sont conservés.
L'insertion des commissions et leurs effets secondaires ne deviennent pas
atomiques dans ce lot ; l'ordre global des événements Stripe reste une limite
documentée dans [le rapport commerce](commerce/README.md).

### Admission Google et Gmail

Les deux parcours utilisent un registre SQL privé d'états aléatoires. Chaque
état est lié à l'acteur authentifié, au fournisseur et à son usage ; seul son
SHA-256 est conservé. La durée de dix minutes est calculée par PostgreSQL.
La consommation verrouille la ligne puis contrôle l'heure, empêchant également
l'admission d'un état qui aurait expiré pendant l'attente du verrou.

Les fonctions vérifient la session avant les opérations privilégiées et à
nouveau avant l'écriture des credentials. Le GET de retour Google pour Gmail
reste un simple relais vers le navigateur. Seul le POST authentifié du compte
initiateur peut consommer cet état et échanger le code. Les destinations sont
fixes ; les anciens états construits par le client sont refusés.

Les réponses exigent un reçu explicite et conforme. Une erreur de base, une
autorisation partielle déclarée, une identité différente ou un refresh token
incompatible ne deviennent pas un succès. Le client conserve le header public
`apikey` utilisé par le SDK et un Bearer utilisateur distinct.

Les délais couvrent les lectures d'identité, les échanges et les corps bornés.
Les transports ignorant une annulation ne peuvent pas reprendre le parcours
après expiration. Une écriture distante déjà lancée peut toutefois terminer :
Google, l'identité et la base ne forment pas une transaction distribuée.
Voir [la description et les bancs OAuth](../../tests/oauth-google/README.md).

### Configuration et notifications Gmail

Le formulaire pouvait conserver des champs privés non déclarés dans son type
et réécrire d'anciens credentials après une reconnexion. Les lectures et reçus
du client projettent désormais trente champs utiles à l'interface ; les
sauvegardes ne transmettent que dix-huit réglages explicitement autorisés.
La déconnexion conserve une action distincte, limitée à l'utilisateur, avec
un reçu vérifié. Voir [la contre-épreuve de configuration](gmail-config/README.md).

Les effets tardifs de chargement, sauvegarde, activation et déconnexion sont
bornés à la durée de vie de leur page. Les tests conservent le véritable
`ProtectedRoute`, qui remontait déjà les pages lors d'un changement de compte :
le défaut établi concerne les notifications globales tardives, pas un mélange
de configuration entre comptes qui n'aurait pas été reproduit.

La liste blanche frontend ne remplace pas des permissions de colonnes en base.
La politique de révocation auprès de Google et le chiffrement existant ne sont
pas redéfinis par cette correction.

## Qualification du premier lot par périmètre

Les suites se recouvrent ; leurs nombres ne sont pas additionnés en un total
de scénarios uniques. Les fixtures d'identité et de fournisseur restent inertes.

| Contrôle exécuté | Résultat observé | Preuve |
| --- | --- | --- |
| Scheduler : deux suites nouvelles et sept voisines | 108/108 PASS, dont les 9 nouveaux cas | [Rapport](../static-scheduler-20261110/README.md) |
| Webhook restauré : contre-épreuve initiale | 9 PASS / 31 FAIL sur les 40 cas | [Commerce](commerce/README.md) |
| Commerce final | 82/82 PASS sur Deno Linux et Mac, mêmes cas | [Reçu](commerce/verification.json) |
| Crédit de dépassement | 38/38 PASS, assertions conservées, préparation PGlite séparée | [Reçu](commerce/overage-mac-final-result.json) |
| Configuration Gmail : avant puis après | 5 PASS / 8 FAIL, puis 13/13 PASS | [Rapport](gmail-config/README.md) |
| Commande OAuth composée sur ca2f92 | 69/69 PASS : 35 Google, 21 Gmail, 13 configuration | [Reçu](oauth-composition-after.json) |
| Migration OAuth sous PGlite | 18/18 PASS, une connexion embarquée | [Journal](mac/qualification/oauth-sql.txt) |
| Migration native, PostgreSQL 18.4 | 10/11 avant, puis 11/11 après | [Rapport natif](oauth-native/README.md) |
| Même migration, PostgreSQL 16.15 Linux sans root | 11/11 PASS, lanceur CI inchangé | [Reçu](oauth-native/linux-pg16/result.json) |
| Navigateur OAuth initial | Quatre anciens défauts reproduits | [Résultat](mac/browser-before/results.json) |
| Notifications tardives Gmail initiales | Quatre contre-épreuves en échec | [Rapport navigateur](mac/gmail-ui-before/report.json) |
| Navigateur OAuth final | 22/22 PASS, sources stables | [Résultat final](mac/final-qualification/oauth-browser/results.json) |
| Écrans de réglages finaux | 17/17 PASS, dont les 5 nouveaux cas Gmail ; aucun ignoré ou flaky | [Rapport final](mac/final-qualification/ui-report.json) |
| Composition frontend finale | 69 tests Node, types, lint et build PASS ; 35 entrées identiques | [Reçu de composition](mac/final-qualification/result.json) |

Le banc natif observe douze connexions distinctes simultanément en attente de
verrou ; une seule reçoit l'admission. Il vérifie aussi les droits, les acteurs,
les usages, l'expiration, le rollback et la suppression en cascade. Ses clusters
ont été arrêtés et supprimés, leurs ports fermés. Le helper TypeScript est
empreinté par ce banc et exécuté séparément par les tests des handlers.

### Composition et essais qui ne sont pas des PASS

La première campagne Mac a exécuté les commandes npm de dépendances, lint,
types, contrats générés, builds, handlers OAuth, SQL et commerce. Elles passent.
Le lint produit zéro erreur et dix-neuf avertissements ; le rapport ne le
présente pas comme une sortie sans avertissement.

La suite KARTA complète de cette campagne compte 1 643 PASS et trois timeouts
sur 1 646 cas, dans deux fichiers de migrations PGlite préexistants. Ses types
et son build passent. Ce résultat demeure **PARTIEL**, sans attribuer une cause
définitive aux timeouts et sans modifier leurs assertions ou délais. Le reçu
complet est [conservé](mac/qualification/result.json).

Le premier banc OAuth corrigé a obtenu 21/22 PASS. Le dernier cas installait
l'horloge simulée après le montage du callback ; la correction du banc installe
l'horloge avant la navigation et conserve ses assertions. Le premier test du
toast legacy vérifiait seulement sa présence après disparition possible et a
passé sur l'ancien code : il est explicitement classé non discriminant. Les
reprises contrôlent aussi l'historique réel des notifications.

Les interruptions locales par SIGKILL, le Chromium local indisponible avant
tout scénario et les erreurs de compilation SDK initiales sont conservés dans
les dossiers concernés. Ils ne sont pas présentés comme des réussites.

La reprise finale exécute les deux suites navigateur complètes, la commande
OAuth et les contrôles de types/lint/build sur le gel final. Ses six commandes
terminent avec le code zéro et ses trente-cinq entrées restent identiques avant
et après. Le lint conserve dix-neuf avertissements. Les journaux bruts conservent
leur mise en forme : le contrôle de blancs finaux du code et des tests est
distinct des avertissements de whitespace dans ces sorties d'outils, comme
l'indique [le reçu de contrôle du diff](code-diff-check.json).

Les reçus initiaux ont été construits avant la première publication. La
qualification hébergée de chaque composition complète est à lire dans les
contrôles et la description de la PR associés au commit concerné. Le premier
PASS hébergé est désormais conservé dans le rapport de réconciliation ; les
résultats d'une révision suivante ne sont pas anticipés dans les reçus locaux.

### Analyse d'impact de la première publication

GitNexus 1.6.12 a reconstruit l'index du candidat sur la base `0bfd44c`, puis
exécuté la détection des changements préparés et la comparaison à `origin/main`
(`d116dc8`). Les trois commandes terminent avec le code zéro. Le premier reçu
porte sur 235 fichiers, dont 35 entrées opérationnelles ; les autres sont des
rapports et preuves. La détection signale 738 symboles, 81 flux et un risque
**CRITICAL**. Ce niveau est traité comme un signal de revue : il ne constitue
ni un défaut reproduit ni une autorisation de mise en production.

La couverture automatique reste partielle : un grand fichier de preuve est
ignoré, des liens entre langages ne sont pas résolus et des budgets de parcours
limitent les flux explorés. Une absence du graphe ne prouve donc pas une absence
de dépendance. Les trente-cinq entrées opérationnelles ont aussi été comparées
aux empreintes des bancs et relues indépendamment. Le diff exact conserve les
apports amont et les lockfiles. Voir les [commandes et empreintes](gitnexus-final/receipt.json)
et les [limites de l'analyse](gitnexus-final/analyze.txt).

Deux journaux bruts avaient subi une conversion de retours de ligne lors du
transfert de la copie Mac. Ils ont été restaurés octet pour octet depuis les
originaux ; les arbres des 235 fichiers sont alors identiques. Aucun code
exécutable n'était concerné. Le [reçu de réparation](gitnexus-final/exact-log-byte-repair.json)
conserve cette distinction. Les rapports ajoutés après cette analyse ne
modifient pas les entrées opérationnelles.

## Mise en service : dépendances réelles

La composition avec le runtime PR39 hérite également de la migration KARTA
027 et de sa procédure d'arrêt des anciens producteurs d'approbations,
détaillées dans le [rapport de réconciliation](late-integration/README.md).

La migration `20261110233000_oauth_connection_states.sql` doit précéder les deux
handlers OAuth. Les fonctions et le client doivent être livrés comme une
version coordonnée. Le réglage Gmail `verify_jwt = false` permet seulement le
relais GET fournisseur : les POST sont authentifiés dans le nouveau handler.
Ne pas appliquer ce réglage à l'ancien handler isolément. Les anciens retours
OAuth en cours devront recommencer leur autorisation.

`GOOGLE_OAUTH_REDIRECT_URI`, `APP_URL`, les clés et les URI autorisées dans la
console Google doivent correspondre à l'environnement retenu. Aucune de ces
valeurs réelles n'a été inventée ni modifiée par les bancs. La vérification de
l'application et des permissions Google reste distincte de la qualification
logicielle.

Les lectures GET du 10 novembre à 22:24 UTC observent toujours des blocages :
`purama.dev` retourne 404, `auth.purama.dev/auth/v1/health` et le chemin de fonction
OAuth retournent 502 ; `purama-ai.purama.dev` retourne 402. L'unité systemd
cloudflared interrogée renvoie `inactive` et les
conteneurs historiques Supabase sont arrêtés ; des conteneurs `p8-t03` actifs
ne sont pas assimilés automatiquement à la base canonique. Le disque racine
est utilisé à 89 %. Les [lectures de service](mac/availability-final.json) et
[vérifications GET](mac/availability-get-final.json) ne modifient aucun service.

Identifier la base et les volumes canoniques, vérifier leur sauvegarde puis
qualifier le routage, l'authentification et les fournisseurs sont nécessaires
avant une activation. Aucun conteneur persistant, compte fournisseur, paiement,
campagne, email ou migration de production n'a été activé par ce lot.

## Références techniques

- [Google : OAuth serveur et permissions accordées](https://developers.google.com/identity/protocols/oauth2/web-server).
- [Google : scopes Gmail](https://developers.google.com/workspace/gmail/api/auth/scopes).
- [Stripe : webhooks, signatures et reprises](https://docs.stripe.com/webhooks).
- [React : synchronisation et nettoyage des effets](https://react.dev/learn/synchronizing-with-effects).
- [PostgreSQL : isolation et verrous](https://www.postgresql.org/docs/18/transaction-iso.html).

Ces documents éclairent la conception ; les statuts de ce rapport reposent
sur les sources, exécutions et empreintes conservées dans ce dossier.
