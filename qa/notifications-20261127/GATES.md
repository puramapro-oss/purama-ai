# Qualification ciblée — notifications IAO

## Identité et périmètre

- Dépôt : `puramapro-oss/purama-ai`.
- Base initiale des impacts : `6c8c1b8` ; avance vers `2720740` avant intégration ; branche isolée `fix/iao-notifications-20261127-b643`.
- Claim : `CHATGPT-IAO-NOTIFICATIONS-20261127-B643`.
- Produit du writer serveur : `supabase/functions/send-notification/index.ts` et helper commun `_shared/notification-action-url.ts`, qui réutilise `src/lib/safeNavigation.ts` inchangé.
- Extension coordonnée, writer root exclusif : `src/hooks/useNotifications.ts`, son test, `NotificationSettings`, `Notifications` et `NotificationCenter` ; les preuves client restent identifiées séparément.
- Recette navigateur : writer `inventory_iao` ; nouveau workflow isolé `notifications-quality.yml` : writer `inventory_remote`, sous coordination root.
- Recette : `tests/notifications/**` ; preuves : présent dossier ; compte rendu : `docs/qa/notifications-20261127.md`.
- Validation utilisateur : demande du 27 novembre de corriger et vérifier les erreurs des codes existants ; aucune nouvelle conception ni nouveau moteur de notification.
- Aucun envoi réel, aucune écriture de données de production, aucun secret réel dans les recettes et aucune modification de configuration de production.

## Critères d'acceptation observables

1. `POST` JSON authentifié reste le contrat d'envoi ; `OPTIONS` reste disponible. Les autres méthodes, les secrets absents/inexacts, les formats et tailles invalides échouent avant tout effet.
2. Les champs textuels/identifiants sont contrôlés avant les accès de données : type, présence, bornes et contenu. JSON mal formé/UTF-8 invalide => 400 ; corps > 32 Kio => 413 ; délai de lecture => 408. Pas de données du corps dans les erreurs.
3. Le profil est un indice de routage mutable ; le destinataire email provient de `auth.admin.getUserById` et doit posséder une confirmation email. `user_email` explicite doit correspondre à cette adresse canonique. Le profil sans email conserve uniquement son canal in-app, et les erreurs de lecture d'identité bloquent avant les effets.
4. Une erreur de lecture des préférences, ou des préférences non interprétables, bloque avant insertion. Une absence de ligne confirmée conserve les défauts historiques ; les refus du type ou du canal email restent respectés.
5. Titre, message, libellé d'agent et lien sont échappés dans le HTML. Les chemins absolus locaux et les URL HTTPS légitimes restent utilisables ; les schémas actifs, les URL avec identifiants, les doubles slashs, antislashs et caractères de contrôle sont refusés. `action_url: null`, comme un champ omis, signifie absence de lien.
6. Une notification en base réussie n'est pas annoncée avant un reçu d'insertion valide. Une erreur d'email n'entraîne pas une seconde insertion ni une réponse invitant implicitement à rejouer l'effet déjà réalisé ; l'acceptation email ne prétend pas démontrer la livraison au destinataire.
7. Réponses et logs n'exposent ni contenu privé, ni adresse de destinataire, ni détails fournisseur. Aucune relance automatique n'est ajoutée.
8. Les tests exécutent l'entrée produit réelle et ses helpers partagés ; seuls Supabase, Resend et les ports d'horloge/réseau sont inertes. Les appels externes sont bloqués et comptés.
9. Avant modification du produit : impacts GitNexus frais et revue manuelle de la frontière. Avant commit : `detect_changes`, revue de diff et preuves rattachées aux SHA-256.
10. Extension client : tester les hooks avec React et QueryClient réels, reproduire les anciens défauts, vérifier lint/typecheck/build et les parcours dans un navigateur réel. Les événements d'un ancien compte, les mutations sans reçu et les URL historiques dangereuses ne doivent pas produire de succès visible. Une erreur de chargement ne doit pas devenir une fausse liste vide ni des préférences faussement activées ; le retry doit récupérer les données.

## Résultats reçus et dernière réception attendue

État du 27 novembre 2026 : CI reçue sur `6933f90`, avant publication des
microcorrectifs du footer email et de la disposition mobile des préférences.

