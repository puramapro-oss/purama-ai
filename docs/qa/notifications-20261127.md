# IAO — qualification des notifications, 27 novembre 2026

## Portée et résultat

**PASS pour les contrôles serveur, les tests client et les contre-épreuves DOM
exécutés ; PARTIEL pour la réception complète, en attente du navigateur réel.**
Le lot part de `6c8c1b8` dans `fix/iao-notifications-20261127-b643`, puis reçoit
la base `2720740` avant intégration. Il conserve
le service `send-notification`, son schéma `purama_ai`, ses quatre types de
notification, sa présentation email et ses préférences existantes. Il ne crée
aucun nouveau moteur, magasin de données, contrat de paiement ou envoi réel.

L'exécution initiale du handler a donné **17 réussites et 89 échecs sur 106
tests**, dont les valeurs de mauvais type acceptées, les préférences ignorées
après une erreur de lecture, l'adresse email non rapprochée de l'identité, les
valeurs HTML non échappées et la divulgation de détails. Les résultats initiaux
sont conservés dans `qa/notifications-20261127/before.tap` et `before.json` avec
les empreintes des sources testées. La suite finale a été enrichie pour couvrir
l'autorité Auth, l'annulation et la navigation partagée ; les comptes avant et
après ne doivent pas être additionnés.

| Contrôle exécuté | Résultat observé | Portée |
| --- | --- | --- |
| Handler réel + helper de navigation sous Node 24.22.3 | **163/163 PASS**, aucun échec, skip, annulation ou todo | Supabase et Resend doublés, réseau interdit dans la VM |
| Helpers partagés inchangés, lecture du corps et secret webhook | **43/43 PASS** | Régression des contrôles réellement réutilisés |
| ESLint des sept fichiers serveur nommés dans le reçu | **PASS**, zéro avertissement | Commande avec `--max-warnings 0` |
| Diff de code et documentation | **PASS** | Contrôle des espacements ; journaux et TAP bruts exclus du contrôle final pour préserver les preuves |
| Runtime Deno natif 2.9.7, réception v3 | **26/26 PASS**, contrôle de types actif | `--no-remote --no-npm --deny-net --deny-run`, modules fournisseurs remplacés par des doubles locaux |
| Suite frontend finale après les corrections UI | **954/954 PASS**, aucun test en attente | Inclut les **36 tests du hook** avec React et QueryClient réels ; ne pas additionner ces deux nombres |
| Trois contre-épreuves des écrans Settings, Notifications et Center | **3/3 PASS** | Composants React réels dans jsdom 26.1.0 ; contrôle du DOM, sans moteur navigateur |
| TypeScript frontend, lint des cinq fichiers client, build Vite | **PASS** | Reçus associés aux empreintes finales des sources |
| Recette de 12 scénarios dans un navigateur réel | **NON TESTÉ** | Lancement local bloqué avant tout scénario ; CI dédiée préparée, sans exécution reçue |
| Production SQL / Auth / Realtime / email | **NON TESTÉ** | Aucun effet distant ni déploiement réalisé dans cette qualification |

Les commandes, sorties et empreintes finales se trouvent dans
`qa/notifications-20261127/server-final.json`, `server-final.tap`, `lint-server-final.json` et
`shared-regression.json`. Les doubles n'ouvrent aucun socket, ne possèdent aucun
secret réel et capturent chaque tentative d'insertion ou d'email.

Le contrôle Deno a d'abord refusé le typage de deux accès à un tableau de fixture
inféré `never[]` ; aucun test n'avait alors démarré. Les types du double ont été
explicités par JSDoc, sans modifier le produit et sans désactiver le contrôle de
types. La seconde exécution a passé les 25 cas. La troisième a passé **26 cas
sur le handler final**, y compris la compatibilité `action_url: null`. Les trois
tentatives et leurs manifestes restent dans
`qa/notifications-20261127/native/native-reception-v1/`, `native-reception-v2/`
et `native-reception-v3/`. Ces cas éprouvent le même contrat dans le runtime
natif ; ils ne représentent pas des fonctionnalités supplémentaires ni des
emails réellement envoyés. Le manifeste v3 correspond au handler SHA-256
`8fd7ca9d8d09a40cae897bd13b920d91bf200127723d192198ee9021f2e10045`
et à la recette native
`b1796cc5da7be4bda157f9915c093542d7fe42566f963084bdd7794e2a85951b`.

