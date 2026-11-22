# Réception locale de l’automatisation — 22 novembre 2026

## Problèmes et comportement corrigé

Ce lot compose trois corrections vérifiées : le calendrier rejetait des adresses
valides ; KARTA réduisait certains courriers à un extrait et ne rattachait pas
correctement toutes ses réponses ; le handler manuel Gmail pouvait répéter un
envoi après une nouvelle approbation ou une issue ambiguë.

- **Calendrier :** validation correcte des destinataires, avec cas valides,
  invalides, CRLF, authentification et rejeu contrôlés.
- **Gmail KARTA :** texte inline complet ou statut explicite d’incomplétude,
  limites de lecture, pagination bornée et dédupliquée, curseur non avancé en cas
  d’échec, parent vérifié et en-têtes de réponse construits depuis ce parent.
- **Envoi manuel Edge :** réservation durable privée par utilisateur/message,
  transition unique avant effet, vérification du compte et du snapshot, reçu
  persistant avant succès HTTP. Les brouillons sont relus et leur raw vérifié
  est transmis avec leur id. Le repli reçoit lui aussi les références du parent.
  Une issue ambiguë ne déclenche jamais une nouvelle tentative automatique.

Les détails propres aux deux lots Gmail restent dans
[la réception KARTA](../gmail-reliability-20261122/README.md) et
[le contrat de l’endpoint](../../supabase/functions/email-agent-send-draft/README.md).

## Continuité préservée

Les corrections ont été préparées depuis `812830f9bba392f8fcb109a844f083638520a273`.
La branche de base a ensuite avancé à
`2890f3c78665b19dde08272aec170709e08225fd`, arbre
`ef9e6794b0592a170fa0f73920bb970e37c90058`, avec la récupération au démarrage
issue de PR84. Ses cinq fichiers sont conservés exactement. Cette note ne
réattribue pas les anciens résultats CI au nouveau candidat.

Donneurs locaux, avant composition :

| Lot | Commit |
| --- | --- |
| Calendrier | `f6d2d2f638ddc1cec9d25056e63c5e0d8f1e0b46` |
| Contexte et fil Gmail | `24ce6ccd12eaa5e58947d571857e1ae381bcc0d5` |
| Réservation et reçu Gmail manuel | `bd1cf88a2f8b719afb987dfc4c2c68b06a7bf761` |

## Qualification locale du candidat composé

**PASS : 198/198 tests sur sept fichiers, aucun échec ni test en attente.**
Les fournisseurs sont simulés ; la nouvelle suite du handler exécute les deux
migrations SQL réelles sous PGlite. Le passage commun comprend les 76 tests du
handler, les 18 tests du calendrier et les suites Gmail/autorisations voisines.
Les totaux des passages séparés ne s’additionnent pas à ce résultat commun.

Le journal `composed-tests-final.txt` et les reçus JSON voisins contiennent les
commandes, résultats et codes de sortie. Les caractères CR et blancs de fin de
ligne sont normalisés dans les captures texte ; les résultats restent identiques.
Les contrôles TypeScript KARTA/handler et la compilation KARTA font l’objet du
reçu `composed-static-final-receipt.json`.

Une contre-revue indépendante a reproduit puis vérifié les omissions MIME, les
ancres de réponse et la substitution possible du contenu du brouillon. Les cas
ASCII/7bit incohérents et le Sender divergent ont également été corrigés.

**BLOQUÉ localement : PostgreSQL natif.** Le seul essai a été refusé à la création
de socket Unix. Zéro scénario SQL natif a été exécuté. Le serveur était arrêté
et le seul cluster jetable a été supprimé ; aucun autre transport n’a été essayé.
Le harnais `karta/test/emailDraftSendOnce.native.mjs` prépare huit scénarios avec
connexions indépendantes, attentes de verrou observées et nettoyage vérifié.
Il charge les vraies migrations et contrôle leurs empreintes.

