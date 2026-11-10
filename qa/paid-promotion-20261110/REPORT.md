# PURAMA — promotion, identité et preuves financières

Date de qualification locale : 10 novembre 2026.

## Résultat et portée

**PASS pour la qualification locale initiale du commit `07faa21e353df0d84bf1059a0d4d01d75cf79b73` ; PARTIEL pour son suivi CI et la mise en service complète.** Les 310 tests locaux décrits ici appartiennent à ce commit. La première CI a ensuite révélé un test KARTA obsolète et un blocage de lancement du navigateur ; leurs corrections font l'objet d'un suivi distinct, sans réattribuer les résultats antérieurs à une nouvelle révision. Aucun déploiement ni versement réel n'est attesté.

Cette édition remplace le bilan initial de PR22. Les 218 tests et les 140 erreurs TypeScript indiqués dans l'ancienne édition décrivaient une autre révision. Ils ne sont pas utilisés comme preuve de cet assemblage.

Sources immuables de composition :

- Consolidation PR33 : `90d8f30322e864ccfd186e97cbfe7edf3afec9a9`.
- Promotion PR22 : `5b1338f8a7ff520b6509394ddf7ec8dc9eb2e6f0`.
- Référence de régression `main` : `d116dc8a6429ea76c67167a195eb3f723f2251fb`.
- Les six fichiers du planificateur PR34 sont déjà dans PR33 ; aucun second planificateur n'est ajouté.

La PR22 existante reste le véhicule de revue. Le premier candidat composé, `07faa21e353df0d84bf1059a0d4d01d75cf79b73`, a pour parents les deux sources ci-dessus. Une fusion brute des anciennes branches aurait réintroduit des divergences étrangères à ce lot. Les empreintes des sources testées et les commandes exécutées sont conservées dans [validation.json](validation.json) ; les preuves initiales restent séparées du suivi correctif.

## Corrections propres à cette reprise

### Composition financière sans double mécanisme

Le journal Stripe de PR22 et le crédit overage de PR33 portaient tous deux la version de migration `20261110000200`, et créaient le même index économique. Le journal est désormais dans `20261110100000_stripe_reconciliation_events.sql`. Il ne recrée ni l'index overage ni une seconde fonction d'octroi.

Le chemin composé est unique : signature Stripe vérifiée → observation persistée → helper canonique `applyOveragePayment` → RPC canonique `credit_overage_pack`. Le helper, sa migration et `commerce_privileges` restent identiques à PR33. Une panne ou un reçu invalide du journal empêche l'octroi ; une réponse perdue après persistance peut être rejouée sans second crédit.

Une ligne historique sans preuve complète n'est pas réécrite pour la rendre admissible : le replay produit un conflit et conserve la ligne. La contrainte d'unicité des clients Stripe du journal préserve également les données historiques en refusant une migration ambiguë.

Le premier passage des tests a détecté que l'assemblage avait perdu le refus de l'auto-parrainage au checkout. La condition préexistante a été restaurée. Le checkout final est sémantiquement identique à PR22, hors commentaires et espaces ; les métadonnées d'attribution restent résolues côté serveur.

### Réponses tardives et changement de compte

Un test navigateur a reproduit le défaut suivant : le contenu est modifié pendant l'envoi, puis l'ancien succès appelle encore `onPublished`. Ce test échoue avant correction et passe après correction.

Le bouton et les réglages utilisent maintenant le scope de requêtes déjà présent dans le socle. Un changement de propriétaire, de contenu ou un démontage invalide l'opération. Les réponses périmées ne modifient plus la vue et ne déclenchent plus notification, redirection ou callback de publication.

Le client social capture l'identité de départ et transmet explicitement son bearer au SDK. Les étapes successives vérifient encore le propriétaire. Une configuration Autopilot du compte A reçue après passage au compte B ne peut donc pas démarrer une publication sous B.

Le formulaire d'agent présente un autre risque : son hook conservait un résultat A qui pouvait apparaître sous B et alimenter le bouton de publication manuelle. Son contenu, y compris le hook, est désormais remonté avec une clé propriétaire/agent. Le scope de génération ignore également une réponse terminée après le démontage. Aucun changement du hook partagé `useAgentExecution` n'est nécessaire.

Les délais réutilisent `createRequestDeadline`, sans nouveau mécanisme parallèle. Une attente du transport est bornée ; une réponse tardive après expiration reste inerte. Une vérification de publication conserve la même identité de demande.

### Réglages vérifiables