Les résultats client finaux sont dans `client-final.json` et
`frontend-ui-unit-final-receipt.json`, avec la sortie complète
`frontend-ui-unit-final.json`. Les reçus `typecheck-ui-final.json`,
`lint-ui-final.json` et `build-final.json` qualifient les sources après les
corrections d'affichage. Le reçu `lint-server-final.json` nomme précisément
les sept fichiers serveur contrôlés et n'inclut pas la recette navigateur.

## Changements vérifiés

Le handler accepte `POST` JSON authentifié par le même secret webhook et
conserve `OPTIONS`. Les méthodes incorrectes, l'entrée mal formée, les caractères
de contrôle et les mauvais types sont refusés avant les effets. Le lecteur
`readRequestText` existant impose 32 Kio UTF-8 et cinq secondes pour le corps de
la requête. Les bornes titre 300, message 5 000, libellé d'agent 100 et URL
2 048 caractères sont des limites techniques de ce correctif, pas des conditions
commerciales antérieures. Les caractères Unicode et les messages multilignes
valides restent acceptés.

Le profil modifiable sert à retrouver l'identité. Lorsqu'un email est prévu,
son adresse provient de `auth.admin.getUserById` et possède une confirmation
email valide. Une adresse fournie explicitement doit correspondre à cette
adresse canonique. Un profil sans email conserve uniquement son canal in-app ;
un email Auth absent ou non confirmé ne déclenche aucun email. Les erreurs de
lecture de l'identité ou des préférences bloquent avant insertion. Les flags SQL
`NULL` et l'absence confirmée de ligne conservent les défauts historiques ; un
refus explicite reste prioritaire.

Le helper `notification-action-url.ts` réutilise `safeInternalPath` pour les
chemins internes, y compris les variantes encodées, et conserve les liens HTTPS
externes explicites sans identifiants ni caractères dangereux. Le même résultat
validé est stocké pour la navigation client. Le titre, le message, le libellé
d'agent et le lien sont échappés dans le HTML ; le texte de la notification en
base garde son contenu normal. La compatibilité avec `action_url: null` est
conservée : cette valeur explicite représente l'absence de lien, comme un champ
omis. La contre-épreuve `before-null-url.json` a reproduit le refus excessif avant
correction ; le cas supplémentaire passe ensuite dans les 163 tests Node. Les
autres champs d'identité n'ont pas reçu cette exception.

Le client DB désactive les reprises automatiques (`db.retry: false`). Une réponse
de création n'est produite qu'après un reçu d'insertion valide. Un échec ou une
réponse perdue du prestataire email conserve cette unique insertion sans la
rejouer. `email_sent: true` indique une acceptation avec reçu du prestataire ;
aucune preuve de livraison au destinataire n'est annoncée. Une absence de reçu
reste une acceptation non confirmée, pas une preuve de refus.

La revue indépendante a reproduit un effet après annulation pendant la lecture
du profil. La correction vérifie maintenant l'annulation après les lectures et
avant insertion : résultat 408 sans effet. Si l'insertion a déjà réussi, son
reçu est conservé et l'email supplémentaire est arrêté. Quatre régressions
couvrent ces frontières. Les réponses et logs n'exposent ni contenu utilisateur,
ni adresse email, ni détail fournisseur.

## Changements client et réception des écrans

Le hook écoute désormais le schéma `purama_ai` utilisé par le client et le
handler. Les lectures, événements, mutations et retours asynchrones sont liés
au compte qui les a lancés. Un changement de compte, y compris A → B → A,
ne réaffiche pas les données ou les toasts privés d'une ancienne session.
Les événements étrangers sont ignorés et les liens historiques passent par
le même helper de navigation que les nouvelles notifications.

