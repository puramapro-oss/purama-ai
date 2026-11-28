# Communication écrite locale — 12 novembre 2026

## Source et périmètre

Cette tranche étend le mobile Expo existant de `puramapro-oss/purama-ai`.
Base distante : PR45, commit `c81d316f1a7a308727806128ba3bbfa196365ee6`.
Sous-arbre mobile vérifié : `3c07ddb98c9e24d790a09cbe674cfd0735f84861`.
Le checkout de travail provient du donneur local `ee5059d5d6c9a9c29c92a2c5892457d24b081f22`,
qui contient exactement ce même sous-arbre mobile. Son historique global ne doit
pas être poussé comme s’il était celui de PR45. Le workflow mobile de départ a
également été comparé : blob `fd0008d4a12250b697b6fa14685f7f726d0a32fc`.

L’entrée propose explicitement la communication écrite ou l’espace compte.
La route `/communication` permet de saisir un message, de l’afficher en grand,
de l’agrandir, de revenir à la saisie et de confirmer son effacement. Le texte
affiché conserve les espaces et les retours à la ligne saisis. Les messages
entièrement blancs ne peuvent pas être présentés. Une limite de 2 000 unités
UTF-16 borne la saisie sans conserver la moitié d’une paire de substitution.

Le message et le brouillon restent en mémoire et sont effacés à la sortie de
l’écran, y compris si le navigateur conserve son composant dans la pile. Il
n’y a pas d’expiration automatique pendant la lecture, de stockage de
conversation, d’appel réseau associé au texte, de capteur, de synthèse vocale
externe ou de relais montre dans cette tranche.

## Frontière avec les services de compte

Le fournisseur d’authentification reste monté avec le navigateur. Il est
**passif** pour les seuls segments publics exacts `[]`, `["index"]` et
`["communication"]`. Les groupes `[(tabs)]` et `[(auth)]`, les agents et le
callback d’authentification ne sont pas publics. Le chemin normalisé `/`
n’est pas utilisé pour décider de cette frontière : il pourrait aussi
désigner l’accueil protégé des onglets.

La création du client Supabase est différée jusqu’à son premier accès effectif.
La découverte synchrone des modules de routes peut ainsi se faire sans
configuration de compte et sans construire le client. Le singleton, les
méthodes liées à leur instance, le stockage, le schéma et les options de
session du client sont conservés. Au retour vers le compte, l’ancienne
identité et l’ancien profil restent masqués jusqu’à une nouvelle validation.
Les anciennes réponses et les anciennes souscriptions ne peuvent pas
réactiver une identité après passage en mode local.

Une erreur d’initialisation du compte laisse les données protégées fermées et
présente un retour vers la communication écrite. Aucune session persistée,
aucun jeton, aucun droit et aucun service financier n’est modifié.

**Limite réseau :** au premier lancement sur une route publique, aucun client
de compte n’est construit. Après une ouverture volontaire du compte, les
tâches internes du client déjà initialisé, notamment son renouvellement de
session, peuvent continuer selon son comportement existant. Cette tranche
ne prétend pas couper tout le réseau de l’application après une connexion.
Elle ne transmet pas le contenu de la communication écrite.

## Vérifications locales finales

Exécutées depuis `mobile`, avec Node `24.22.1` et npm `11.9.0` :

| Commande | Résultat |
| --- | --- |
| `npm run test:local-communication` | PASS — 19 tests |
| `npm run typecheck` | PASS — sortie 0 |
| `npm run test:dependencies` | PASS — 8 tests des consommateurs réels |
| `npm run test:audit-snapshot` | PASS — 8 tests de liaison et de refus |
| `npm run verify:audit-snapshot` | PASS — graphe courant lié au rapport frais |
| `git diff --check` | PASS — sortie 0 |

Les tests montent les vrais composants et hooks avec React `19.1.0` et
`react-test-renderer` `19.1.0`. Les primitives natives, les références de vues,
la navigation active et les transports sont contrôlés. La découverte de
routes utilise le véritable `getRoutesCore` d’Expo Router `6.0.24`, en mode
synchrone. Le cas web charge le véritable export `AccessibilityInfo` de
React Native Web, dépourvu de `sendAccessibilityEvent`, et vérifie le chemin
de focus alternatif. Le moteur de rendu de test signale sa dépréciation ;
ce test logiciel n’équivaut pas à une recette sur un appareil.

Les cas couvrent le démarrage public sans configuration, les liens profonds
protégés, le cycle compte/public/compte, les réponses et profils tardifs,
StrictMode, les échecs synchrones d’initialisation, le retour local après
erreur, le texte exact, les commandes d’édition/effacement, le retour du
focus et le bouton Retour matériel.

Le workflow `.github/workflows/mobile-quality.yml` exécute désormais ces
tests en plus des contrôles existants et conserve leur journal. **Les exports
Metro Android et iOS de la source finale restent à qualifier par la CI.**
Un export Android local a réussi sur une version intermédiaire, avant les
derniers correctifs ; ce résultat ne qualifie pas la source finale.

## Audit de dépendances

Un audit réel `npm audit --audit-level=high --json` a terminé avec le code 0
le `2026-11-12T03:59:42.234Z`. Le rapport intégral, le reçu d’exécution et
sa liaison au fichier de versions sont dans `../dependency-audit/`.
Il indique **0 vulnérabilité haute, 0 critique, 15 modérées et 1 faible**.
La politique existante et ses refus restent inchangés. Le rapport couvre
875 instances de paquets du registre et expire le
`2026-11-13T03:59:42.234Z` selon la fenêtre existante de 24 heures.

## Limites de qualification

NON TESTÉ sur appareil : VoiceOver, TalkBack, afficheur braille, clavier et
taille de texte du système, sortie/reprise de l’application et expérience
physique à fort agrandissement. Les appels de focus et les propriétés
d’accessibilité sont vérifiés logiciellement, sans prétendre que le message
a été perçu. Aucun binaire natif, signature, soumission à un magasin ou
appairage de montre n’est qualifié par cette tranche.

L’analyse d’impact préalable a utilisé l’index du donneur : AuthProvider
LOW (1 dépendant), Button MEDIUM (5 directs, 6 au total). Plusieurs symboles
de routes et le client sont UNKNOWN dans ce graphe ; une absence de lien
n’est pas une preuve d’absence d’impact. Les deux nouvelles indexations
locales ont échoué. Le contrôle final de portée réutilise une copie de
l’index du même commit de base, en conservant son ancien horodatage ; les
nouveaux symboles peuvent donc ne pas y être représentés.
`detect-changes --scope all` a terminé avec le code 0 sur cette copie :
20 fichiers modifiés, 18 symboles identifiés, 1 flux identifié, risque
MEDIUM. Ce résultat de portée complète la lecture du diff ; il ne prouve
pas que les nouveaux symboles ou tous les flux sont présents dans le graphe.

Références : [React Native 0.81 — AccessibilityInfo](https://reactnative.dev/docs/0.81/accessibilityinfo),
[Expo Router — principes de routage](https://docs.expo.dev/router/introduction/).
