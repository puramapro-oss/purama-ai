# Reçus des cœurs natifs SHA-256

**PASS : Java 26 assertions, Swift final 22 assertions, contrat JavaScript final 9 tests.**

Le statut du lot reste **PARTIEL** : les bindings Expo et l'exécution Hermes doivent être vérifiés dans les jobs natifs de l'application. Ces reçus ne mesurent aucun gain de vitesse sur le modèle complet.

## Lire les preuves

- `receipt.json` décrit les étapes, leurs portées, les outils et les empreintes exactes.
- `module-source-sha256.json` inventorie la version finale du module. L'inventaire ne signifie pas que tous les fichiers ont été compilés ; les fichiers couverts sont précisés dans chaque résultat.
- `java-swift-initial.log` contient le PASS Java puis l'échec de compilation Swift sans SDK explicite. **Le processus global a terminé avec le code 1 à cause de Swift, après le succès Java.** Le script n'imprimait pas de code Java séparé ; sa poursuite vers Swift avec `set -e` confirme que la commande Java a réussi.
- `swift-sdk-explicit.log` conserve le premier succès Swift avec SDK explicite. Il concerne une version intermédiaire du cœur et ne remplace pas le reçu final.
- `swift-final.log` couvre le cœur Swift final et le script corrigé : 22 assertions, code de sortie 0.
- `module-contract-final.log` couvre les neuf tests JavaScript après ajout de l'import public SharedObject réellement utilisé.

Les fichiers natifs et leurs tests sont restés identiques pendant le dernier ajustement du getter. Leurs empreintes ont été rapprochées des reçus ; aucun cœur natif n'a été relancé pour cet ajustement JavaScript. Les tests de cœurs ont tourné sur macOS, pas dans l'application Android ou iOS.