Les mutations de connexion, déconnexion et configuration partagent une admission locale : un double clic ne crée pas deux sauvegardes concurrentes. Les contrôles deviennent indisponibles pendant l'opération.

Une erreur de chargement produit un message et une action Actualiser. Si la sauvegarde et sa relecture échouent toutes deux, l'interface montre un état non confirmé ; elle ne réaffiche pas une ancienne configuration comme si elle était certaine. Les comptes et l'historique sont retirés au changement de session.

### Qualification intégrée à la CI

Cinq étapes sont ajoutées au workflow hardening : invariants SQL, logique sociale, routes avec SDK Supabase, revenus avec SDK Stripe et navigateur social. Les huit étapes KARTA et les trente-deux étapes site déjà présentes sont conservées, identiques et dans le même ordre. Aucun gate n'est retiré, aucune erreur n'est ignorée, aucun secret n'est ajouté.

La suite conserve le moteur Chromium et `chromiumSandbox: true` en CI. Après le blocage du navigateur téléchargé par Playwright lors de la première CI, l'étape de suivi sélectionne le Chrome système du runner, `/opt/google/chrome/chrome`, sans désactiver la sandbox. Sa qualification distante reste attendue. La qualification locale initiale utilise Firefox compatible déjà présent. Le navigateur est recréé pour chaque scénario et les vues lourdes sont chargées à la demande.

## Protections de promotion conservées et requalifiées

### Publication

- Identité de demande stable par propriétaire et contenu normalisé ; un contenu différent sous la même identité est refusé.
- Destinations fixées côté serveur. Une reconnexion ultérieure ne redirige pas une ancienne publication programmée.
- Résultat par destination : confirmé, partiel, programmé, échec ou à confirmer. Un simple HTTP 2xx ne prouve pas la publication partout.
- Écritures SQL contrôlées avant et après l'effet externe. Une réponse perdue conserve une incertitude et ne provoque pas un nouveau POST fournisseur.
- Réservation atomique des publications programmées. Une réservation interrompue n'est pas automatiquement remise dans une file d'envoi.
- Rapprochement en lecture pour les publications connues du fournisseur. Aucun identifiant fournisseur n'est inventé.
- Publication limitée aux comptes ayant une preuve serveur. X demeure suspendu tant que son financement n'est pas confirmé ; ce parcours ne déclenche pas de génération payante de légende ou de hashtags.

Le correctif de suivi rend explicite le contrat de légende : `forceCaption: true` est refusé en HTTP 400 avant toute lecture ou écriture des tables de publication et tout appel IA ou fournisseur, après authentification. Les clients actuels omettent cette option ou envoient `false`. La représentation canonique `forceCaption: false` est conservée dans l'identité cliente et le hash serveur pour préserver les demandes existantes normales.

Les anciennes demandes avec `forceCaption: true` étaient acceptées en conservant le texte préparé. Après ce refus explicite, un POST portant encore cette option, même pour relire une telle demande, reçoit 400. Il ne faut pas la convertir automatiquement en `false` : l'intention et son identité pourraient changer. L'historique GET permet de consulter les demandes déjà enregistrées ; le correctif ne supprime ni n'annule les publications déjà programmées. La vérification de ce nouveau refus figure dans le suivi, pas dans les 310 résultats initiaux.

### Connexion et déconnexion

- Profil fournisseur attribué côté serveur avec contraintes d'unicité ; création incertaine relue avant toute nouvelle tentative.
- État OAuth HMAC expirant, nonce durable à usage unique, propriétaire/plateforme/profil vérifiés et preuve fournisseur du compte.
- Consommation du nonce et liaison atomiques. Les anciennes lignes ne deviennent pas automatiquement vérifiées.
- Désactivation locale avant déconnexion ; DELETE limité au compte concerné. La requête ayant acquis `disconnect_pending` est l'unique propriétaire de l'effet externe.
- Les reprises restent en lecture. Elles attendent `disconnect_reconcile_ready` et une absence confirmée par une liste fournisseur complète.
- Reconnexion interdite pendant la déconnexion ; fin datée par SQL pour empêcher une ancienne intention OAuth de réactiver le compte.
- Comparaison de `updated_at` lors des sauvegardes concurrentes. Un conflit devient HTTP 409.

### Écritures financières

