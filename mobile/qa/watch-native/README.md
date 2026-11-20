# Réception du relais natif d’accessibilité — 12 novembre 2026

## Périmètre exact

Cette évolution prolonge l’application Expo existante et le parcours **Accessible pour moi** de PURAMA ONE. Elle conserve les identités des applications, la communication écrite publique et le fournisseur de compte différé. Elle ne crée pas un second compte ni un nouveau shell mobile.

Base distante retenue : `8259b84e65ca89b01bd1b1fc46576cb60bb8a1ec`, arbre `a2c260792c5b881e7e40abfb42d03afc24405e3b`. Le snapshot local `f6f304fae9f473877d10312942f2df6d207dde0e` a le même arbre complet. Les apports publics du commit `5857961` et la correction de facturation de PR57 sont conservés.

## Comportement ajouté

- L’accueil propose « Accessible pour moi » sans compte. Les deux segments publics exacts `accessible-one` et `accessibility-watch` réutilisent la frontière de communication existante. Les chemins imbriqués et les écrans de compte restent protégés.
- Le parcours ONE utilise une origine HTTPS définie à la compilation, un document WebView isolé et un canal lié à un défi natif. Il ne s’ouvre pas automatiquement. Une navigation, un arrêt, une perte de focus ou un passage en arrière-plan ferme ce document.
- « Communiquer par écrit » rejoint l’écran natif existant, y compris sans origine ONE. La fermeture locale doit être confirmée et la demande de navigation encore courante. Un échec permet de réessayer.
- Une autorisation native à usage unique prépare les catégories de sons et l’appareil choisis. Le bouton explicite dans ONE déclenche ensuite le consentement sur la montre ; aucun appairage simulé n’est présenté comme réel.
- Les modules Swift et Kotlin et leurs compagnons utilisent WatchConnectivity et Wear Data Layer. Ils distinguent admission du transport, réception, présentation du texte et appui explicite sur « J’ai compris ».
- Les messages portent seulement des métadonnées d’observation admises. Pas de son, photo, texte libre ni simulation transmis par ce relais. Le budget de fraîcheur est réduit pendant les files ; annulations, changements de session et callbacks tardifs sont bornés et contrôlés.

## Résultats locaux

| Contrôle | Résultat et portée |
| --- | --- |
| Installation du verrou réuni | PASS — `npm ci`, 839 paquets, sans scripts d’installation dans ce contrôle local |
| Pont, cycle du document et hôte natif JS | PASS — 55/55 tests ; doubles déterministes pour les frontières OS/React |
| Communication, routes et fournisseur de compte | PASS — 22/22 ; composants réels et Expo Router installé, plateformes et modules natifs contrôlés |
| Consommateurs réels des adaptateurs de dépendances | PASS — 8/8 |
| Liaison/refus du snapshot d’audit | PASS — 8/8 |
| TypeScript, alignement SDK, arbre installé | PASS |
| Audit npm frais | PASS au seuil haute/critique : 0 haute, 0 critique, 15 modérées, 1 faible ; rapport du 12 novembre à 04:27:51 UTC, politique de 24 heures inchangée |
| Prebuild Expo et découverte du module | PASS sur les sources natives gelées : projets Apple/Android générés, module reconnu, cibles uniques, incorporation watchOS et plugin idempotent |
| Revue indépendante | PASS pour les défauts de logique examinés ; aucun nouveau blocage relevé après corrections |
| Compilation Swift/Kotlin, téléphone et compagnons | NON TESTÉ localement ; workflow natif ajouté pour exécution sur les plateformes correspondantes |
| Exports Metro du candidat réuni | NON TESTÉ localement ; gate mobile existant conservé en CI |

`reconciled-software-gates.json` lie les commandes, les codes de sortie et les empreintes des entrées. Les reçus `local-*` décrivent le prebuild et les premiers contrôles, avec leur propre périmètre ; ils ne remplacent pas une compilation native. Le workflow mobile conserve ses contrôles antérieurs et ajoute le gate du pont. Le workflow natif produit des journaux, les tests Swift/Kotlin et, en cas de réussite, les APK **debug** téléphone et Wear avec leurs empreintes.

## Analyse de portée

GitNexus a été exécuté avant les modifications de symboles et avant les commits. Le lot initial représente 1 023 symboles dans 21 flux résolus, classé **CRITICAL par étendue**, avec liste plafonnée. Le graphe ne qualifie pas les appels implicites d’Expo ni tous les liens entre langages ; les nouveaux helpers publics ont un impact UNKNOWN. Les revues et tests ciblés complètent ces limites.

La comparaison historique à `main` a été tentée, mais des blobs manquent dans la copie partielle. Le refetch local a également échoué sur des objets promis absents. Cette comparaison reste **BLOQUÉE** et n’est pas transformée en résultat positif. Les défauts du graphe ne justifient aucune suppression de gate.

## Réception encore nécessaire

L’origine ONE de production n’est pas configurée : le mobile affiche cet état et conserve la communication native. Une URL HTTPS publiée et vérifiée est nécessaire pour ouvrir les outils web dans une distribution effective.

La fermeture du pont prouve son nettoyage local ; aucun reçu de fermeture distante n’est promis. Une fermeture perdue dépend encore des expirations et de la surveillance du lien. Wear Data Layer peut passer par les services Google selon les connexions disponibles ; ce transport n’est pas présenté comme exclusivement Bluetooth.

Appairage physique, livraison et présentation sur les deux montres, VoiceOver/TalkBack, braille, perception des vibrations, précision sonore en situation réelle et comportement des appareils verrouillés restent **NON TESTÉS**. Les APK debug et les builds simulateur ne constituent ni signature de production, ni admission en boutique, ni déploiement.

Ce lot ne raccorde aucun traducteur de langue des signes, ne transmet pas les notifications personnelles du système et ne fournit pas de consigne de traversée. Les observations sonores et leurs accusés restent distincts de ces capacités.

Responsabilité suivante : intégration/CI par le responsable de cette évolution ; qualification matérielle avec les appareils et les personnes concernées avant une promesse d’usage terrain.
