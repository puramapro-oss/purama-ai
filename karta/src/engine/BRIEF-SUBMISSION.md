# Missions saisies par l’utilisateur : admission, exécution et suivi

Ce lot raccorde les six employés qui attendent une consigne à un formulaire dans
« Mes employés IA ». Il conserve le protocole de reçus de la PR20, Jev et les
protections du moteur, puis réunit la livraison durable du commit
`27815bcc9660adcc925f1a6c2b8651ff04ff5062` avec la base
`d553ff2e784a82685d16f59727c55d5499d0db9e`.

Les validations de ces deux révisions restent historiques. Le reçu du présent
assemblage est [mission-flow-20261110.json](../../test/evidence/mission-flow-20261110.json).
Un résultat local, une admission HTTP202 et un résultat métier confirmé sont des
preuves différentes.

## Parcours

1. Le navigateur crée `submissionId` pour la consigne et `requestId` pour sa
   tentative de livraison. Seuls ces identifiants et le type d’envoi sont
   conservés localement, dans un espace propre au compte et à l’employé.
2. Le proxy vérifie le jeton avec Supabase. Le compte utilisé par KARTA vient de
   cette vérification ; il ne peut pas être choisi dans le corps de la demande.
3. `karta_submit_brief` enregistre la consigne avant de contacter la file. La
   mémoire existante reçoit `id = submissionId`. Une répétition retrouve cette
   mémoire ou son reçu privé, y compris après consommation du slot.
4. La livraison v2 existante construit l’identité et l’empreinte du job. La file
   ne reçoit que les identifiants de mission/livraison et les métadonnées de
   déclenchement. Le texte ne traverse ni la file ni le statut public.
5. Le worker et le logger conservent la réservation durable d’exécution. La
   boucle transmet `expectedBriefId` au claim ou à l’aperçu. Une cible absente
   ne permet jamais de prendre une autre consigne, même si une ancienne est
   disponible pour une reprise.
6. L’armement, les validations humaines et la clôture utilisent les reçus de
   [BRIEF-LIFECYCLE.md](BRIEF-LIFECYCLE.md). Une action à effet incertain reste à
   réconcilier ; elle ne devient pas une autorisation de répéter cette action.
7. Le navigateur consulte une projection limitée de la mémoire, du reçu courant
   et du journal lié. Les états d’enregistrement, de simulation, de validation
   et d’exécution restent distincts.

## Deux identités pour deux responsabilités

| Identifiant | Durée et règle |
| --- | --- |
| `submissionId` | Immuable pour une consigne. Même identité et texte différent : conflit. Une autre consigne attendue n’est jamais écrasée. |
| `requestId` | Stable lors d’une répétition réseau du même envoi. Une nouvelle valeur apparaît seulement lors d’un lancement explicitement demandé pour une consigne déjà enregistrée. |
| `executionKey` | Produite par le serveur de livraison. Le navigateur ne la déduit pas d’une horloge ou du dernier run. |
| `brief_id` du run | Association publique limitée à une identité, sans texte. Écrite dans la transaction d’acquisition ou d’aperçu, contrôlée par propriétaire, agent et run. |

Une réponse perdue de Redis laisse la consigne admise en SQL. La réponse peut
alors indiquer `accepted: true` et `dispatch.state: unconfirmed`. Le navigateur
retrouve la consigne et conserve la référence nécessaire à une répétition
explicite. Une consultation n’envoie jamais de nouvelle mission.

La référence de suivi est conservée séparément de celle de l’envoi incertain.
Elle retrouve la même mission après plusieurs rechargements, y compris hors de
la liste récente, sans empêcher une nouvelle consigne. Si un texte ressaisi est
refusé pour conflit, retrouver l’ancienne mission ne fait pas disparaître le
texte refusé ni son erreur ; son abandon reste explicite.

La déduplication d’une identité ne garantit pas l’équivalence sémantique entre
deux missions distinctes. Elle dépend aussi de la conservation des reçus et des
journaux ; leur effacement ne conserve pas implicitement cette protection.
Les garanties propres à chaque fournisseur restent nécessaires pour ses effets.

## Contrats

Le proxy `karta-trigger` conserve `{agentType}` pour les anciens appelants. Il
accepte également les variantes strictes suivantes :

| Action | Champs complémentaires |
| --- | --- |
| `submit-brief` | `agentType`, `submissionId`, `requestId`, `brief` |
| `retry-brief` | `agentType`, `submissionId`, `requestId` |
| `list-briefs` | `agentType` |
| `brief-status` | `agentType`, `submissionId` |

Le texte est normalisé à l’entrée du proxy, non blanc, limité à 8000 unités
UTF-16 et 32000 octets UTF-8. Le moteur refuse aussi NUL. Les lectures disposent
d’un compartiment distinct du limiteur de mutations existant. Ce limiteur
reste en mémoire par instance ; il n’est pas une réservation de quota distribué.
Le délai de l’appel interne inclut la lecture de la réponse. Les redirections
sont refusées et les réponses sont projetées sur les seuls champs attendus.