- Observations Stripe signées conservées dans un journal immuable avant acquittement, avec compte émetteur, mode test/live et événement distincts.
- Montants conservés dans l'unité minimale de leur devise. Aucun taux, montant HT ou calendrier commercial n'est déduit d'une donnée manquante.
- Suppression de la commission annuelle anticipée et de sa validation après un seul paiement ; préservation des anciennes commissions.
- Abonnement rattaché par métadonnées serveur ou client unique ; essai conservé comme essai, produit inconnu refusé, écritures sans ligne confirmée signalées en erreur.
- Traitement automatique des paiements et administration héritent des protections PR33 : aucun faux virement annoncé, aucune commande cliente marquant arbitrairement une commission payée.

Le journal Stripe **n'est ni le registre canonique ONE, ni un solde disponible, ni une autorisation de versement**. Ses événements demandent un rapprochement. Voir [le volet financier](../../tests/revenue/README.md).

## Qualification locale initiale — commit `07faa21e353df0d84bf1059a0d4d01d75cf79b73`

| Ensemble | Résultat local |
|---|---:|
| Publication, OAuth et gestion : logique métier et stores | **101 PASS** |
| Routes sociales importées avec le vrai SDK Supabase | **14 PASS** |
| Webhook Stripe et checkout, signatures réelles du SDK | **30 PASS** |
| Gardes commerce et abonnements du socle | **42 PASS** |
| SQL : journal Stripe et octroi canonique | **23 PASS** |
| SQL : publication, liaison, nonces, déconnexion et permissions | **40 PASS** |
| KARTA overage : vrai handler, normaliseur et deux RPC SQL | **40 PASS** |
| Navigateur : composants, formulaire, hook et client réels | **20 PASS** |
| **Tests distincts ci-dessus** | **310 PASS, 0 échec final** |
| TypeScript global du site | **PASS — 0 erreur** |
| Lint global | **PASS — 0 erreur, 16 avertissements hérités** |
| Compilation de production Vite | **PASS — 21,13 s** |
| Versions des migrations | **PASS — 40 numéros distincts** |
| Conflits Git et espaces du diff | **PASS** |
| Couverture du graphe d'impact final | **PARTIEL — limites décrites ci-dessous** |

Les reprises ne sont pas additionnées au total. Les 310 cas ne représentent pas l'exécution locale de toutes les suites du dépôt. Les 55 empreintes initiales de `validation.json` correspondent au commit indiqué dans ce titre ; elles ne sont pas remplacées par les empreintes des corrections ultérieures. Les résultats CI sont présentés séparément ci-dessous, sans les additionner au total local.

Les tests Deno ont le typecheck actif et interdisent réseau et sous-processus à l'exécution. Les SDK réels vérifient leurs contrats ; les réponses du serveur et du prestataire sont contrôlées. Les tests SQL exécutent les migrations et leurs fonctions dans PGlite 0.5.8. Ils ne prouvent pas une concurrence entre connexions PostgreSQL natives.

Les vingt scénarios navigateur utilisent Firefox 148.0.2 / Playwright 1.59.1. Ils vérifient en outre zéro exception JavaScript non interceptée, zéro requête locale échouée et zéro tentative de requête extérieure depuis les pages. Ils couvrent les réponses perdues et tardives, les changements de compte, le démontage, l'expiration d'attente, les réglages, l'Autopilot et les deux cas de résultat d'agent appartenant à une ancienne session.

### Première exécution CI — résultat PARTIEL

