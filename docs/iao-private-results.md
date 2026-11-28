# Résultats privés de recherche, de synthèse, de dossier et de simulation

## Réception complémentaire du 28 novembre : propriétaire du déclenchement

Le déclenchement manuel transmis par `karta-trigger-custom` porte maintenant le
propriétaire authentifié dans la route interne
`/trigger-custom/<agentId>/owner/<userId>`. Le client ne fournit pas ce propriétaire :
l’Edge le déduit de `auth.getUser`. L’API vérifie les UUID et la correspondance du
propriétaire avant l’admission. Une ligne sans propriétaire reconnu est refusée.
La clé d’intention, la déduplication, la queue et le reçu restent ceux du parcours
existant. La route interne administrateur sans suffixe conserve son contrat.

Livrer le moteur compatible avant toutes les instances Edge corrigées. Une API
ancienne refuse le chemin avec suffixe avant toute admission ; l’Edge ne revient
jamais automatiquement au chemin historique. La nouvelle liaison ne s’applique
pas aux requêtes d’une ancienne Edge tant que celle-ci n’est pas mise à jour.
Elle porte sur l’admission et ne crée aucune transaction supplémentaire entre
la lecture de l’agent et une modification ultérieure des données. Le worker
conserve sa vérification existante du propriétaire avant exécution.

Ce renforcement est préventif, fondé sur la revue des sources. Le scénario de
changement concurrent de propriétaire n’a pas été reproduit. Les contrôles de
contrat utilisent un propriétaire fixe, les routes compatibles et les refus
de données invalides ; les résultats figurent dans
`qa/resolution-qualification-20261125/owner-scope-20261128.json`.

## Ce que ce changement rend utilisable

Les agents créés par un utilisateur peuvent déjà exécuter `knowledge_search` et
`quantum_simulate` dans KARTA. Ce lot leur ajoute un résultat consultable dans
l’interface, puis une sélection explicite pour le chat de cet agent.

Le parcours est le suivant :

1. Le propriétaire active les outils voulus et lance une mission dans son agent.
2. KARTA conserve un résultat privé après l’exécution réelle de l’un de ces deux
   outils. Cela fonctionne aussi après une approbation.
3. Dans **Runs → Résultats privés de cet agent**, le propriétaire consulte les
   20 résultats les plus récents et choisit au plus trois résultats.
4. **Poser une question avec ces résultats** ouvre le chat et place le focus dans
   la question. Le modèle n’est appelé qu’à l’envoi de cette question.
5. Le serveur recharge les résultats à partir de leurs identifiants, vérifie leur
   propriétaire et leur agent, puis les joint au seul appel de chat existant.

La sélection est réinitialisée au changement de compte, d’agent ou de session.
Un envoi réussi retire les pièces utilisées de la sélection ; un échec permet
de réessayer. Le propriétaire peut supprimer un résultat après la fin de son
opération, avec confirmation dans l’interface et confirmation du serveur.

## Stockage et provenance

La migration canonique est `karta/migrations/028_private_tool_results.sql`.
Elle crée `purama_ai.karta_tool_results` et la RPC serveur
`karta_store_tool_result`.

| Élément | Contrat |
| --- | --- |
| Identité | Propriétaire et agent déduits du run existant ; les assertions du moteur doivent correspondre. |
| Opération directe | Identifiant `run_id:index` ; nouvelle insertion seulement pendant un run réel encore ouvert. |
| Opération approuvée | Identifiant de l’action en attente ; nouvelle insertion seulement pendant son état `executing`. |
| Contenu | Projection contrôlée, version 1, au plus 64 Kio en représentation JSONB texte. |
| Idempotence | Une opération ne reçoit qu’un résultat ; un contenu JSONB identique retrouve le même identifiant. Un contenu divergent est refusé. |
| Insertion et modification | RPC réservée au service ; aucune insertion ni modification directe de ligne n’est accordée à l’utilisateur ou au service. La suppression du propriétaire est régie séparément. |
| Lecture | Le propriétaire courant du run et de l’agent ; les résultats ne deviennent pas publics avec la fiche de l’agent. |
| Suppression | Propriétaire courant, après fin de l’opération. La fermeture empêche une nouvelle insertion après suppression. |
| Conservation | Pas de purge automatique ni de durée de conservation annoncée. Suppression par le propriétaire et cascades lors de suppression du compte, de l’agent ou du run. |

