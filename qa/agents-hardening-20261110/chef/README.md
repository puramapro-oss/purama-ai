# CHEF : annulation confirmée et quarantaine durable

Base examinée : commit 1daf6314d60f6dd336c3a3601ddf73cf432ef4b3.
Ce lot est un correctif à examiner et valider. Aucune migration, aucun worker de
production, aucun fournisseur de modèle et aucun déploiement n'a été lancé ici.

## Défaut reproduit avant correction

Les rapports baseline-cancellation.json et baseline-retry-overlap.json conservent
les observations de la base exacte :

- Un signal déjà annulé laissait démarrer le driver et le vérificateur.
- L'annulation rejetait la promesse avant l'arrêt du processus ; un effet était
  encore observé 445 ms après le rejet.
- Un descendant survivait à l'annulation du seul PID parent.
- Le vrai cycle de supervision passait retryable alors que le worker ancien
  produisait encore un effet 441 ms après le retour du cycle.

Le contrôle de code complémentaire a établi que les verrous SQL existants ne
concernent que claimed/running/verifying. Passer seulement blocked_external
aurait donc libéré le périmètre malgré un processus d'arrêt non confirmé.
L'ancien chef_requeue_expired_tasks assimilait aussi une lease expirée à une
autorisation de réessayer, sans preuve de fin du processus.

## Ce qui change

Le driver et le vérificateur utilisent un groupe POSIX dédié créé par spawn
avec detached=true. Un signal antérieur interdit le lancement. Un arrêt en
cours adresse SIGTERM au groupe dédié, puis SIGKILL après le délai de grâce ;
le retour attend la fermeture du processus direct et l'absence de son groupe.
Les délais de grâce et de confirmation sont chacun de 2 secondes par défaut.
Un état non vérifiable produit ChefProcessStopUnconfirmedError, jamais un faux
succès ni une autorisation automatique de relancer la tâche.

SIGTERM et SIGINT du daemon arrivent au cycle actif. Le cycle transmet le signal
au driver/vérificateur, contrôle l'annulation aux étapes de validation et attend
le résultat d'arrêt avant de libérer une tâche.

Avant une transition blocked_external pour arrêt non confirmé, le superviseur
doit obtenir un accusé positif de chef_quarantine_process. La portée est dérivée
des métadonnées serveur et de la génération originale, et non du texte généré
par le modèle. En cas de lease perdue, seule une génération attestée par un
événement task_claimed serveur est acceptée ; cette situation impose une
quarantaine globale. Les exécutions sans portée explicite ou sans emplacement
utilisable sont également traitées de façon globale.

Le journal de quarantaine est indépendant des lignes tâche/mission. Il survit
à leur suppression. Les clients anon/authenticated ne peuvent ni le lire ni
l'écrire ; service_role peut lire/insérer, mais pas modifier, supprimer ou
tronquer ce journal. Le déblocage ordinaire d'une tâche et l'ancienneté d'une
quarantaine ne constituent pas une levée.

La migration 023 interdit une nouvelle admission ou validation sur le dépôt
concerné, un chemin parent/enfant chevauchant, ou une portée logique égale ou
hiérarchique. La finalisation d'une mission est aussi refusée si une quarantaine
concerne son dépôt ou sa mission, y compris lorsqu'une tâche était optionnelle.
Les mises à jour des seuls compteurs d'usage restent permises.

La récupération d'une lease expirée persiste d'abord la quarantaine, puis rend
la tâche blocked_external et le worker blocked, sans nouvelle tentative.
Chaque appel traite au plus une tâche expirée afin de conserver un ordre de
verrous borné. Une tâche occupée reste active et exclue jusqu'au prochain
passage. Une expiration n'est jamais présentée comme une preuve de mort.

## Registre de validation

| Porte | État au gel de la validation ciblée | Preuve |
| --- | --- | --- |
| Reproduction sur la base exacte | PASS : cinq défauts observés | Deux rapports baseline |
| Driver/vérificateur/groupe POSIX | PASS : 15 tests, 3 fichiers lors du premier contrôle | Historique sur la première base ; les préparations et nettoyages de chefProcess sont ensuite corrigés pour le banc intégré, voir la synthèse racine et son rejeu ciblé |
| Quarantaine SQL + adaptateur | PASS : 33 tests, 2 fichiers, exit 0, 5,17 s | quarantine-targeted-validation.json |
| Chaîne réelle des migrations | PASS dans PGlite : 008 à 023 | chefProcessQuarantine.test.ts |
| Supervision complète, daemon, intégration Git | PARTIEL avant validation finale du parent | Une passe antérieure a validé 38 tests ; deux tests Git ont expiré et un worker Vitest n'a pas démarré sous saturation de l'infrastructure |
| Typecheck final | NON TESTÉ dans cette dernière passe ciblée | Une passe antérieure tuée par l'infrastructure ; les erreurs SignalsListener remontées ensuite ont été corrigées |
| Courses PostgreSQL à plusieurs connexions | PASS : 4 scénarios sur PostgreSQL 18, exécutés et observés par l'agent parent | Séquence à trois sessions sans 40P01, deux refus PCQ01 après commit concurrent, récupération 0 sous contention puis 1 après libération |
| Déploiement et reprise de production | NON TESTÉ et non exécuté | À autoriser après revue et validations |

Commande de la dernière validation ciblée, depuis karta :

    npm test -- test/chefProcessQuarantine.test.ts test/chefQuarantineAdapter.test.ts --maxWorkers=1