Les mutations de lecture/suppression exigent un reçu cohérent avec le
propriétaire ; le marquage global annonce le nombre réellement confirmé.
Les préférences sont enregistrées par un upsert atomique limité aux cinq flags
booléens. Les erreurs et réponses mal formées ne sont plus interprétées comme
un succès. Les colonnes SQL nullables conservent leur compatibilité prévue.

La contre-épreuve des trois consommateurs a retrouvé des erreurs de chargement
présentées comme des listes vides ou des préférences activées par défaut.
Les écrans affichent maintenant leurs états de chargement et d'erreur, et une
action **Réessayer**. Les preuves `browser-dom-before.json` et
`browser-dom-after.json` montrent, sur les composants réels, l'erreur explicite,
l'absence de switches faussement activés puis la récupération des données et
des valeurs `false` après le retry. Le résultat **3/3 PASS** vient de React et
jsdom ; il ne qualifie ni le rendu visuel ni un moteur navigateur.

La recette navigateur reproductible est décrite dans
`tests/notifications/browser/README.md`. Le lancement local s'est arrêté avant
le premier scénario, faute de binaire disponible ; l'unique téléchargement
tenté a été refusé avec HTTP 403. Les reçus `browser-local-attempt/results.json`
et `browser-install-attempt.log` conservent ces échecs d'environnement. Le nouveau
workflow isolé `.github/workflows/notifications-quality.yml` est préparé pour
exécuter les contrôles et les 12 scénarios. **Sa réception CI et les captures
navigateur restent à obtenir** ; aucun ancien reçu d'un autre lot ne les remplace.

## Impact, coordination et limites

Les analyses GitNexus avant édition sont conservées dans
`qa/notifications-20261127/gitnexus/`. `generateEmailHtml` est classé LOW avec un
appelant direct ; le handler anonyme n'est pas un symbole nommé du graphe.
La revue manuelle a traité cette frontière comme **HIGH** pour l'identité et la
vie privée. Le changement du hook client est **CRITICAL** dans son graphe de
dépendances et a été attribué au writer root, avec les trois consommateurs UI.
Les régressions locales de ce périmètre sont maintenant reçues. Le contrôle
final `detect_changes` de l'index Git préparé est reçu : **HIGH**, 45 symboles,
9 flux, avec une liste complète dans `gitnexus/detect-staged.json`. La comparaison
à `main` est **CRITICAL** : 3 712 fichiers, 28 057 symboles et 740 flux. Elle porte
sur la divergence totale à cette référence, pas uniquement sur ce correctif.
Son résumé est reçu mais la liste des symboles est **PARTIELLE**, plafonnée à
1 000 par le backend même après une demande de 30 000 ; le reçu conserve cette
limite dans `detect-main.json` et `detect-structured-command-receipt.json`.
La revue d'intégration appartient à root. La réception du navigateur en CI sera
enregistrée séparément après son exécution ; ce document ne la présente pas
comme acquise.

Les journaux et fichiers TAP conservent volontairement leurs espaces d'origine,
y compris ceux des échecs initiaux. Le contrôle final des espacements exclut
ces sorties brutes, sans les normaliser :

```sh
git diff --cached --check -- . ':!qa/notifications-20261127/**/*.log' ':!qa/notifications-20261127/*.log' ':!qa/notifications-20261127/*.tap'
```

**NON TESTÉS par ces doubles :** déploiement Edge, disponibilité des tables et
politiques SQL réelles, réception Realtime, conformité de la configuration de
production, acceptation par Resend réel et livraison email. La recette ne prouve
pas une idempotence durable entre plusieurs requêtes indépendantes. Le délai de
cinq secondes concerne le corps d'entrée ; les appels DB/Auth/email ne reçoivent
pas ici une nouvelle politique globale de durée ou de reprise. Une requête
annulée après le départ d'une écriture ou d'un email ne démontre pas l'absence
d'effet distant. Ces limites ne sont pas remplacées par un résultat de compilation.