Le [run GitHub Actions 42918981402](https://github.com/puramapro-oss/purama-ai/actions/runs/42918981402) a exécuté la référence de fusion `a1cae9b6f93875e410e23f7011957f78c824630c`. Son arbre Git `0151628a38da0b31cb06a6407e4f29b75625a068` est strictement identique à celui du candidat local `07faa21e353df0d84bf1059a0d4d01d75cf79b73` ; cette égalité a été vérifiée directement dans Git. Ces résultats distants portent donc sur les mêmes sources que la qualification locale initiale.

| Contrôle distant | Résultat de cette exécution |
|---|---|
| KARTA, suite globale | **1 638 réussis / 1 échec, sur 1 639** ; 93 fichiers de test réussis et un en échec |
| Logique sociale Deno | **101 PASS** |
| Routes sociales Deno avec SDK | **14 PASS** |
| Revenue Deno, résolution npm normale `node-modules-dir=none` | **30 PASS** ; Stripe 18.5.0 téléchargé depuis le registre npm sur le runner |
| Navigateur social Chromium | **0 scénario exécuté sur les 20 prévus** ; lancement interrompu avec `No usable sandbox!` et SIGTRAP |
| Gates placés après les étapes en échec | **NON EXÉCUTÉS** dans les jobs concernés ; aucun succès n'est déduit de leur présence dans le workflow |

Le job site utilisait Ubuntu 24.04, image `20261101.360.1`. Le job KARTA utilisait Ubuntu 26.04, image `20261101.186.1`. Les deux jobs se sont terminés avec un code de sortie 1. Les journaux conservés sont `ci-run-42918981402-site.txt` et `ci-run-42918981402-karta.txt`.

### Suivi correctif après cette CI

Deux corrections bornées constituent ce suivi : le test de politique KARTA vérifie désormais le refus public en HTTP 400 de l'option de légende payante, avec zéro effet DB, RPC, transport ou modèle, au lieu d'exposer l'ancienne fonction privée `generateCaption` ; la nouvelle étape navigateur sélectionne le Chrome système en conservant la sandbox. Trois nouveaux cas Deno couvrent le refus de `true` avec préservation d'une demande historique, les types invalides, et l'équivalence absent/`false` avec une seule publication puis replay. Le cas de programmation transmet explicitement `false`. Le code de production KARTA et OTS reste hors de ce correctif.

| Contrôle du correctif | Résultat propre à ce suivi |
|---|---|
| `assistantPolicy.test.ts`, avec le vrai point d'entrée social | **55/55 PASS, sortie 0** ; toutes les autres politiques de ce fichier restent testées |
| `publish.test.ts`, Deno avec typecheck actif | **16/16 PASS, sortie 0**, dont les trois nouveaux cas |
| Workflow et préservation des étapes initiales | **PASS statique** ; la sélection du Chrome système ne supprime aucun gate |
| Exécution du Chrome système et nouvelle CI complète | **NON TESTÉES** à ce stade |

Les deux suites locales passent dès leur première exécution après correction. Les commandes, journaux et nouvelles empreintes figurent dans l'objet `followup_correction` de `validation.json`. Ces résultats ne sont pas additionnés aux 310 cas initiaux et ne constituent ni une réexécution locale des 1 639 tests KARTA, ni un succès de la nouvelle CI. **Le statut global du suivi reste PARTIEL.**

### Échecs rencontrés puis traités

- **Auto-parrainage :** premier résultat Deno 29/30, puis 30/30 après restauration de la garde.
- **Ancien callback :** sept cas initiaux réussis, puis échec du nouveau cas de contenu changé ; ce même cas est réussi dans la série finale.
- **Lint :** un `any` explicite dans l'adaptateur de stockage social ; remplacé par une frontière `unknown` et l'interface PostgREST existante. Les suites concernées ont été rejouées.
- **TypeScript :** limite locale de heap de 384 Mio insuffisante, erreur V8 explicite ; le même contrôle réussit avec 768 Mio.
- **Vitest et navigateur :** interruptions SIGKILL sans résultat exploitable ; mêmes assertions réussies avec un worker threads pour Vitest et un navigateur neuf par scénario. La cause exacte des SIGKILL n'est pas établie.
- **Résolution Stripe :** accès local au registre refusé avant les tests en mode `node-modules-dir=none`, puis qualification locale avec le SDK 18.5.0 déjà installé en mode manual/cached-only. La résolution normale sur runner a ensuite réussi dans la première CI, suivie de **30/30 PASS**. Ce point n'est plus une inconnue sur cette révision ; il ne transforme pas le job site entier en succès.
- **Test de politique KARTA :** le cas `social caption generation` cherchait `__testGenerateCaption`, un binding privé supprimé lors du retrait de la génération payante ; l'appel a échoué avec `TypeError: generate is not a function`. Le suivi remplace ce cas par une assertion du contrat public de refus, sans réintroduire l'appel IA.
- **Sandbox Chromium en CI :** aucun scénario social n'a pu démarrer avec le navigateur téléchargé. La sélection du Chrome système conserve la sandbox et doit être validée par une nouvelle exécution distante.

## Préservation et impact

Le code de production KARTA, OTS, contrats et DocuSeal examiné reste identique au snapshot PR33. Les exceptions autorisées portent uniquement sur deux fichiers de test : `karta/test/overageCredit.test.ts`, adapté pour la composition financière initiale, et `karta/test/assistantPolicy.test.ts`, adapté dans le suivi CI au contrat public de publication sans génération payante. Les six blobs propres du correctif du planificateur PR34 restent identiques. Aucun manifeste ni lock applicatif n'a été modifié ; les dépendances de validation supplémentaires sont locales au runtime de test.

Les recouvrements avec PR33 conservent ses protections : configuration Playwright, hook administratif sans mutation `markCommissionPaid`, administration sans faux paiement, garde du traitement des commissions et fixtures commerce. Les deux tests administratifs spécifiques de PR22, devenus redondants avec le socle, ne sont pas dupliqués.

Les impacts GitNexus ont été exécutés avant les corrections. Le client social partagé est classé **HIGH : six appels directs, quatre processus** ; la lecture de configuration est classée **HIGH : trois appels, trois processus**. Les composants et adaptateurs résolus sont de portée locale. Plusieurs callbacks et fichiers ont une couverture UNKNOWN ; cela n'est jamais interprété comme une absence de risque. Le flux financier reste critique par sa nature et reçoit les vérifications de signature, persistance, replay et erreur détaillées plus haut.

Pour le candidat initial `07faa21e353df0d84bf1059a0d4d01d75cf79b73`, la réindexation complète a été interrompue dans cet environnement (une sortie 1, puis une sortie 137/SIGKILL). La vérification `detect_changes` a donc utilisé explicitement le graphe de PR22 et le paramètre officiel `worktree` pointant vers le candidat composé. Elle a bien lu le diff alors courant : **57 fichiers contre PR33**, puis **781 contre main**, ces derniers incluant le socle hérité. Les deux ensembles correspondent exactement aux listes Git de cette révision.

Le résultat est **CRITICAL** : 1 246 symboles et 47 processus contre PR33 ; 2 110 symboles et 202 processus contre main. Les listes de symboles sont tronquées à 1 000 entrées. Aucun chemin de symbole retourné ne sort du diff correspondant, mais le graphe antérieur et cette troncature interdisent de présenter cette analyse comme complète. La préservation des fichiers réservés est vérifiée directement par leurs blobs et les tests qualifient séparément les comportements. **Ce gate reste PARTIEL**, explicitement conservé dans la revue ; il ne vaut pas autorisation de production.

L'analyse finale du suivi correctif, effectuée avant son commit, relève **7 fichiers, 27 symboles et 2 processus, risque MEDIUM**, contre `07faa21e`. L'assemblage complet représente **58 fichiers, 1 248 symboles et 47 processus contre PR33**, puis **781 fichiers, 2 112 symboles et 202 processus contre main** ; ces deux comparaisons restent CRITICAL et tronquées. Les nombres de fichiers concordent exactement avec Git et aucun chemin de symbole retourné ne sort du diff correspondant. Le même graphe antérieur est utilisé : la couverture reste PARTIELLE. Les trois fonctions du refus de légende avaient une portée LOW avant édition ; les fixtures et le fichier CI ont une couverture UNKNOWN.

## Conditions restantes avant activation réelle

| Action restante | Intervention nécessaire | État de ce lot |
|---|---|---|
| Raccorder les événements au registre ONE et au calcul contractuel des commissions | Lot métier/ONE : assiette, taux, retours, réserves et durée explicites | **BLOQUÉ pour le versement** |
| Relier un prestataire de versement et rapprocher ses références, remboursements et disponibilités | Responsable paiements ; qualification Stripe réelle | **NON TESTÉ** |
| Appliquer les migrations et déployer les routes dans le schéma confirmé | Opérateur Supabase ; vérification secrets, origine autorisée, cron et droits | **NON DÉPLOYÉ** |
| Valider OAuth, publication, récupération et déconnexion sur comptes réels | Intégration sociale avec coûts et droits fournisseur confirmés | **NON TESTÉ** |
| Vérifier les gates GitHub après les deux corrections CI | Revue du dépôt, résultat lié à la nouvelle révision | **PARTIEL — première CI en échec ; nouvelle qualification attendue** |

L'ordre financier impose la migration canonique overage `20261110000200` avant le nouveau journal `20261110100000`. Les migrations sociales `20261110000300` et `20261110000400` doivent précéder les nouvelles routes. Les migrations de privilèges du socle restent nécessaires. En présence de doublons historiques, le refus de migration conserve les données et exige un rapprochement ; aucune suppression automatique n'est prévue.

Limites connues conservées : la table historique d'abonnements ne fournit pas un ordre total entre événements concurrents ; une déconnexion interrompue avant son marqueur terminal garde son verrou jusqu'à preuve opérateur ; le portefeuille et Stripe Connect hérités ne constituent pas un circuit de versement qualifié. Le contrat PDF et certaines mentions commerciales doivent être alignés par le lot métier, sans réécriture arbitraire des engagements historiques.

Aucune fusion dans `main`, migration distante, publication sociale réelle, campagne payante, opération bancaire ou notification externe n'est effectuée par cette qualification. Les tests n'établissent aucune garantie de revenu ni de fonctionnement sans frais personnels.
