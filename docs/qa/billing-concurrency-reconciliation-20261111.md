# Synchronisation des abonnements — étape C, 11 novembre 2026

## Résultat et périmètre

**PASS pour les corrections locales décrites ci-dessous ; PARTIEL pour la qualification complète.** Quatre courses de synchronisation ont été reproduites puis corrigées. L'identité d'abonnement Stripe et une révision imposée par la base protègent la projection locale. Une confirmation identique renouvelle sa version sans réattribuer les droits. Un essai local détache l'identité d'un ancien abonnement annulé. Une clé Stripe au préfixe inconnu est refusée avant tout effet.

La base locale reste `ab6a6d8cf38aa7a5d3c7d5efc2a67a3d26a98a31`. [L'étape A](./billing-chef-reconciliation-20261111.md) est conservée sous l'arbre `8cb96bf6c9bdb76f1207049756801b9845ce5a72` et [l'étape B](./billing-finance-reconciliation-20261111.md) sous `c89af83e1215a7a7a60261a505f514830d5991ec`. Leurs patches et reçus ne sont pas remplacés par C. Le propriétaire global assure la reprise sur la consolidation canonique ; ce reçu ne crée pas une seconde branche générale.

Le journal de rapprochement PR22 reste inchangé et garde `reconciliation=required`. Aucun moteur contractuel de commission, rapprochement de frais, versement, changement de prix ou nouvelle politique d'essai n'est ajouté. Aucun déploiement ni contrôle de production n'est attesté.

## Défauts causaux et correction

Les barrières capturent réellement le résultat de `subscriptions.list` avant de laisser une deuxième livraison agir. Le premier handler reprend ensuite son ancienne observation. Les tests ne remplacent pas un échec attendu par un timeout.

| Entrelacement contrôlé | Avant correction | État protégé après correction |
|---|---|---|
| Ancienne annulation A, puis nouveau checkout B avec changement de plan | A réécrit `canceled/free` après B actif. | B reste actif ; le CAS d'A échoue et renvoie 503. |
| Ancienne annulation A, puis nouvelle identité Stripe B aux mêmes plan/statut | Le retour `applied:false` de B ne formait aucune barrière. A annule B. | B enregistre sa nouvelle identité et révision ; A ne peut plus écrire. |
| Ancien checkout A, puis résiliation B confirmée | A lit la ligne après B et la réactive. | Le snapshot d'A précède les lectures Stripe ; la résiliation persiste. |
| Ancienne observation `past_due` A, puis confirmation payée B avec mêmes identité et droits | Une confirmation sans UPDATE laisse passer le CAS ancien d'A. | B renouvelle seulement sa version ; A ne peut plus dégrader les droits. |

Les trois premiers tests échouent sur B : **0/3 PASS**, trois erreurs d'assertion d'état, aucune annulation ni limite dépassée. Le quatrième échoue sur le premier correctif C limité au changement d'identité : **0/1 PASS**, état final `past_due` au lieu d'`active`. Ces reçus restent séparés : `concurrency-before.json` et `concurrency-noop-before.json`.

Le schéma historique versionné utilise `NEW.updated_at = now()` dans un trigger sur `public.subscriptions`. Ce timestamp est constant dans une transaction ; le déplacement historique vers `purama_ai` n'est pas présent dans le dépôt. C ne déduit donc ni la présence de ce trigger sur la table cible ni une monotonie de temps suffisante pour le CAS.

La migration ajoute `stripe_subscription_id TEXT NULL` avec format contrôlé, client requis et unicité lorsqu'il est connu. Elle ajoute `revision BIGINT NOT NULL DEFAULT 0`, bornée à l'entier exactement représentable en JSON. Un trigger sur **toute UPDATE de purama_ai.subscriptions** impose `OLD.revision + 1`, même lorsque les valeurs commerciales et `updated_at` ne changent pas. Une valeur fournie par l'appelant ne remplace pas ce compteur ; son épuisement est refusé sans mutation.

Les deux chemins du webhook capturent l'identifiant de ligne, l'utilisateur, le client, l'abonnement et la révision **avant toutes leurs observations fournisseur**. Une écriture compare le snapshot et doit retourner la nouvelle révision attendue. La suppression puis recréation d'une ligne avec une révision repartie à zéro ne satisfait pas l'ancien identifiant de ligne. Un échec impose une nouvelle livraison avec de nouvelles observations ; aucune ancienne observation n'est réutilisée après rafraîchissement de la seule version locale.

Une répétition valide du même checkout compare aussi l'identité Stripe. Si les droits sont déjà appliqués, elle effectue un CAS portant uniquement `updated_at` et retourne `applied:false`. Les tests conservent l'exigence d'une unique attribution et vérifient séparément la confirmation de version. Les entrées refusées gardent l'assertion plus stricte de **zéro écriture**, même de confirmation.

## Essai local et configuration

Un autre contre-exemple SQL prouve qu'un essai local admis après une résiliation conservait `sub_old`. Le test échoue explicitement sur cette valeur avant correction. Le corps `start_trial` de PR28 est repris dans la nouvelle migration avec **une seule affectation supplémentaire** : `stripe_subscription_id = NULL` dans la mise à jour d'admission. Client, durée, éligibilité, atomicité et marqueur d'essai consommé sont conservés. Les six scénarios PostgreSQL natifs historiques ne sont pas modifiés.

Tous les états sans droits doivent désormais correspondre à l'identité Stripe enregistrée. Le garde limité aux seules annulations était insuffisant : `local-trial-past-due-before.json` prouve qu'un ancien `past_due` pouvait réadopter l'identité NULL et remplacer un essai `trialing/ultime` par `past_due/pro`. Cinq régressions couvrent maintenant `past_due`, `unpaid`, `paused`, `incomplete` et `incomplete_expired`, chacune en comparant une identité absente refusée et une identité exacte qui continue à se synchroniser. L'admission SQL depuis `past_due` est également vérifiée sans modifier l'éligibilité PR28. Seuls `active` avec facture payée et `trialing` avec terme valide peuvent adopter une identité différente. Les lignes historiques sans identité et les essais locaux ne sont pas révoqués sur la seule présence d'un client commun. Une résiliation de l'abonnement actuellement lié continue à remettre le plan gratuit, tout en conservant l'historique d'essai.

La configuration `opaque_inert_key` reproduisait aussi un HTTP 200 au lieu de 503 parce qu'un mode inconnu supprimait la comparaison test/live. Le test causal `configuration-prefix-before.json` conserve cet échec. Le préfixe est maintenant validé avec les autres paramètres indispensables avant création du client Stripe. Les quatre variantes `sk/rk` et `test/live` sont testées en mode concordant puis opposé ; un mode opposé reste journalisé et explicitement différé, tandis qu'un préfixe inconnu ne produit aucun effet.

## Vérifications finales

| Contrôle | Statut | Résultat et limites |
|---|---|---|
| Billing Node sur le véritable handler avec frontières inertes | PASS | **156/156**, sortie 0, 4,454 s ; aucune annulation ni test ignoré. Inclut 18 cas de concurrence/contrat et 5 cas de configuration ajoutés aux 133 précédents. |
| Commerce Deno avec typecheck et frontières inertes | PASS | **86/86**, sortie 0, 2,072 s ; réseau et sous-processus interdits. |
| Migrations finales composées et révision sur PGlite 0.5.8 | PASS | **25/25**, sortie 0, 3,458 s, un worker, cache de test désactivé. Identité, confirmations, timestamps identiques, essais, privilèges, unicités, limites numériques, rollback et remplacement de ligne. |
| TypeScript site | PASS | Sortie 0, 13,262 s ; contrat client enrichi des deux colonnes. |
| TypeScript KARTA | PASS | Sortie 0, 5,632 s ; le nouveau test SQL est inclus. Deux résultats de requête initialement `unknown` ont reçu leur type exact avant cette exécution finale. |
| ESLint | PASS avec avertissements | 0 erreur, 21 avertissements Fast Refresh sur le passage complet ; contrôle complémentaire des deux derniers fichiers TypeScript modifiés. |
| Conservation statique | PASS, portée ciblée | Preuves de produit et de facture PR40 inchangées ; normaliseur et journal PR22 inchangés ; catalogue, checkout, portail, pages, CHEF et writer overage inchangés depuis B. Aucun doublon d'implémentation. |
| PostgreSQL natif | NON TESTÉ localement | Le contrôle de syntaxe passe. Les six tests historiques sont conservés byte pour byte et un septième scénario applique le schéma final. Le runtime natif est bloqué avant serveur par EPERM sur socket dans cet environnement. |
| Vrai SDK Stripe 18.5.0 et types des imports distants | BLOQUÉ avant test | Version exacte absente du cache ; aucun SDK 17/21 substitué. Le blocage antérieur reste applicable et le gate CI conserve la signature réelle. |
| Fournisseurs et production | NON TESTÉ | Aucun paiement, message, migration ou appel métier réel n'est revendiqué. |

Chaque test Node billing a une limite de 3 secondes ; les barrières ont leur propre limite de 1 seconde. Les processus complets sont bornés et leurs sorties conservées. Le test SQL a d'abord passé sous Vitest mais échoué au contrôle TypeScript strict sur deux inférences de résultat ; les annotations ont été corrigées puis la suite SQL et le typecheck relancés. Aucun scénario n'a été retiré ou rendu facultatif.

Les 35 tests navigateur et les builds site/KARTA de A ne sont pas additionnés aux nombres ci-dessus. Leurs sources applicatives protégées sont inchangées, hormis le contrat TypeScript de colonnes et le nouveau mécanisme de projection serveur. Les résultats SQL finance B restent un historique distinct de ces 25 tests de révision C.

## Ordre de reprise et gate natif

Appliquer les migrations canoniques des packs et de l'essai atomique, puis le journal de rapprochement, puis `20261111100000_subscription_projection_revision.sql`, **avant** ce handler. Le handler refuse une révision absente ou invalide avant toute lecture fournisseur. La migration C n'invente aucun abonnement Stripe pour les anciennes lignes et ne recrée pas le déplacement de schéma historique manquant.

Le job existant `subscription-concurrency` et son PostgreSQL local jetable sont réutilisés. Les 7 542 octets des six scénarios natifs anciens restent identiques. Après son `beforeEach` historique, le nouveau septième test applique explicitement les migrations **PR28 → PR22 → C**, puis n'appelle plus `race()` ni la restauration PR28. Il fait attendre un ancien writer sur le verrou réel d'un nouveau writer, vérifie l'attente dans `pg_stat_activity`, puis attend zéro ligne modifiée après le commit concurrent. Il couvre le remplacement d'identité et la confirmation du même abonnement, puis vérifie le corps final d'admission d'essai avec identité détachée. Le résultat de cette exécution reste à obtenir en CI.

Le graphe GitNexus adopté garde la référence `0d38a925` ; il ne contient pas tous les nouveaux symboles. Les analyses d'impact et le `detect_changes` final sont complétés par comparaisons Git/AST et tests ciblés. Leur statut de couverture reste **PARTIEL**, même si une commande retourne zéro. Le reçu final et les deltas exacts sont archivés dans `iao-review/billing` par le propriétaire global.

La projection locale ne constitue pas une transaction distribuée avec Stripe. Un changement distant non observé nécessite une livraison ou une réconciliation ultérieure. Les anciennes identités NULL doivent être rapprochées sur preuves avant une résiliation ; aucun rapprochement de production n'a été réalisé ici. Les commissions contractuelles, frais, fonds disponibles et versements restent hors de cette qualification.

## Empreintes des sources de sécurité

- Webhook final : `4bf4f143a217c8862fd304fe4b13ea20e851319f49f44af4b6b1c9acc5795a48`.
- Migration C : `a49c8d45a399d04b149066b7c51cfbc095abbac68e18440868c8623d6c941470`.
- Test SQL final, annotations corrigées : `e5f6a1ea31a4a6d709cc5d45e18658234b15cf98cfed04bc2b36e5ebb0cb3c9e`.
- Test natif étendu : `54f13141a53c10011b5b1aaae8c042cbc91b696633d8114a2606ad874f21fd2d`.