Une mission publique contient `submissionId`, `agentType`, `state`, `createdAt`,
`updatedAt`, `attemptCount` et un `run` nullable avec `id`, `status`, `mode`,
`mock`. Elle ne contient pas de consigne, paramètres d’outil, jeton ou diagnostic
fournisseur. Une liste contient au maximum 20 missions, avec le slot en attente
toujours prioritaire puis les autres résultats par dernière activité ; le statut ciblé permet
de retrouver une identité plus ancienne. L’interface conserve aussi une mission
récupérée individuellement qui n’apparaît pas dans cette liste.

## Migration021 et autorité

La migration ne crée aucune nouvelle mémoire ou file. Elle ajoute l’association
`karta_runs.brief_id`, trois index de consultation et les RPC d’admission/statut.
Elle conserve les signatures à quatre paramètres des RPC de claim/peek et ajoute
des variantes à cinq paramètres, sans valeurs par défaut ambiguës.

Admission et acquisition partagent l’ordre de verrou : parent éventuel, slot
utilisateur/agent/clé, identité UUID globale, puis lignes. Le déplacement atomique
mémoire→reçu ne peut ainsi être interprété comme une demande inexistante par une
nouvelle admission. Les fonctions sont réservées au rôle de service.

Les politiques restrictives interdisent aux clients de créer, modifier, renommer
ou supprimer `pending_brief` directement. Les lectures privées et les autres
clés restent sous leurs politiques existantes. Une collision ultérieure dans
une clé de mémoire ordinaire ne peut invalider un reçu privé concordant.

Un seul texte non acquis occupe le slot d’un employé. Les reçus prêts ou déjà
pris en charge gardent leurs identités séparées. Le plafond historique de trois
acquisitions reste applicable. La date d’admission suit les transferts.

Un reçu actif ou terminal présente son run propriétaire, même si l’heure de
démarrage d’un aperçu concurrent est plus récente. Une simulation associe son
journal à la consigne sans réserver, copier ou supprimer son texte.

## Approbations et consolidation

La reprise d’une ancienne approbation ne dispose pas encore d’une transition
durable vers le reçu original d’une consigne. Pour ces agents, la boucle suspend
cette continuation avant d’acquérir un autre brief ou de rappeler le modèle.
Elle conserve les actions déjà résolues et leur preuve. Ce lot ne revendique
donc pas une poursuite automatique complète de toute mission partielle.

La migration019 et son test, identiques dans les deux branches réunies, ne sont
présents qu’une fois. Les deux parties de la boucle sont combinées : consignes,
Jev, traces privées, empreintes, autorité custom et continuation vérifiée.

La PR21 utilise aussi les numéros018/019 pour d’autres migrations et un autre
contexte de continuation. Elle n’est pas intégrée automatiquement ici. Les
numéros et les contrats devront être rapprochés avant une consolidation avec
cette branche ; ce lot utilise018/019 de PR20,020 des empreintes et021 des
soumissions.

## Vérification et réception

Le reçu décrit les commandes, leurs codes de sortie, les scénarios réellement
exécutés et les empreintes des sources. Les bancs SQL utilisent PGlite dans des
processus successifs après une initialisation expirée dans un passage groupé.
Les interruptions ou scénarios simplement découverts ne sont pas des succès.

La campagne complète a passé **1065 tests sur 68 fichiers**, sans échec ni test
ignoré. Après les quatre derniers fichiers modifiés, **46 tests ciblés** ainsi
que TypeScript, la compilation frontend et son lint ciblé ont été revérifiés.
L’inventaire des dernières versions contient 1066 tests ; ce nombre ne décrit
pas une seconde campagne complète. Les 648 fichiers de code/configuration sont
restés inchangés pendant chacun des deux passages. Les 28 scénarios Playwright
ont seulement été découverts : aucun parcours navigateur de ce lot n’est validé.

Les scénarios intégrés exécutent les vraies routes HTTP, l’admission SQL, la
livraison/identité, le worker, la boucle, le logger, les transitions de reçus et
le statut. Le transport, le modèle et l’effet métier sont inertes. Les tests du
proxy remplacent ses frontières d’authentification et HTTP, avec le vrai schéma
de validation et le vrai limiteur.

Restent à qualifier sur une cible identifiée : navigateur opérationnel,
authentification Supabase/PostgREST réels, concurrence PostgreSQL native à
plusieurs connexions, Redis, fournisseurs et arrêt/reprise d’exploitation.
Aucune mesure de ce banc ne constitue un benchmark de latence produit, une
comparaison commerciale ou une garantie de supériorité universelle.

Avant une migration réelle : drainer les anciens workers, vérifier les données
et autorisations sur une copie, appliquer les migrations dans leur ordre,
rafraîchir le cache de schéma PostgREST et vérifier le parcours authentifié.
Les anciennes et nouvelles versions ne doivent pas acquérir des consignes en
parallèle sans partager le protocole de verrou. Un retour arrière conserve les
reçus et réconcilie la file avant reprise.

## Références techniques consultées

- [BullMQ : identifiants de jobs et effet de leur suppression](https://docs.bullmq.io/guide/jobs/job-ids).
- [BullMQ : jobs idempotents](https://docs.bullmq.io/patterns/idempotent-jobs).
- [PostgreSQL : verrous de lignes et SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html).
- [PostgREST : fonctions surchargées avec nombres d’arguments distincts](https://docs.postgrest.org/en/v16/references/api/functions.html).
- [PostgREST : rafraîchissement du cache de schéma](https://docs.postgrest.org/en/stable/references/schema_cache.html).
