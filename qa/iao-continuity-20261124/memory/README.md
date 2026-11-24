# Projection mémoire IAO — répétitions exactes

## Résultat local

PASS sur la base `e81129a56e07535129827c95211d82815df8dc5a` pour cette qualification ciblée. La modification produit ajoute cinq lignes à `buildMemoryPrompt`. Après validation du contexte complet, filtrage des sources normales autorisées et tri par pertinence, un texte complet strictement identique ne consomme plus une seconde part du budget. Les sources stockées ne changent pas.

## Avant et après

Le fichier existant de 14 scénarios est conservé octet pour octet en préfixe ; 15 scénarios sont ajoutés. Sur le produit initial, les 29 cas donnent 22 réussites et 7 échecs. Après correction, les mêmes 29 cas passent. La réception ciblée de cinq fichiers donne 188/188 réussites, sans test ignoré, avec un worker ; elle inclut les 29 cas de projection et ne s'ajoute donc pas à ce nombre. Le typage global KARTA et le contrôle des espaces des deux sources modifiées passent.

Les cas couvrent le budget utile récupéré, la priorité, les répétitions non contiguës, les extraits tronqués, les textes distincts ou différemment normalisés, les exclusions, les données malformées, les getters, la notice partielle, Unicode et les délimiteurs des sections. Aucun ancien oracle n'a été modifié.

## Preuves et limites

`qualification.json` fournit les empreintes et le périmètre. `evidence.zip` conserve les commandes, codes de sortie, durées, rapports avant/après et journaux originaux, avec un manifeste et CRC vérifiés. Les originaux restent conservés localement.

Le reçu d'impact produit préalable est `../impacts/buildMemoryPrompt.json` : LOW, un appelant direct et le parcours de préparation KARTA. L'impact du fichier de tests rend UNKNOWN au niveau File ; aucun résultat vide n'est présenté comme une absence générale d'impact.

Le budget reste celui des caractères de texte, pas un budget exact de tokens. Aucun gain de qualité, coût ou latence d'un modèle réel n'est revendiqué. Les ports canoniques, l'activation du runtime et les données stockées restent hors de cette modification. Les tests natifs de sockets, la réception de l'assemblage, l'actualisation de l'index et la publication sont à recevoir par l'intégrateur ; les tests et simulations locaux ne les remplacent pas.