La première passe de ces deux nouvelles suites échouait dans les fixtures :
un même paramètre SQL était utilisé avec les types UUID et text. Des paramètres
distincts ont corrigé la fixture ; la passe complète suivante a réussi.

Le banc PostgreSQL natif séparé a ensuite validé les quatre scénarios de
quarantaine. La séquence à trois transactions a été effectivement observée :
un lecteur détenait la garde partagée en attendant une mission, un écrivain
attendait la garde exclusive et un second lecteur demandait son admission.
PostgreSQL 18 a résolu cet ordre d'attente sans SQLSTATE 40P01. Aucun changement
supplémentaire du produit n'a été effectué sur la seule supposition d'un
interblocage.

Les deux admissions concurrentes avec une quarantaine directe ou issue d'une
expiration ont attendu, puis ont reçu PCQ01 après commit. Le candidat est resté
ready, attempt=0, fencing_token=0. Le journal a survécu à la suppression de la
mission. Sous garde partagée occupée, la récupération a rendu 0 sans modifier
l'exclusion, puis 1 après libération. Ces résultats sont ceux des cas
quarantaine ; ils ne constituent pas une déclaration de succès de tous les
autres modules du banc commun.

Les impacts GitNexus sont conservés avec les limites explicites de l'index.
Le symbole SQL non indexé est UNKNOWN, et non une preuve d'absence d'impact.
La portée étendue est MEDIUM après lecture des appels réels et des RPC.

## Mise en service, à effectuer séparément

1. Suspendre l'admission des workers existants concernés. Attendre une preuve
   d'arrêt de leurs processus et descendants ; une expiration de lease ou un
   simple changement de statut ne suffit pas. Identifier aussi les éventuels
   jobs distants lancés par les bridges.
2. Conserver les états, générations, PID/groupes, emplacements, SHA Git et
   reçus d'usage nécessaires à l'examen. Ne pas effacer ou réinitialiser un
   worktree pour masquer un état d'exécution incertain.
3. Revoir et appliquer la chaîne de migrations dans l'ordre, y compris 023,
   avec le rôle de maintenance approprié. Vérifier les droits des fonctions,
   la présence des triggers et le refus d'une admission sous quarantaine.
4. Démarrer uniquement la version corrigée des workers après validation.
   Un mélange prolongé d'anciens et de nouveaux lanceurs ne fournit pas la
   même garantie d'arrêt local.
5. Observer un cycle normal et un arrêt contrôlé sur un périmètre de validation
   isolé, vérifier les reçus et le comportement blocked_external. Une erreur
   de persistance ou un arrêt non confirmé doit conserver l'incident visible.

## Traitement d'une quarantaine par l'opérateur

Une quarantaine ne se résout ni par redémarrage du daemon, ni par expiration,
ni par chef_unblock_task. Le worker quitte avec un code d'erreur 3 lorsqu'il
identifie cet arrêt de sécurité. La procédure doit conserver la preuve de
l'incident, même si la tâche d'origine a été supprimée.

1. Lire le journal sous un compte serveur autorisé et relever l'identifiant
   d'incident, la génération task_id/fencing_token/attempt, le worker, la portée,
   la raison et l'horodatage. Ne pas prendre un PID ancien pour une identité
   actuelle : vérifier l'hôte, la date de démarrage et le groupe du processus.
2. Suspendre les lanceurs du périmètre ; pour global_scope=true, suspendre tous
   les lanceurs relevant de ce control-plane. Vérifier l'absence de processus
   ou descendants encore capables d'agir et la fin des jobs distants éventuels.
   Une absence de heartbeat ou la destruction des pipes n'est pas cette preuve.
3. Examiner le worktree et ses commits par rapport à la base et au SHA attendus.
   Réconcilier les effets externes et les reçus d'usage avant d'autoriser une
   nouvelle tentative. Conserver ce rapport et les preuves d'arrêt dans le
   dossier d'incident de l'opérateur.
4. Maintenir la quarantaine tant qu'une de ces preuves manque. Le service
   applicatif ne dispose d'aucune commande de levée et d'aucun droit DELETE,
   UPDATE ou TRUNCATE sur le journal. Une éventuelle levée doit être une
   intervention de maintenance distincte, explicitement autorisée, ciblée et
   auditée, qui conserve le journal original et le rapport de résolution.
   Ce correctif ne fournit pas de script de remise à zéro ni de faux accusé de
   décès. Un mécanisme de résolution append-only serait à examiner séparément
   avant d'automatiser la reprise.

## Limites concrètes

- Le groupe POSIX contient les descendants qui restent dans ce groupe. Il
  n'est pas une sandbox contre un code hostile qui crée volontairement une
  nouvelle session ou qui délègue une action à un service distant.
- Windows est refusé avant lancement : aucun équivalent Job Object n'est
  fourni dans ce lot. Cette branche n'est pas déclarée validée.
- Les zombies orphelins ou permissions OS empêchant de prouver la disparition
  du groupe entraînent un blocage conservateur, même s'ils ne produisent plus
  d'effet observable.
- Les chemins serveur sont normalisés lexicalement. Les alias de liens
  symboliques entre dépôts doivent être évités par l'enregistrement de chemins
  canoniques dans le runtime de confiance ; SQL ne résout pas le filesystem.
- La quarantaine est volontairement large à l'échelle du dépôt et globale
  lorsque la portée ne peut pas être prouvée. Elle peut suspendre du travail
  indépendant plutôt que supposer son absence de chevauchement.
