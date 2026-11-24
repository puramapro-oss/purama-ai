# Réception du SDK web Supabase — 24 novembre 2026

La première CI de la PR108, au commit `2dc63a47c189e8b18cf8d05db551ef95f3057f64`, a reçu les suites serveur, site et concurrence, mais a échoué sur trois parcours Firefox. L'erreur non interceptée provient de l'initialisation du client réel Supabase 2.91.0 : acquisition immédiate du verrou navigateur `lock:sb-supabase-auth-token`. Les assertions métier avaient terminé ; l'assertion stricte d'absence de `pageerror` a correctement refusé la réception. Les preuves de cet échec sont conservées dans `../ci-first-attempt/`.

## Correction et portée

Le paquet web racine `@supabase/supabase-js` est fixé à **2.119.2**, avec ses six composants alignés dans le verrou de dépendances. Le client produit et ses options d'authentification restent identiques : persistance de session et rafraîchissement automatique actifs, aucun verrou personnalisé. Les dépendances KARTA et mobile ne sont pas modifiées. Cette version exige Node22 au minimum ; les jobs concernés utilisent Node22.

La migration officielle du SDK explique le remplacement de la coordination fondée sur les verrous navigateur et la protection contre les réponses de rafraîchissement devenues périmées. La réception vérifie directement le client produit avec trois scénarios : initialisation sans session et lectures concurrentes, reprise d'une session synthétique puis déconnexion, réponse de rafraîchissement tardive après déconnexion. Ils sont sélectionnés sur les cinq profils existants de la matrice navigateur. Aucun résultat de cette simulation ne certifie une session de production ou la version effective du serveur GoTrue.

Sources primaires : [version Supabase2.119.2](https://github.com/supabase/supabase-js/releases/tag/v2.119.2), [guide officiel de migration sans verrou](https://github.com/supabase/supabase-js/blob/master/packages/core/auth-js/migrations/lockless-coordination.md). Les chemins de source du paquet installé et les versions sont également conservés dans les preuves locales.

## Réceptions locales et incidents conservés

- Suite web complète : **646/646 tests**, 33 fichiers. Typage de l'application réussi en exécution séquentielle avec mémoire bornée ; la première tentative parallèle arrêtée avec le code137 reste consignée.
- Audit npm : **3 signalements faibles**, aucun modéré, élevé ou critique. Le code de sortie de l'audit reflète ces signalements faibles ; il n'est pas présenté comme une absence totale de signalement.
- Réception native2 : un ancien cache Vite contenait encore le SDK2.91.0 malgré la résolution du paquet2.119.2 dans l'overlay privé. Cette exécution n'est **pas** une qualification du nouveau SDK. Le test du rafraîchissement tardif a exposé cette incohérence.
- Réception native3 : le bundle Vite réellement chargé contient quatre occurrences2.119.2, aucune2.91.0, et la protection `AuthRefreshDiscardedError`. Les trois nouveaux tests SDK passent. La suite complète compte **58/59 réussites** ; un scénario de réconciliation simulait une lecture503 suivie d'une réponse suspendue, désormais consommée par une reprise automatique du SDK. Ce cycle du simulateur est documenté et corrigé sans modification des garanties métier ni allongement arbitraire du délai.

- **Réception native4 finale : 59/59 réussites**, soit 5 Atelier et54 chat, aucune reprise de test, aucun cas ignoré ou instable. Les18 fichiers candidats concordent avec leurs empreintes locales, les452 fichiers suivis sont inchangés pendant la réception, le bundle chargé est attesté2.119.2. Les59 reçus réseau de page comptent zéro requête externe transmise et zéro requête inattendue. La réception CI avec le verrou exact reste distincte.

Les reprises automatiques PostgREST2.119.2 concernent uniquement les méthodes idempotentes GET, HEAD et OPTIONS. Un POST d'enregistrement n'est pas rejoué par cette politique. Le scénario de réconciliation doit épuiser les réponses503 de la première lecture avant de réserver une réponse suspendue au nouvel essai demandé par l'utilisateur. Les contrôles du même identifiant de message, du compte, de la conversation et de l'absence d'inférence avant confirmation restent obligatoires.

Les reçus natifs intermédiaires sont conservés dans `native/`. Le lanceur corrige uniquement le cache privé de cette réception avec `--force`, contrôle la version contenue dans le bundle optimisé et renvoie un code non nul si une suite échoue. Les dépendances et caches des autres projets Mac sont préservés.

## Impact et réception finale

L'export du client est importé par 69 fichiers produit. L'analyse manuelle classe donc ce changement de dépendance **HIGH**, même lorsque le graphe ciblé ne résout pas les appels de propriétés de cette constante exportée. Un essai de graphe large a été arrêté par l'environnement ; le graphe ciblé réussit avec recherche plein texte indisponible et parcours tronqués. Ces limites interdisent de considérer un appel non représenté comme absent.

La réception finale doit porter sur le commit publié de cette correction : mêmes assertions `pageerror`, installation depuis le verrou commité, tests site, KARTA, concurrence, identité et matrice multi-moteurs. La PR108 et la page de continuité enregistrent ce résultat après exécution. L'intégration vise exclusivement `audit/reliability-oauth-20261110` ; elle ne constitue pas un déploiement de production.