| Gate | Statut | Preuve et portée |
| --- | --- | --- |
| Régression initiale serveur | **PASS pour la reproduction** : 17 réussites, 89 échecs sur 106 cas | `before.json` et `before.tap`, sources initiales identifiées |
| Handler après correction du footer + helper URL, Node 24.22.3 | **PASS 163/163** | `server-footer-final.json` et `server-footer-final.tap`, fournisseurs inertes |
| Helpers partagés inchangés | **PASS 43/43** | `shared-regression.json` |
| Deno natif, types actifs | **PASS 26/26 avant le footer** | `native/native-reception-v3/` et `ci-45941476133/native.log` ; nouvelle head attendue en CI |
| Lint serveur | **PASS** | `lint-server-final.json` initial, puis `server-footer-final.lint.json` sur le handler modifié, zéro avertissement |
| Hook React / QueryClient | **PASS 36/36** | `client-final.json`, cas inclus dans la suite frontend |
| Suite frontend après corrections des erreurs UI | **PASS 954/954** | `frontend-ui-unit-final-receipt.json`, avant le dernier ajustement mobile ; inclut les 36 tests précédents |
| Contre-épreuves UI React / jsdom | **PASS 3/3** | `browser-dom-before.json` et `browser-dom-after.json`, pas un navigateur |
| TypeScript, lint client, build Vite | **PASS** | Réception initiale, puis `lint-layout-final.json` et `build-layout-final.json` après l'ajustement mobile |
| Browser local | **BLOQUÉ**, zéro scénario exécuté | Binaire indisponible puis téléchargement unique HTTP 403 ; reçus conservés |
| CI `6933f90`, Node / Deno / hook / navigateur | **PASS 206/206, 26/26, 36/36, 12/12** | `ci-45941476133/`, arbre testé identique à la head, empreintes vérifiées ; 206 = 163 + 43 |
| Revue des cinq captures navigateur | **4 PASS, 1 défaut mobile corrigé** | `visual-review-first.json`, rétrécissement des icônes et espacement corrigés par root ; nouvelle capture attendue |
| CI après footer et ajustement mobile | **NON TESTÉ à cet état** | Exécution à recevoir sur la prochaine head exacte, sans attribuer les reçus antérieurs aux nouveaux deltas |
| GitNexus avant édition | **PASS** | Impacts dans `gitnexus/`, revue manuelle HIGH, hook CRITICAL |
| GitNexus final, index Git préparé | **PASS pour l'exécution**, risque **HIGH**, 45 symboles / 9 flux | `gitnexus/detect-staged.json`, liste complète ; revue d'intégration root |
| GitNexus comparé à `main` | **PARTIEL**, risque **CRITICAL**, 28 057 symboles / 740 flux | Résumé reçu ; liste des symboles plafonnée à 1 000 malgré une demande de 30 000, limite du backend conservée dans les reçus |
| Espacements code / documentation | **PASS** | Contrôle final hors journaux et TAP bruts pour conserver exactement les preuves |
| Production Edge / SQL / Auth / Realtime / email | **NON TESTÉ** | Aucun déploiement, envoi réel ou accès de données de production dans ce lot |

Les comptes décrivent des périmètres et runtimes différents ; ils ne se somment
pas pour produire un nombre de défauts corrigés ou de fonctionnalités livrées.
La comparaison GitNexus à `main` couvre toute la divergence de branche, et ne
doit pas être présentée comme l'impact des seules notifications.

## Commandes exécutées

```sh
node --experimental-vm-modules --test --test-reporter=tap --test-concurrency=1 tests/notifications/action-url.test.mjs tests/notifications/handler.test.mjs
node --test --test-reporter=tap supabase/functions/_shared/request-body.test.ts supabase/functions/_shared/webhook-security.test.ts
git diff --cached --check -- . ':!qa/notifications-20261127/**/*.log' ':!qa/notifications-20261127/*.log' ':!qa/notifications-20261127/*.tap'
```

La qualification Deno hors réseau a été exécutée sur le runtime existant :
**26 cas PASS avant la modification du footer**, contrôle de types actif, réseau et
sous-processus interdits. Un premier refus de typage des tableaux de fixture
est conservé ; JSDoc a corrigé les types sans modifier le produit ni désactiver
un contrôle. La réception v2 qualifiait 25 cas, la v3 ajoute la compatibilité
explicite `action_url: null`. Les trois tentatives restent dans
`native/native-reception-v1/`, `native/native-reception-v2/` et
`native/native-reception-v3/`, avec leurs manifestes d'empreintes.

```sh
deno test --no-remote --no-npm --no-prompt --deny-net --deny-run --allow-env=WEBHOOK_SECRET,SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,RESEND_API_KEY --config tests/notifications/deno.json tests/notifications/runtime.ts
```

La CI isolée sur `6933f90` est reçue dans `ci-45941476133/` et disponible au
[run 45941476133](https://github.com/puramapro-oss/purama-ai/actions/runs/45941476133).
Le footer email pointe désormais vers la route existante
`https://purama-ai.purama.dev/notification-settings`. Les tests Node existants et
le lint du handler ont été rejoués ; les anciens reçus restent inchangés.
La nouvelle CI devra qualifier le Deno exact de ce handler et recevoir la
capture mobile après le correctif de disposition effectué par root. Aucun
rejeu Mac ni test miroir supplémentaire n'est nécessaire pour ce lien statique.
Les 12 scénarios et leurs instructions sont dans
`tests/notifications/browser/README.md`. Les archives de bundles intermédiaires
restent des preuves locales ; elles ne font pas partie du code à committer.

## Limites à maintenir

Les doubles ne prouvent pas le déploiement Edge, les migrations, les politiques
SQL, la livraison email, la réception Realtime réelle ni l'idempotence entre
requêtes répétées. Les cinq secondes bornent le corps d'entrée, sans nouvelle
politique globale de durée pour DB/Auth/Resend. L'annulation empêche les effets
supplémentaires avant leur lancement ; elle ne prouve pas l'annulation d'un effet
distant déjà lancé. Ce lot corrige le handler et ses consommateurs existants
sans créer de stockage ou de moteur de notification parallèle. Les autres agents
restent propriétaires des intégrations et workflows en cours.
