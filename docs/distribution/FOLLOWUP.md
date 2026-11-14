# Reprise et réconciliation du 10 novembre 2026

## Défauts reproduits

| Périmètre | Preuve avant correction | Comportement corrigé |
|---|---|---|
| Contexte de copie | 11 échecs sur les 17 premiers cas de composants | Les réponses et nettoyages anciens ne touchent plus une nouvelle identité ou demande |
| Attente des RPC | 17 échecs sur 33 cas de délai/annulation | Attente finie, annulation du transport, reprise avec le même UUID |
| Rechargement du catalogue | Une réponse retardée réintroduisait un modèle retiré ; le contrôle de republication passait | Retraits suivis par génération de chargement, republication admise à la génération suivante |
| Chat de la consolidation | 2 accès non propriétaires à un agent public renvoyaient HTTP 200 | Refus avant lecture d'historique, écriture ou appel IA |

Les premiers cas de composants ont été étendus à 19. Les 33 cas de RPC couvrent
les quatre opérations publiques, les annulations préalables ou en cours, les
transports qui ignorent l'annulation et les nettoyages de fin de demande.

Le test du chat exécute le handler, le validateur Zod 4.6.7, la politique canonique
et le contrôle réel de réponse complète. Une assertion ancienne trop large
reconnaissait le mot « CONFIDENTIALITÉ » de cette politique. Le harness cible
maintenant les marqueurs exacts des données étrangères synthétiques. La baseline
discriminante a été rejouée avant de changer la condition d'autorisation.

## Décisions de réconciliation

Un merge direct des deux lignées signalait 72 conflits. Une nouvelle branche
isolée a été créée depuis la consolidation PR33. Seul le parcours de distribution
et ses dépendances nécessaires y sont portés. Les branches originales et les
travaux des autres contributeurs sont conservés.

Les helpers `request-deadline`, `request-scope` et `useRequestScope` sont ceux de
la consolidation, inchangés. Le hook `useAuth.ts` et son provider séparé sont
conservés ; aucun doublon `useAuth.tsx` n'est introduit.

La modification du handler du chat est une seule condition : le caractère
public ne constitue plus une exception au contrôle de propriétaire. L'historique
récent, les annulations et la validation de la réponse complète restent en place.

Le contrôle navigateur de consentement cible le vrai dialogue actuel
« Un moment à ton rythme » et vérifie que son bouton facultatif reste disponible
sans ouverture automatique. Il ne cherche plus un ancien dialogue retiré.

## Lecture des preuves

Le manifeste `integration-verification.json` décrit cette version assemblée.
Les nombres du premier lot PR25 ne sont pas réattribués à cette nouvelle branche.
Les 32 contrôles auth sont inclus dans les tests unitaires, pas additionnés une
seconde fois. Les tests SQL comportent 31 scénarios et une enveloppe Node, soit
32 tests rapportés par le runner.

Les contrôles SQL utilisent un vrai moteur PostgreSQL/PGlite et les migrations
Creator Agent et distribution. Ils ne simulent pas les règles SQL, mais utilisent
des rôles et identités synthétiques, une connexion et un sous-ensemble explicite
des migrations. Ils ne prouvent pas la concurrence d'une instance PostgreSQL
native ni le routage PostgREST de production.

Les contrôles du worker en VM et les contrôles du navigateur hors ligne sont
distincts. Le navigateur doit constater une réponse issue du service worker,
un HTTP 200 et le contenu de secours après coupure réseau. Les appels HTTP
directs de ressources de cette suite refusent les redirections.

L'analyse GitNexus préalable du périmètre résout des impacts LOW et UNKNOWN.
UNKNOWN signifie qu'il faut compléter le graphe par les entrées littérales,
notamment les routes React, les handlers JSX, l'enregistrement `/sw.js` et
`Deno.serve`. Cela ne signifie pas qu'un symbole est inutilisé ou sans risque.
La vérification finale du diff et des flux est enregistrée séparément.

## Contrôles publics et mesure de performance

Le premier lancement complet de la suite publique a été interrompu après
89 succès et 7 échecs. Le rapport comporte également 60 cas non achevés : un
cas interrompu et 59 non exécutés. Ce lancement ne constitue pas une validation
complète des 156 cas.

