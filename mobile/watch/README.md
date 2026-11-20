# Relais natif d’accessibilité — PURAMA AI mobile

## État de qualification

**PARTIEL.** Les sources du module Expo local, des compagnons watchOS et Wear OS et du raccord à l’application mobile existante sont présentes. La génération Expo et la découverte du module par l’autolinking ont été exécutées. Les tests JavaScript et le contrôle TypeScript ont passé. Cela ne constitue pas une preuve de compilation native, d’installation, d’appairage ni de réception sur une montre physique.

Les preuves locales sont dans `../qa/watch-native/`. Le workflow `../../.github/workflows/mobile-native-watch.yml` doit compiler les applications et exécuter les tests de protocole Swift/Kotlin sur les runners GitHub avant de qualifier les binaires. Aucun résultat de compilation n’est déduit du prebuild. Les callbacks des adaptateurs WCSession/MessageClient et les interfaces des compagnons ont été relus ; leur comportement sur OS et matériel reste **NON TESTÉ** sans trace d’exécution correspondante.

## Propriétaire et raccord

Cette intégration appartient à **`purama-ai/mobile`**, l’application Expo existante. Elle conserve ses identités : iOS `dev.purama.purama-ai`, Android `dev.purama.purama_ai`. Elle ajoute un module local `modules/purama-accessibility-watch`, une cible watchOS intégrée à la cible iOS et un projet Wear lié au projet Android. Elle ne crée aucune application téléphone concurrente.

L’écran `/accessibility-watch` prépare une autorisation explicite, valable une minute et consommable une fois : appareil choisi et catégories de sons autorisées. Il ouvre ensuite `/accessible-one`. Cette route hôte ne charge que l’origine HTTPS exacte fournie à la compilation dans `EXPO_PUBLIC_ONE_ACCESSIBILITY_ORIGIN`, plus le chemin autorisé par le raccord. Aucune origine de production n’est inventée. Sans origine configurée ou sans module natif, les capacités correspondantes restent indisponibles.

Dans ONE, l’utilisateur choisit **« Connecter et partager les nouveaux sons »** ; le code de six chiffres doit correspondre sur les deux appareils. La montre demande un accord explicite et offre un choix de vibrations désactivé initialement. Le consentement à la session n’équivaut jamais à un reçu d’observation.

Le contrat public est celui de ONE `src/lib/accessibility/watch-native-bridge.ts` : une façade figée contenant exactement `version`, `subscribe`, `handshake`, `send`, `close`. Le module fournit cette façade à l’hôte mobile réel. Il ne l’installe pas dans un navigateur ordinaire et n’utilise pas une montre logicielle de remplacement. Expo Go ne peut pas fournir ce module local : il faut une compilation native de l’application existante.

## Données et garanties du protocole

Le raccord ONE actuel produit les **sept catégories sonores** affichées par l’écran de préparation : sonnette, voix possible, sirène, bruit de véhicule, klaxon, coups, sonnerie de téléphone. Les types image et indisponibilité système restent reconnus par le contrat partagé, mais ne sont pas proposés comme sources raccordées dans cet écran. Aucune notification d’une autre application n’est interceptée.

Les paquets transportent exclusivement une catégorie autorisée, des identifiants éphémères de session/appareil/livraison/événement, les horodatages, une durée restante et des preuves de fraîcheur. Les libellés présentés sur la montre proviennent d’une table fixe. Aucun audio, vidéo, transcription, message libre, localisation, direction ou ordre de traverser n’entre dans ce protocole. Les événements `simulation` sont refusés à la frontière JavaScript et dans les deux implémentations natives.

Le traitement sonore reste sur le téléphone. **Wear OS Data Layer ne garantit pas un trajet exclusivement Bluetooth** : les services Google choisissent le transport et peuvent utiliser leur réseau. `isNearby` limite les appareils disponibles ; ce n’est pas une preuve d’absence de transit réseau. Cette information est affichée avant le consentement téléphone et montre. Aucun serveur PURAMA, compte supplémentaire ou service cloud applicatif n’est ajouté par ce relais.

Les identités de pairs proviennent de l’OS. Android lie chaque session au `sourceNodeId` découvert pour l’application de même identité et signature. Le module ne fait pas confiance à un champ JSON `authenticated`. La cible Wear debug utilise la clé debug du téléphone généré ; une future distribution devra conserver une signature commune. Apple utilise uniquement la session WatchConnectivity de la montre appairée, installée et joignable. Les couples prévus sont iPhone/Apple Watch et Android/Wear OS ; aucun transport croisé iPhone/Wear OS n’est annoncé.

## Temps, annulation et reçus

Le JS du module lit **synchroniquement l’horloge monotone native avant la sérialisation et la mise en file Expo**. Swift et Kotlin retirent le temps de file du budget à leur entrée. Ils le bornent aussi par l’expiration murale initiale de l’événement. Une attente de 800 ms sur un budget de 1 000 ms ne laisse que 200 ms.