Une réponse de persistance perdue peut être réconciliée par au plus deux appels
identiques à la RPC dans une limite globale de cinq secondes. Cela ne réexécute
pas l’outil. Si la livraison reste indisponible, le moteur signale l’échec ; il
ne présente pas la mission comme réussie.

L’inspection du résultat brut est bornée séparément à 512 Kio pour les chaînes
et les clés. Elle précède l’abrègement et doit accepter les notices Unicode
valides que produit la recherche. Le payload privé projeté reste limité à
64 Kio ; les limites de profondeur, de nombre de nœuds et d’accesseurs restent
contrôlées avant stockage.

Un résultat de recherche partiel est conservé **avant** le contrôle de succès de
l’outil. Ses notices restent consultables, tandis que le statut du cycle ou de
l’approbation reste en échec. Une simulation de fonctionnement de l’agent et un
run de modèle factice ne produisent pas de résultat de recherche présenté comme
réel.

## Limites du contenu et du chat

`knowledge_search` conserve des métadonnées de Crossref et Wikidata : notices,
provenance, état de chaque source et éventuels délais de nouvelle tentative.
Les titres et extraits longs sont abrégés explicitement. Ces données ne sont
pas vérifiées, et leur conservation n’implique aucune lecture du texte intégral.
Les liens affichés sont reconstruits à partir d’un DOI ou d’un identifiant
Wikidata ; aucun HTML provenant d’un fournisseur n’est rendu.

`quantum_simulate` conserve les résultats du simulateur local classique :
probabilités, mesures simulées, paramètres bornés et provenance. Son résumé
affiche au plus 16 états de probabilité non nulle. Il ne s’agit pas d’un calcul
sur un processeur quantique physique et aucun avantage quantique n’est annoncé.

Le client transmet seulement `tool_result_ids`, au plus trois UUID distincts.
Le serveur refuse toute sélection manquante, supprimée, étrangère ou invalide.
La propriété de l’agent est revérifiée après les lectures asynchrones, avant
l’envoi des résultats au fournisseur.

Le contexte supplémentaire est un JSON borné à **16 000 octets UTF-8**. Il contient
les identifiants, statuts, résumés et références disponibles, avec des marqueurs
d’abrègement et de sources omises. Les détails complets, par exemple les tableaux
de probabilités, ne sont pas joints automatiquement au modèle. Les données sont
explicitement présentées comme non fiables, et les délimiteurs sont échappés.
Cela réduit les ambiguïtés de contexte ; ce n’est pas une garantie absolue contre
les instructions malveillantes contenues dans une source.

Le simple affichage, la sélection et la suppression n’effectuent aucun appel au
modèle. Une question avec des résultats utilise **un seul appel**, comme le chat
existant. Le contexte ajouté peut augmenter ses tokens d’entrée. Aucun nouvel
écrit automatique dans SMARANA n’est ajouté.

Les journaux KARTA, notifications et retours de file conservent leur mode
`metadata_only`. Les pièces originales ne sont pas recopiées dans les messages
ou runs du chat. En revanche, la réponse produite par le modèle est enregistrée
dans l’historique et le run du chat existants ; elle peut naturellement reprendre
des informations des résultats sélectionnés.

Les corps d’erreur du fournisseur, les erreurs de base de données et les erreurs
de transport ne sont ni renvoyés ni journalisés par le nouveau parcours de chat.
Une réponse incomplète ou arrivée après annulation n’est pas enregistrée comme
une réponse terminée.

## Correction de temporisation des sources publiques