Six échecs provenaient d'assertions lisant un instantané du DOM avant le rendu
attendu. Les traces contiennent ensuite le contenu demandé. Le contrôle des
tarifs attend désormais les quatre vrais titres de cartes. Les contrôles de
pages attendent le texte rendu avant de vérifier sa longueur. Les exigences
HTTP 200, contenu visible, absence de titre d'erreur et longueur minimale sont
conservées.

Le collecteur LCP est installé avant navigation, conserve tous les candidats
natifs, vide la file de l'observateur et retient le dernier candidat d'une fenêtre
de cinq secondes. Il joint le détail des mesures, la visibilité et les erreurs
éventuelles au rapport. Les assertions exigent une API disponible, aucune erreur,
une page visible, une mesure finie, strictement positive et inférieure à quatre
secondes. Une absence de mesure échoue ; elle n'est pas remplacée par un zéro
réussi ni par une autre métrique.

Le lot ciblé final a produit **20 succès sur 21**, sans retry ni skip. Le cas
desktop n'avait aucun candidat LCP ni FCP ; tablette et mobile mesuraient
respectivement 3 244 et 2 876 ms. Le rejeu isolé du desktop, avec le même moteur,
les mêmes arguments, assertions, sources et 180 fichiers compilés, a réussi avec
un dernier LCP natif de **2 976 ms**. Ses trois candidats étaient 2 384, 2 788 et
2 976 ms. Ce succès isolé ne transforme pas le lot précédent en 21/21.

La cause de l'absence initiale n'est pas démontrée. Les traces documentent un
démarrage des lectures publiques plus tardif dans l'échec ; elles ne prouvent
pas une cause CPU, animation ou moteur. La mesure reste un contrôle de
laboratoire avec réponses publiques synthétiques et polices externes neutralisées,
pas un percentile d'utilisateurs réels. Les suites existantes supplémentaires
ont réussi séparément : authentification mobile 20/20, consentement 24/24 et
états asynchrones 17/17.

## Portée de l'analyse de dépendances

L'index incrémental initial renvoyait des identifiants de symboles incohérents et
des attributions de flux manifestement étrangères au worker. Ce résultat a été
conservé comme diagnostic, puis l'index a été reconstruit avec la commande
officielle complète. Les six identifiants contrôlés ont été rétablis et la
requête des identifiants vides ne renvoie plus de nœud.

Sur les 42 fichiers du premier assemblage, le nouvel index signalait 558 symboles
et 44 flux, avec un risque **critical** conservé. Les racines appartenaient à
App, Login, Signup, CreatorAgentPage, handleClone, createPrivateCopy et
CreatorAgentTemplates. Six flux terminant par `Rpc` restent affectés par une
homonymie avec cinq doublures KARTA ; ils ne sont pas déclarés comme des appels
réels vers ces tests. Les routes et appels Supabase réels sont corroborés dans
les sources et par les contrôles exécutés.

Le graphe reste une preuve statique partielle. Les callbacks anonymes des tests,
certains handlers du worker et les montages JSX ne sont pas exhaustivement
représentés. La comparaison avec `main` comprend aussi les travaux hérités de la
consolidation et sa liste de symboles est tronquée. Elle ne doit pas être
confondue avec le delta détenu par cette branche. Le manifeste distingue cette
revue et le contrôle final des fichiers effectivement préparés pour le commit.

La reconstruction finale incluant les 48 fichiers préparés a terminé avec succès.
Le contrôle du delta signale 586 symboles et les mêmes 44 flux, sans nouveau flux
inattendu et sans drapeau de troncature dans cette réponse. Les 28 symboles
supplémentaires correspondent à 15 sections de documentation et 13 éléments du
collecteur LCP. Le risque reste **critical**. La comparaison cumulative avec
`main` porte sur 768 fichiers et 7 058 symboles, avec 529 flux et une liste
tronquée à 1 000 symboles. Les limites globales de parcours de l'index restent
présentes ; ce résultat n'est pas une preuve exhaustive de tous les chemins.

## Corrections révélées par la CI

