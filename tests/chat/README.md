# Recette isolée du chat PURA

Depuis la racine, après `npm ci` et l’installation de Chromium Playwright :

```sh
npm run test:chat
```

`PLAYWRIGHT_EXECUTABLE_PATH` permet de choisir un Chromium local compatible. Le serveur Vite écoute seulement sur `127.0.0.1:4175`. Le harnais charge les vrais composants React, le SDK Supabase et le lecteur SSE ; seule l’authentification et la couche réseau sont simulées. Une fixture de contexte intercepte HTTP et WebSocket avant navigation, y compris les fenêtres supplémentaires. Elle transmet seulement les GET/HEAD vers cette origine et le socket HMR local exact. La feuille Google Fonts `/css2` est remplacée localement par une réponse CSS vide, sans transmission ; les polices de repli sont utilisées. Toute autre requête est bloquée et fait échouer le scénario. Les service workers sont bloqués, la résolution Chromium est limitée à l’adresse locale et les événements réseau excluent corps, jetons et paramètres de requête. Aucun compte, appel IA, email ou changement de base réel n’est effectué.

Les 14 parcours vérifient les doubles envois, les annulations, la conservation des réponses terminées, les changements de compte, les échecs de stockage, le contexte utile, l’historique et l’affichage mobile. Les réponses retenues volontairement après annulation mettent à l’épreuve les protections contre les retours tardifs. Les captures desktop/mobile sont produites dans le répertoire de résultats Playwright.

Les contrats serveur et les politiques SQL sont couverts dans `karta/test/{chatRequestScope,publicChatAdmission,chatHistoryIsolation,chatEscalation}.test.ts`. Exécution : `npm test` depuis `karta`. La migration doit être qualifiée sur la base cible avant application : elle refuse les schémas incomplets et politiques inattendues. Ces essais ne valident ni le runtime Deno/Supabase réel, ni la délivrabilité email, ni la qualité des modèles, ni la facturation.