Un `Retry-After` reçu avec HTTP 429 ou 503 est maintenant pris en compte même si
la réponse arrive à la limite du délai ou après l’expiration locale de la
requête. Le résultat reste une expiration ; le corps tardif n’est pas lu et
l’outil n’effectue pas de nouvelle tentative automatique. La porte d’admission
respecte le délai du fournisseur pour la requête suivante.

Cette protection est locale au processus. Elle ne constitue pas un quota global
Redis entre plusieurs workers. Une coordination distribuée reste à qualifier
avec un transport et une politique de réservation adaptés.

## Livraison et validation

Ordre de mise en service : appliquer les migrations de l’agent et KARTA 001–028,
puis livrer le worker KARTA, `creator-agent-chat` et l’interface provenant du
même changement. Sans la migration, le panneau signale son indisponibilité et
le moteur ne prétend pas avoir livré un résultat.

Les preuves du lot sont regroupées dans `qa/iao-private-results-20261112/`.
Les tests couvrent les deux moteurs d’exécution réels avec transports externes
simulés, le SQL exécuté sur PostgreSQL PGlite, le passage d’une projection réelle
à la RPC puis au lecteur partagé, le handler Edge et les composants de l’agent.
Une suite séparée vérifie les verrous avec plusieurs connexions sur PostgreSQL
natif dans la CI. Les statuts d’exécution, le commit et l’arbre effectivement
contrôlés doivent être lus dans le reçu de livraison ; la présence d’un test
dans le dépôt n’est pas une preuve de son exécution.

Ce lot n’effectue pas de migration de production, de déploiement, d’accès à une
base privée tierce ou de soumission à un QPU. Il ne modifie ni le routage des
modèles ni les règles d’approbation de KARTA.

## Extension du 25 novembre 2026 : synthèse des lectures programmatiques

Le parcours de lectures programmatiques ajoute une livraison finale dans cette
même table, sous le type interne `programmatic_report`. Il ne crée pas un outil
supplémentaire à activer. Le modèle, ses paramètres et son budget de sortie
restent ceux choisis pour la mission. Le texte final du modèle est conservé
avant que le moteur ne marque la mission comme réussie ; une livraison non
confirmée reste un échec explicite.

L’entrée du projecteur est exactement `{ summary, read_tools }`. `summary`
contient le texte entier, avec ses espaces et retours à la ligne. `read_tools`
énumère les noms distincts des lectures effectivement réussies, parmi
`knowledge_search` et `web_search`. La liste peut être vide. Le projecteur ne
prend aucune provenance fournie par le modèle : il construit les métadonnées
fixes suivantes, avec un tableau `sources` vide :

```json
{
  "content_kind": "model_generated_report",
  "verification_status": "unverified",
  "source_text_trust": "untrusted_data",
  "execution_mode": "programmatic_reads",
  "report_truncated": false,
  "read_tools": ["knowledge_search", "web_search"]
}
```

Le tableau ci-dessus illustre une mission ayant réussi les deux lectures. Il
n’atteste aucune vérification indépendante des affirmations de la synthèse.
Une URL éventuellement présente dans le texte reste du texte : elle n’est
pas promue en référence fournisseur vérifiée.

La synthèse est bornée à **60 000 unités UTF-16**, et son enveloppe JSON complète
à **61 440 octets UTF-8**, avant l’espace réservé au rendu JSONB de PostgreSQL.
Les deux limites s’appliquent simultanément. Un dépassement, un texte vide,
une provenance altérée ou une structure non conforme refuse la livraison ;
aucune synthèse abrégée n’est enregistrée à la place du texte entier. L’inspection
inerte interdit toujours les accesseurs, proxys, cycles et méthodes `toJSON`.

La migration additive `karta/migrations/034_programmatic_private_reports.sql`
étend la contrainte de type et les deux fonctions existantes. La migration
028 reste inchangée. Pour une nouvelle insertion de synthèse, la RPC exige un
run réel, non factice, encore ouvert, appartenant au propriétaire et à son agent
personnalisé actif. L’identité de livraison doit être une opération directe
`run_id:index` ; une action en attente d’approbation est refusée pour ce type.
Sous le verrou de l’agent, la RPC contrôle que le catalogue courant est non vide,
entièrement composé des deux lecteurs qualifiés et contient chaque nom de
`read_tools`. Aucune entrée `programmatic_report` n’est ajoutée à `tools_enabled`.