Le premier lancement hébergé de cette PR, au commit
`82ddfc62afd6b2f4b89e43e953b1d57481d5a35c`, a exécuté le vrai job KARTA :
1 636 tests ont réussi et un a échoué, sur 1 637 cas dans 94 fichiers. Vitest
5.0.3 a terminé normalement avec le code 1 ; le journal ne signale pas de crash
ou d'arrêt de worker. Preuve :
[run 42920364921](https://github.com/puramapro-oss/purama-ai/actions/runs/42920364921).

Le répertoire KARTA et son job étaient identiques à la base PR33, mais le test
`karta/test/assistantPolicy.test.ts` charge réellement le handler
`supabase/functions/creator-agent-chat/index.ts`. Son scénario positif des vingt
derniers messages réaffectait l'agent à un utilisateur étranger, puis attendait
HTTP 200. La nouvelle autorisation propriétaire renvoie correctement 403 avant
de lire l'historique ; cette fixture n'exerçait donc plus le chemin annoncé.

La correction retire seulement cette réaffectation. Le propriétaire initial
reste celui de la requête, tandis que toutes les assertions sont conservées :
HTTP 200, les vingt messages dans l'ordre chronologique, le refus récent,
l'assemblage de la politique et l'absence de contenu privé étranger. Les lignes
d'historique d'autres comptes restent dans la fixture. Les 19 contrôles dédiés
du handler continuent à vérifier séparément le refus des agents étrangers, même
publics, avant lecture, écriture ou inférence.

L'impact de ce callback de test reste UNKNOWN dans le graphe. Son entrée est
confirmée littéralement : commande npm, sélection Vitest, chargement et
transpilation du handler, enregistrement `Deno.serve` et invocation réelle du
handler par le test. Aucun changement du code produit KARTA, du workflow, d'un
seuil ou d'une assertion n'est nécessaire pour cette correction.

Le même lancement du site réussit les 45 exécutions navigateur de distribution,
les 156 exécutions publiques et les 14 cas du chat. Il s'arrête ensuite sur la
suite qualité : 77 succès et un échec. Les suites situées après cette étape ne
sont pas qualifiées par ce lancement.

Dans `tests/quality/database-pages.spec.ts`, le cas de navigation attendait une
URL terminant par `/signup`. Le lien de connexion conserve maintenant sa
destination, y compris la destination par défaut `/dashboard`, et produisait
correctement `/signup?next=%2Fdashboard`. La correction attend cette URL exacte,
avec l'origine du serveur de test. Elle n'autorise pas une requête quelconque
par une expression régulière élargie. Les étapes de page introuvable et de route
protégée, ainsi que l'attente `/login` qui suit, restent inchangées et doivent
être exécutées lors de la reprise du cas complet. Cette reprise a réussi avec
la vraie configuration qualité : un cas complet PASS, sans retry ni skip.

La baseline locale du fichier KARTA reproduit 54 succès et le même échec ; après
la suppression unique, ses 55 cas passent avec Vitest 5.0.3. Ces résultats ciblés
ne sont pas présentés comme une nouvelle exécution locale des 1 637 cas KARTA ou
des 78 cas qualité. La CI du commit de correction doit exécuter les gates complets.

Les deux File UID ont été vérifiés avec le paramètre `target_uid`. Les premières
recherches utilisant `target` étaient des recherches par nom infructueuses et
restent conservées comme diagnostics. Pour KARTA, l'invocation correcte intervient
après l'édition sur l'index antérieur, dont le hash correspond au blob `82ddfc6` ;
elle n'est pas présentée comme exécutée avant l'édition. Les deux impacts restent
UNKNOWN, avec leurs points d'entrée littéraux et leurs preuves d'exécution.

Après ces corrections, la revue cumulative contre `90d8` couvre 50 fichiers,
587 symboles et les mêmes 44 flux, avec le risque critical conservé. Le delta de
cinq fichiers depuis `82dd` ne matérialise que cinq sections documentaires et
aucun flux dans le graphe : son score low ne qualifie pas les callbacks des
deux tests. La comparaison avec `main` reste partielle, avec 7 059 symboles,
529 flux et une liste tronquée à 1 000 symboles.

## Statut de livraison

Les résultats locaux sont figés dans le manifeste au moment du commit. L'état
GitHub Actions après publication doit être vérifié sur le SHA effectivement
publié et rapporté dans la PR. Une exécution verte de la base PR33 ne remplace
pas l'exécution de cette branche.

Aucune migration de production, fusion dans `main`, admission ONE ou validation
de fournisseur distant n'est revendiquée par cette reprise. Les anciennes
preuves de blocage de facturation de PR25 restent historiques : la base PR33
avait depuis exécuté une CI réelle avec succès.
