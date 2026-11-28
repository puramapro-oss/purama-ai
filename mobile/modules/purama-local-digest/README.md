# PURAMA Local Digest

Primitive SHA-256 native incrémentale pour le vérificateur de pack existant. Le module
ne lit aucun fichier, ne télécharge rien et ne crée aucune tâche asynchrone.

`getPuramaLocalDigestModule()` recherche le module Expo uniquement à l'appel, dans le
registre JSI public initialisé par `expo-modules-core`. Il renvoie `null` uniquement si
le module est absent d'un registre valide. Un registre indisponible, un constructeur
manquant ou une exception d'accès restent des erreurs. Le helper Expo
`requireOptionalNativeModule` n'est pas utilisé : en SDK 54, il peut convertir une erreur
de recherche en `null`. Le constructeur `PuramaLocalDigest.Sha256Digest` crée un
`SharedObject`. L'entrée web déclare explicitement l'absence native, sans importer Expo.
L'import public `SharedObject` est utilisé par un garde de type au runtime ; il ne dépend
donc pas de la conservation d'un import à seul effet de bord lors de l'optimisation du bundle.

## Contrat

- `update(Uint8Array)` consomme la vue synchronement, avec un maximum de 262 144 octets.
  Les autres types de tableaux sont refusés. Les vues avec un décalage utilisent leurs
  propres octets ; aucun pointeur ou tableau reçu n'est conservé après l'appel.
- `digestHex()` produit exactement 64 caractères hexadécimaux minuscules et ferme le
  contexte. Tout nouvel `update` ou `digestHex` est refusé.
- `destroy()` ferme le contexte et peut être répété. `release()` est fourni par Expo ;
  après libération du `SharedObject`, aucune méthode native ne doit être appelée.
- Le nettoyage explicite doit toujours être exécuté en préservant la première erreur.
  Le hook natif de libération ferme aussi le contexte abandonné. L'état cryptographique
  est de taille constante.
- Les méthodes restent synchrones et le thread JavaScript est occupé pendant un bloc.
  Le contrôleur existant conserve ses points d'annulation et ses interruptions UI.

Android utilise `java.security.MessageDigest` ; iOS utilise CommonCrypto. Aucun moteur
cryptographique ou framework de pont supplémentaire n'est ajouté. Les réglages Android
sont hérités du projet Expo ; la cible iOS 15.1 et Swift 5.9 suivent le module local existant.

## Vérification

Les tests des cœurs utilisent des vecteurs connus, des découpages multiples, les limites
de blocs, des vues entourées de sentinelles, des octets binaires, les transitions d'état
et des contextes entrelacés. Ils compilent dans un répertoire temporaire nettoyé à la fin.

```sh
bash tests/run-core-tests.sh --java
bash tests/run-core-tests.sh --swift
node --test tests/module-contract.test.cjs
```

Sans argument, le script exécute Java puis Swift. Le test Swift requiert un SDK Apple
fournissant CommonCrypto. Les variables `DIGEST_JAVAC_BIN`, `DIGEST_JAVA_BIN` et
`DIGEST_SWIFTC_BIN` peuvent sélectionner des outils déjà installés. Une commande indisponible
fait échouer le test demandé ; aucun test natif n'est remplacé par une simulation.
Le SDK macOS est résolu par `xcrun`, ou fourni explicitement par `DIGEST_SWIFT_SDK`, pour
que l'appel direct au compilateur puisse trouver les bibliothèques standard du SDK installé.

Les neuf tests JavaScript exécutent les véritables points d'entrée et des getters de
registre JavaScript ; seule l'initialisation native d'Expo est simulée. Ils couvrent aussi
les getters qui lancent une erreur et l'absence native explicite sur web.
Les tests des cœurs ne prouvent pas la compilation des bindings Expo ni leur exécution
dans Hermes. La réception native doit vérifier séparément le module lié à l'application,
les vues `Uint8Array.subarray()`, le refus des autres TypedArray, la libération réelle,
le hachage du modèle épinglé et la durée des blocs sur appareil.