La RPC conserve son ordre de verrouillage, l’identité unique de l’opération et
la réconciliation de contenu JSONB identique. Une réconciliation après clôture
peut retrouver une livraison existante ; elle ne peut ni la modifier ni la
recréer après suppression. Les règles RLS, droits de lecture et suppression,
cascades et restrictions sur les écritures directes sont conservés.

Dans le panneau existant, **Synthèse de recherche** affiche le texte complet,
échappé par React, et indique son origine de modèle. Le propriétaire peut le
sélectionner et le supprimer comme les autres résultats. Lorsqu’il le joint
explicitement à une question, le chat reçoit une projection de **2 500 octets
JSON échappés au plus par résumé**, dans l’enveloppe totale existante de
16 000 octets. `summary_truncated` signale l’extrait de contexte ;
`report_truncated: false` décrit le résultat privé conservé entier. Le contexte
précise `model_generated_report`, sans attribuer de provenance bibliographique
ou quantique à ce texte. La sélection et l’affichage n’ajoutent aucun appel de
modèle et n’inscrivent rien dans SMARANA.

La mise en service exige les migrations KARTA jusqu’à 035 et des versions
cohérentes du worker, du lecteur Edge et de l’interface. La migration 033 conserve
les reçus de chaque réponse du fournisseur, 034 livre les rapports privés et
035 clôture aussi les briefs utilisant une synthèse sans lecture.
L’admission aux lectures programmatiques reste limitée aux agents personnalisés
ayant une identité propriétaire et run vérifiable ; elle est désactivée par
défaut. Les agents non personnalisés conservent le parcours direct existant.

Les tests ajoutés qualifient les limites exactes en caractères et octets, la
provenance, l’absence de troncature, la projection vers le panneau et le chat,
les autorisations SQL, les accusés de réception identiques et une révocation
de lecteur pendant l’attente d’un verrou sur PostgreSQL natif. Leur résultat
effectif doit être consulté dans les reçus de validation du lot Code Mode ;
l’ajout de cette section ne constitue pas une preuve de déploiement.

## Extension du 26 novembre 2026 : analyse privée d’un dossier

`qualify_resolution` rejoint les trois catalogues existants : outils exécutables
des agents personnalisés, options de leur fiche et propositions du générateur.
L’ajout au catalogue ne modifie aucun agent existant. Son propriétaire doit
sélectionner la capacité ; KARTA conserve ses contrôles d’exécution, de
simulation, d’arrêt et d’approbation. La qualification elle-même est déterministe
et locale. Le modèle éventuellement utilisé pour préparer la mission reste
celui du parcours existant.

Le résultat parcourt la même chaîne que les autres résultats privés : outil,
projection contrôlée, RPC `karta_store_tool_result`, table `karta_tool_results`,
lecture autorisée et panneau de la fiche de l’agent. Aucun nouveau moteur,
registre de dossiers, planificateur ou stockage de résultats n’est créé.

### Contenu restitué

Le panneau présente **Analyse de dossier — Analyse disponible**. Ce statut
confirme la présence d’une analyse ; il ne confirme pas qu’un problème réel
est résolu. L’identifiant, la révision et la date de l’instantané fourni restent
distincts de la date d’enregistrement du résultat.

| Rubrique | Ce qui est restitué |
| --- | --- |
| Prérequis | Groupes interdépendants, exigences, alternatives, inconnues et prochaines candidates. Un groupe de dépendances n’est pas un ordre d’exécution. |
| Transitions | Fenêtres temporelles, lacunes, chevauchements et périodes non retenues. Couverture réelle non vérifiée ; fermeture de l’ancien service non autorisée. |
| Effort choisi | Durée déclarée, pause, étape candidate, dépassements et données inconnues. Aucun diagnostic ou droit supplémentaire. |
| Conséquences d’une correction | Versions, conflits, conséquences connues et dépendances manquantes. Aucun document ou effet externe modifié. |
| Récurrence et reprises | Nouvel épisode, réouverture, même opération et effet incertain. Aucune tentative ni programmation créée. |
| Passation | Préparation, transmission, acceptation et réalisation déclarées, avec références séparées. Destinataire et habilitation restent à vérifier. |