L’offre envoyée à la montre ne contient pas encore le contenu de l’observation. La montre demande une résolution munie d’un nonce. Le téléphone répond avec le budget encore valide. La montre retire de nouveau l’intégralité de son aller-retour local ; un aller-retour de cinq secondes ou un budget épuisé est refusé. Les horloges monotones locales incluent le sommeil de l’appareil. La synchronisation des horloges murales téléphone/montre n’est pas supposée.

Les annulations sont mémorisées même lorsqu’elles précèdent `submit` ou l’offre. Les tombstones de session empêchent un `hello` réordonné après `close` de réafficher une demande annulée pendant leur rétention bornée. Les mémoires sont plafonnées à 128 entrées, sans éviction d’entrées encore valides pour faire de la place ; une saturation ferme ou bloque la session. Les événements et livraisons sont dédoublonnés. Les callbacks asynchrones contrôlent la session complète ou sa génération avant d’agir, afin qu’un échec tardif de A ne ferme pas B.

Des défis ping/pong à nonce unique vérifient la présence du pair ; seul un pong correspondant reçu en moins de deux secondes renouvelle le délai. Un pair silencieux est fermé après six secondes. Une demande d’appairage dispose au maximum de 60 secondes ; ce délai ne prolonge aucun événement. Les timers téléphone s’arrêtent sans session et à l’arrière-plan. Aucune reprise automatique de session n’existe.

| Étape | Condition | Ce qu’elle ne prouve pas |
| --- | --- | --- |
| Mise en file native | API de transport appelée | Réception par la montre |
| `received` | Paquet frais et autorisé accepté par le compagnon | Présentation à l’écran |
| `displayed` | Texte de l’observation dans la zone visible, application active | Lecture ou compréhension humaine |
| `acknowledged` | Action explicite sur **« J’ai compris »** pour le texte encore frais et affiché | Qu’une vibration a été ressentie |

Les vibrations ne sont demandées qu’avec l’accord de cette session et pendant l’activité au premier plan. Aucun workout artificiel, service d’arrière-plan ou transfert différé ne contourne les règles de l’OS. Une montre inactive, verrouillée, déconnectée ou sans application ouverte ne reçoit pas de promesse d’alerte. Le téléphone reste le recours et les libellés restent des observations provisoires, sans consigne de déplacement.

`close` invalide immédiatement l’autorisation et le travail local de sa session ; le paquet de fermeture distant reste soumis au transport. Si ce paquet se perd, le compagnon arrête la session par son délai de présence. Aucun reçu de fermeture distante ou de vibration ressentie n’est fabriqué.

## Vérification reproductible

Les commandes suivantes utilisent le lock mobile existant. La génération doit se faire dans une copie isolée lorsque d’autres travaux utilisent le même arbre : Expo peut réécrire les scripts `ios` et `android` de `package.json` pendant le prebuild.

```sh
npm run test:watch-native
npm run typecheck
npx expo prebuild --no-install --platform all
node scripts/verify-watch-native-prebuild.cjs
npx expo-modules-autolinking resolve --platform android --json
npx expo-modules-autolinking resolve --platform apple --json
```

Le vérificateur contrôle la cible watchOS unique, ses deux sources réelles, les identités, la dépendance et l’incorporation à l’application iOS, l’enregistrement Wear et l’idempotence du plugin. Il enregistre les empreintes des sources. Il ne compile rien.

Le workflow natif exécute ensuite :

- Android : compilation debug du téléphone et du compagnon, puis tests JUnit du véritable `PhoneWatchProtocol` Kotlin.
- Apple : compilation et exécution du véritable protocole Swift avec un transport logiciel injecté, puis compilation watchOS et iOS pour simulateurs, sans signature de distribution.

Les harness Swift/Kotlin testent les budgets, expirations exactes, autorisations, rejet des simulations, annulation avant soumission, rejeu, saturation, défis de présence et rappels tardifs **au niveau du protocole**. Un `sendWire` substitué ne démontre pas l’exécution de WCSession ou MessageClient. Les artefacts CI conservent révision/arbre, journaux, résultats et empreintes des APK éventuels ; ils ne publient pas en boutique.

Restent à qualifier sur appareils réels : appairage et codes, présentation avec VoiceOver/TalkBack, action humaine, vibrations avec consentement, verrouillage/arrière-plan, perte réseau et reprise manuelle. Une compilation réussie ne suffira pas à marquer ces points PASS. L’origine ONE choisie devra aussi être disponible avec la version compatible avant une recette complète du parcours.

## Références officielles

- [Expo : ajouter du code natif à une application existante](https://docs.expo.dev/workflow/customizing/)
- [Apple : WatchConnectivity et WCSession](https://developer.apple.com/documentation/watchconnectivity/wcsession)
- [Apple : vibrations WatchKit](https://developer.apple.com/documentation/watchkit/wkinterfacedevice/play(_:))
- [Android : architecture du Wear OS Data Layer](https://developer.android.com/training/wearables/data/overview)
- [Android : messages du Data Layer](https://developer.android.com/training/wearables/data/messages)
- [Google : dépendance Play Services Wearable](https://developers.google.com/android/guides/setup)
- [GitHub : runners hébergés](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