### Qualification du digest dans Hermes sur simulateur iOS

Le harnais `mobile/lib/iao-digest-qualification.ts` réutilise la route de qualification
existante et le module de production. Il requiert le flag de build exact
`EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION=1`, un UUID de campagne sous
`EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION_RUN_ID` et le commit complet sous
`EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION_COMMIT`. L'activation simultanée du harnais
hors ligne Android est refusée. Un build normal n'importe pas cette fixture depuis
la route, et le harnais refuse les flags ou identités invalides avant tout import natif
ou fichier.

La fixture exige iOS, Hermes et un bundle `main.jsbundle` embarqué dans l'application.
Elle vérifie les vecteurs vide, `abc`, bloc maximal et million d'octets, les vues décalées,
la consommation synchrone des données, les transitions d'état et les nettoyages.
Les types incompatibles sont soumis directement à la méthode native `update()` : le garde de
l'adaptateur JavaScript ne peut pas masquer un défaut de conversion Expo. Le harnais
contrôle également l'adaptateur réellement utilisé par le vérificateur de pack.

Le contrat JSON `mobile/lib/iao-digest-qualification-contract.json` définit le fichier
de reçu et les quinze contrôles obligatoires. Le script hôte reçoit le fichier dans le
conteneur du simulateur jetable et rapproche la campagne et le commit du bundle
construit. Il sélectionne le runtime correspondant au SDK inscrit dans l'application
compilée, puis un iPhone déclaré compatible par ce runtime. L'absence de cette cible
fait échouer la qualification. Les lectures des conteneurs et le nettoyage sont bornés ;
une lecture d'inventaire défaillante conserve sa première erreur et permet encore une
tentative d'arrêt du seul UUID créé par la campagne, avant suppression et vérification.
La fixture écrit et relit un temporaire dans le même dossier avant son
déplacement vers le nom final ; elle refuse d'écraser un reçu existant. Un résultat
de compilation, un reçu ancien, une exécution Metro ou un résultat
partiel ne valent pas qualification native. Les tests Node du harnais simulent les
frontières natives et de fichiers ; leurs résultats restent distincts du reçu réel iOS.

Cette qualification porte sur le module digest et son adaptateur dans le simulateur.
Elle n'exécute ni le modèle, ni SMARANA, ni l'appairage watchOS, et ne mesure pas les
performances d'un appareil physique. La libération explicite est exercée, sans appel
natif après `release()` ; elle ne prouve pas l'absence de fuite mémoire ou le calendrier
du ramasse-miettes.

## API de référence

La compatibilité vise Expo SDK 54 : `Class`, `SharedObject`, `sharedObjectDidRelease`,
`TypedArray.toDirectBuffer()` et `TypedArray.rawPointer`. Dans ce SDK, le pointeur de la
vue applique déjà `byteOffset` ; il ne faut jamais appliquer ce décalage une seconde fois.

- [SharedObject Android](https://github.com/expo/expo/blob/sdk-54/packages/expo-modules-core/android/src/main/java/expo/modules/kotlin/sharedobjects/SharedObject.kt)
- [SharedObject iOS](https://github.com/expo/expo/blob/sdk-54/packages/expo-modules-core/ios/Core/SharedObjects/SharedObject.swift)
- [Registre JSI public](https://github.com/expo/expo/blob/sdk-54/packages/expo-modules-core/src/ts-declarations/global.ts)
- [Recherche Expo SDK 54](https://github.com/expo/expo/blob/sdk-54/packages/expo-modules-core/src/requireNativeModule.ts)
- [TypedArray commun](https://github.com/expo/expo/blob/sdk-54/packages/expo-modules-core/common/cpp/TypedArray.cpp)
- [Conversion ByteBuffer Android](https://github.com/expo/expo/blob/sdk-54/packages/expo-modules-core/android/src/main/cpp/JavaScriptTypedArray.cpp)
- [CommonCrypto SHA-256](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/CC_SHA256.3cc.html)