Une rubrique absente porte « Informations non fournies ». Les listes de détails
restent consultables par rubrique. Les références originales bornées sont
conservées, avec leur dossier, révision, élément concerné, type et date
d’observation. Une référence rejetée par la qualification reste visible avec
son statut. La date d’observation n’est jamais assimilée à celle d’un événement.
Tous ces contenus sont affichés comme du texte ; une URL fournie ne déclenche
aucune consultation de site.

La provenance fixe indique `caller_supplied_snapshot`, `unverified` et
`untrusted_data`. La sortie atteste uniquement `qualification_only: true`,
`external_facts_verified: false`, `permissions_granted: false` et
`external_actions_performed: 0`. Les quatorze domaines conservent les identités
des produits existants ; ils ne prouvent ni disponibilité territoriale ni
prestataire mobilisable.

### Contrat de conservation et reprise

L’enveloppe version 1 est conservée entière ou refusée : six rubriques dans un
ordre fixe, au plus 2 048 éléments, 128 références, et **61 440 octets UTF-8**
pour le JSON compact. Le plafond SQL existant de **65 536 octets** pour sa
représentation JSONB reste applicable. Aucun dépassement ne produit un rapport
tronqué présenté comme complet. Le lecteur partagé Node/Vite/Edge vérifie la
structure et la provenance avant d’exposer la projection à l’interface.

La migration additive `036_resolution_private_results.sql` étend le validateur
et la contrainte de nom d’outil existants. La RPC, ses verrous, la séparation
des comptes et des agents, l’identité d’opération et les règles de suppression
restent celles du circuit actuel. Un rejeu identique retrouve le même résultat ;
un contenu divergent est refusé. Une opération close ne recrée pas une pièce
supprimée.

### Continuité Unicode

La migration additive `037_resolution_unicode_lengths.sql` harmonise les
chaînes fournies avec le schéma de l’outil : 160 points de code Unicode pour
les identifiants, 500 pour une référence et 20 à 35 pour sa date d’observation.
Le projecteur et le lecteur utilisent les mêmes bornes. Les NUL et les
surrogates isolés sont refusés dès la qualification ; les identités fournies
restent inchangées. Une date textuellement admissible mais invalide demeure
visible parmi les références rejetées.

Les textes générés conservent leurs bornes UTF-16 existantes : résumé 4 000,
résumé de rubrique 1 000 et élément 8 192. Les budgets de 61 440/65 536 octets
restent identiques. Une liste trop dense est refusée explicitement, sans
troncature silencieuse. La migration 036, la RPC et les anciennes catégories
de résultats ne sont pas réécrites par ce complément.

### Reprise du déclenchement manuel

Le bouton existant conserve un identifiant de demande avant l’envoi et le
transmet à `karta-trigger-custom`, qui le relaie dans l’`Idempotency-Key` de
l’API KARTA. La file et le journal d’exécution existants assurent la
déduplication ; aucun second mécanisme métier n’est ajouté.

Seul l’identifiant opaque est conservé dans le stockage du navigateur, par
propriétaire et agent. Une perte de réponse, un délai dépassé ou une
navigation conserve cette intention pour le réessai. Un reçu valide permet
de préparer une nouvelle intention au prochain clic. Cette continuité dépend
de la conservation du stockage du navigateur et des journaux SQL existants ;
elle ne rapproche pas deux navigateurs indépendants.

Un verrou natif Web Locks protège la réservation et le retrait entre onglets
de la même origine. Un onglet concurrent reçoit un message d’attente sans
envoyer une seconde requête. Si le verrou ou le stockage ne sont pas
disponibles, l’envoi est refusé explicitement. Les changements de compte,
d’agent et de conversation annulent le transport et empêchent les
notifications périmées. Ils n’effacent pas une admission encore inconnue.

