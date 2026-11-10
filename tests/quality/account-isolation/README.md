# Isolation des comptes, ressources et conversations

Cette suite exécute les composants et hooks de production dans Chromium réel, avec React 18 et le vrai QueryClient de l’application. Les services, l’authentification, le microphone et la synthèse vocale sont remplacés par des réponses contrôlées ; aucun compte réel, enregistrement audio, paiement ou appel fournisseur n’est utilisé. Toute requête réseau hors du serveur de test local est bloquée.

## Exécution

Depuis la racine du dépôt, avec les dépendances déjà installées :

```sh
PLAYWRIGHT_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
ACCOUNT_ISOLATION_EVIDENCE='/tmp/iao-account-isolation-results' \
node tests/quality/account-isolation/run.mjs "$PWD"
```

`PLAYWRIGHT_EXECUTABLE_PATH` est facultatif si Chromium est déjà disponible pour Playwright. Le script utilise `esbuild` et `@playwright/test` du dépôt source. Il ne lance aucune installation. `ACCOUNT_ISOLATION_FILTER` peut sélectionner un sous-ensemble par expression régulière pour une reproduction ciblée ; la qualification finale utilise la suite complète sans filtre.

Les délais du harnais sont bornés : 30 secondes pour la navigation locale, 6 secondes pour les opérations et les attentes métier (5 secondes pour les attentes Playwright `expect`). Le délai de navigation a été augmenté après un essai partiel sous contention de la machine ; ce test n’est pas une mesure de performance du produit. Un résultat partiel est sauvegardé après chaque scénario.

La réussite requiert les **25 scénarios PASS**, aucune exception de page, aucun accès externe et des empreintes des sources identiques avant/après. Le script produit `results.json` et renvoie un code non nul si un scénario échoue. Les chemins de preuve doivent rester hors du dépôt pendant une vérification ordinaire.

## Couverture

| Zone | Vérifications |
| --- | --- |
| ProtectedRoute réel | Réinitialisation lors du changement de compte ou de chemin de ressource ; conservation lors du rafraîchissement du même compte et d’un changement de query string. |
| PartnerAgentEmails | Une réponse tardive du compte A ne remplace pas les courriels de B. |
| ComptaAgentSettings | Les paramètres de A disparaissent pendant le chargement de B ; une sauvegarde légitime de B utilise ses propres paramètres. |
| ExecutionCounter | Ancien compteur masqué, rechargement sur changement d’adresse, montage anonyme et déconnexion sans crash. |
| useVoice | Réponses et sauvegardes périmées ignorées, cycle A→B→A, sauvegarde courante valide, TTS tardif après départ/démontage, libération du microphone acquis tardivement, révocation des URL audio et exclusion d’un second enregistrement pendant une transcription. |
| Conversations | Historique tardif d’une ancienne session ignoré, historique courant masqué au changement de session, réponse tardive sans requête de suivi après départ du compte, historique initial sans écrasement du message optimiste. |
| CreatorAgentDetail | Navigation dynamique vers un nouvel agent, suppression ancienne sans redirection de la nouvelle page, absence/erreur de chargement terminées avec reprise ou retour. |
| Hooks KARTA Creator réels | Trois caches liés à l’identité, aucune donnée A rendue dans B, invalidation liée au propriétaire de l’écriture initiale et sauvegarde courante de B encore fonctionnelle. |

## Invariants du correctif

`useRequestScope(key)` renvoie une fonction de capture. Un handler capture `const isCurrent = captureScope()` **avant** tout `await` et vérifie ensuite ce prédicat avant un changement d’état, un toast ou une requête supplémentaire. Le jeton est invalidé au démontage et à chaque changement de clé, y compris un cycle A→B→A. `useScopedState` masque immédiatement une valeur qui appartient à une autre clé ; il ne dispense pas les handlers asynchrones du contrôle de jeton.

La clé de ProtectedRoute contient `user.id` et `location.pathname`. Les callbacks vocaux portent leur propre génération pour rester sûrs même hors du sous-arbre protégé. Les historiques portent en plus un numéro de révision afin de ne pas remplacer un envoi démarré depuis leur lecture. Les clés de cache Creator portent `userId`, l’agent et la limite lorsqu’elle existe ; la fin d’une mutation invalide le propriétaire enregistré par cette mutation.

Ces gardes empêchent des effets UI et des requêtes de suivi obsolètes. Elles ne peuvent pas annuler une écriture déjà acceptée côté serveur ; l’autorisation serveur/RLS reste indispensable. La suite ne qualifie pas le backend de production, les permissions réelles du microphone, les fournisseurs audio, l’authentification Supabase ni le déploiement.

## Preuves avant/après

Les fichiers sous `evidence/` conservent les résultats et empreintes de la qualification isolée. Les six reproductions initiales sont des symptômes inclus dans les scénarios de cette suite, pas six tests supplémentaires à additionner au total final. Le premier essai de la suite corrigée comportait un sélecteur erroné (`Nouveau` au lieu de `Nouvelle`) : cet essai est conservé comme limite du harnais, puis le scénario a été correctement reproduit contre la source originale. Les preuves rouges ne doivent pas être interprétées comme une réussite du produit.