La CI existante est étendue avec ce harnais, l’archive de son rapport et le
contrôle Deno de l’index Edge changé. Deno n’est pas disponible localement.
Ces gates distantes doivent être lues sur le SHA publié ; cette réception
locale ne les déclare pas réussies par anticipation.

## Analyse d’impact

L’index GitNexus complet du socle exact a été réutilisé et enregistré par le CLI
officiel dans un registre isolé. La lecture Gmail présentait un impact initial
HIGH ; les appels dynamiques et les nouvelles frontières HTTP/SQL restent
UNKNOWN. L’absence de relation dans le graphe ne prouve pas l’absence d’appelant.
Le delta de synchronisation de PR84 a été classé HIGH (cinq fichiers, deux
symboles et neuf flux), avec fichiers conservés à l’identique.
Les comparaisons avec `main` portent sur toute la divergence historique et
restent distinctes du petit delta proposé. Le contrôle staged précède le commit.

## Conditions avant mise en service

L’approbation UI reste un booléen sans version de l’aperçu affiché au clic.
Le snapshot réservé est contrôlé, mais cette liaison UI doit être ajoutée avant
production. La réconciliation opérationnelle des historiques et des issues
inconnues reste également à réaliser. Les anciens handlers doivent être drainés
avant la livraison coordonnée de la migration et du nouveau handler.

Le lot ne couvre pas l’ingestion durable complète, tous les producteurs d’emails,
les formats MIME complexes, la téléphonie opérateur, les horaires d’appel en
exploitation, la restauration ou une disponibilité continue. Aucun fournisseur
réel, paiement, courrier, invitation, appel ni migration de production n’a été
exécuté pour cette réception.

La branche `codex/automation-reliability-20261122-529e` possède un réglage explicite
`git.deploymentEnabled=false`. Les 36 réglages existants et toute la configuration
Vercel restante sont conservés. La proposition reste un brouillon de revue.

## Première CI et corrections après publication

Sur `d45cc3b`, le run [44964459198](https://github.com/puramapro-oss/purama-ai/actions/runs/44964459198)
a passé **3 744 tests KARTA sur 173 fichiers** et les assertions des huit scénarios
PostgreSQL natifs (16.16, trois connexions distinctes, nettoyage réussi). Le
checkout `39780a2` possède les mêmes fichiers que la tête publiée.
Le job site a échoué sur **huit erreurs `no-control-regex`** des nouveaux
validateurs : les étapes suivantes, dont Deno, ont été ignorées et ne sont pas
comptées comme réussies.

Une collision du format de rapport natif a également été détectée : le détail
métier `status=sending` écrasait le verdict d’un scénario dont les assertions
avaient pourtant terminé. Les détails sont désormais imbriqués dans `details`,
sans modifier les assertions. Le rapport du run suivant doit être vérifié
séparément. Les corrections des validateurs conservent leur comportement et
ne désactivent aucune règle de contrôle statique.

### Réception du correctif de contrôle statique

Le donneur `de72dc535076fa5317b9c49aa563579c3134be7f` remplace les regex de contrôle
par trois prédicats explicites. La contre-revue a exécuté **4 455 comparaisons**,
sans divergence. Le lint ciblé termine avec zéro erreur, avertissement ou
suppression ; le handler passe son typage et ses **90/90 tests**. La migration SQL
est inchangée.

Le passage commun suivant a été interrompu par SIGKILL sur le worker PGlite :
**122 tests terminés sur 212 prévus, code de sortie 1**. Son `success:true` JSON
partiel n’est pas utilisé comme preuve de réussite. Le log et son reçu sont
conservés. Les 90 tests du donneur restent une preuve séparée sur les mêmes
fichiers ; la suite complète du candidat doit être vérifiée dans la nouvelle CI.
Les interruptions du typage dans le clone auteur ne sont pas converties en PASS ;
le résultat de typage de la composition est enregistré dans le reçu voisin.