Le handler authentifie le compte, revérifie la propriété et l’activation de
l’agent, impose POST et refuse les redirections. Le corps est borné à 4 096
octets, le reçu interne à 16 384 et l’attente Edge à dix secondes ; le client
borne son attente à quinze secondes. Seules les métadonnées canoniques du
reçu sont exposées. Les anciennes interfaces qui omettent `requestId` sont
refusées avant transmission : interface, Edge et protocole KARTA v2 doivent
donc être livrés ensemble.

La bascule doit rendre le moteur et ses gardes SQL compatibles, puis remplacer
entièrement l’Edge avant de servir la nouvelle interface. Une ancienne Edge
ignore l’identifiant ajouté : aucune requête du nouveau client ne doit lui
être routée pendant la transition.

### Questionner une analyse

Le propriétaire peut choisir au plus trois résultats dans le panneau, puis
ouvrir le chat avec cette sélection. Le simple affichage ou la sélection
n’effectuent aucun appel de modèle. Le serveur recharge chaque pièce selon
le propriétaire et l’agent courants ; les identifiants fournis par le client
ne constituent pas une autorisation.

Pour l’analyse de dossier, le contexte conserve la provenance, l’instantané,
les six résumés et des extraits de détails dans la limite commune de
**16 000 octets UTF-8**. Le résumé principal est borné à 800 octets JSON échappés,
chaque résumé de rubrique à 160 et chaque extrait de détail à 400. Les
abrègements et nombres d’éléments ou de références omis sont explicites ;
les références complètes restent consultables dans le panneau. Les règles
d’échappement et le statut de données non fiables sont conservés. Un résultat
de dossier n’hérite jamais de la provenance d’une simulation quantique.

### Réception et mise en service

Les preuves du complément sont rattachées au dossier existant
`qa/resolution-qualification-20261125/`. Le reçu final distingue tests exécutés,
transports substitués, contrôle SQL, essais navigateur, CI et service réel.
Il faut livrer ensemble les migrations KARTA jusqu’à 037, le worker, les
fonctions `creator-agent-generate`, `creator-agent-chat` et
`karta-trigger-custom`, leurs dépendances partagées, et l’interface correspondante.

Pour le conteneur Edge auto-hébergé, le montage de `supabase/functions` à
`/home/deno/functions` ne suffit pas. Les imports partagés attendent les
sources canoniques `karta/src/claude/assistant-policy.ts` et
`karta/src/knowledge/private-result-view.ts` sous `/home/karta/src`. Le paquet
doit fournir ces fichiers à partir du même commit qualifié, par un montage
en lecture seule de son sous-arbre `karta/src` ou des deux fichiers exacts.
Il ne faut pas prendre le dossier historique `/opt/karta` pour une preuve de
version, ni remplacer aveuglément le volume commun aux autres applications.
Le contrôle `edge-package-check.mjs` vérifie la fermeture des imports locaux
avec ces deux racines et démontre le défaut si le montage canonique manque.
Cette vérification statique ne prouve pas la résolution des imports distants
ni le démarrage du conteneur réel.

L’inspection en lecture seule du 26 novembre a trouvé les anciens conteneurs
KARTA, Redis KARTA, Auth et Edge arrêtés sur Hostinger. Les instances actives
de qualification P8 et de ONE privé n’ont pas été assimilées à la destination
de production de ce lot. Les fichiers présents dans `/opt/karta` ne prouvent
pas les migrations appliquées à une base. La remise en service demande de
rapprocher l’environnement et son propriétaire actuel avant migration ou
redémarrage. Le détail daté figure dans `deployment-observation-20261126.json`.
Le suivi `deployment-readiness-followup-20261126.json` précise les vérifications
ultérieures : déploiement public désactivé, authentification indisponible,
sauvegardes sources anciennes malgré un reçu récent de copie chiffrée, et
source de production non choisie dans le reçu de rapprochement consulté.
Les instances de qualification ne valent pas adoption de cette source.
