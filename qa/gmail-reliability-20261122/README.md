# Fiabilité de la lecture et des réponses Gmail — 22 novembre 2026

## Périmètre vérifié

Correction locale isolée de `puramapro-oss/purama-ai`, sur la base
`812830f9bba392f8fcb109a844f083638520a273`. Le lot porte sur le contexte Gmail
KARTA, les outils de réponse et leurs deux rôles consommateurs. Il ne modifie
ni le handler Edge d'envoi, ni les migrations, ni le calendrier, ni les règles
d'approbation. Aucun compte réel ni fournisseur n'a été appelé pendant les tests.

La lecture utilisait seulement `format=metadata` et `snippet`. Le nouveau
contexte charge `format=full` et expose le texte inline UTF-8/ASCII, son statut
de lecture et l'identifiant du parent. Les représentations non prises en charge
restent explicitement signalées ; aucun extrait tronqué n'est présenté comme un
texte complet.

Les brouillons et réponses vérifient le parent dans la boîte du même utilisateur,
son fil, le sujet exact et le destinataire. Ils produisent `threadId`,
`In-Reply-To` et `References` depuis ce parent vérifié. Un `Reply-To` différent
du `From` exige une revue. Les rôles `email` et `repondeur-intelligent` doivent
fournir les deux identifiants avant toute I/O. Les autres rôles conservent la
possibilité de composer un nouveau message. Le parent doit également disposer
d'un texte inline intégralement lisible avant quota ou POST. Le marqueur
`sensitive: true` de l'envoi et le quota atomique existant sont conservés.

La collecte suit au maximum cinq pages de cinquante entrées, déduplique les
identifiants et refuse les cycles de pagination. Toute pagination incomplète,
limite de lot ou absence d'OAuth provoque un échec avant écriture du curseur.
Le curseur d'une collecte réussie utilise l'instant de début du polling,
comportement existant désormais couvert par un test de deux pages.

## Vérifications exécutées

Les commandes suivantes ont été exécutées depuis `karta/` avec les dépendances
existantes, sans installation. Les réponses réseau, OAuth et Supabase sont des
fixtures ; les adresses de test utilisent `example.com`.
Les captures jointes rendent les CR visibles (`\r`) et retirent les blancs de
fin de ligne pour être conservées dans Git ; les résultats sont inchangés.

| Gate | Résultat observé |
| --- | --- |
| Quatre régressions initiales contre le code de base | Quatre échecs attendus reproduits : texte final absent, en-têtes de fil absents, sujet incohérent accepté |
| `node node_modules/vitest/vitest.mjs run test/gmailTool.test.ts test/gmailReply.test.ts test/gmailMessage.test.ts test/actionAgentsMock.test.ts --maxWorkers=1` | **PASS**, 58 tests, 4 fichiers, code de sortie 0 |
| `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **PASS**, code de sortie 0 |
| `node node_modules/typescript/bin/tsc -p tsconfig.build.json` | **PASS**, code de sortie 0 |
| `git diff --check HEAD` | **PASS**, code de sortie 0 |
| Contre-revue indépendante du delta MIME, réponse et pagination | Deux omissions MIME reproduites puis corrigées ; aucun autre défaut bloquant relevé dans ce périmètre |

Les cas négatifs incluent base64url/UTF-8/MIME malformés, limite exacte de texte,
HTML seul, sous-arbre HTML inline, casse MIME mixte, profondeur MIME, taille JSON
réellement lue, doublons et injection CRLF des en-têtes, incohérence fil/parent,
sujet ou destinataire, omission des ancres pour les deux rôles, ambiguïté d'un
ancien brouillon sans parent, corps parent incomplet, plafond de lot, cycle et
plafond de pages, OAuth absent et curseur inchangé.

## Analyse d'impact

Le graphe GitNexus qualifié sur la base exacte `812830f` a été copié dans le
checkout isolé après comparaison SHA-256, puis adopté avec la commande officielle
`index --force`. Le graphe source n'a pas été modifié ou reconstruit.

L'impact préalable de `listNewGmailMessages` est **HIGH** : huit éléments
impactés, un appelant direct, trois modules ; `buildGmailInboxContext` est
également **HIGH**. Les méthodes d'outils appelées dynamiquement et les constantes
d'agents produisent une couverture **UNKNOWN** ; les lectures ciblées et la
contre-revue complètent ce graphe. Ces limites ne sont pas assimilées à une
absence de risque. L'avertissement HIGH a été communiqué avant les écritures.

`detect-changes --scope staged` a contrôlé le lot isolé : dix fichiers,
25 symboles, zéro processus identifié, risque calculé LOW, code de sortie 0.
Ce résultat borné au graphe ne remplace pas le risque HIGH préalable. La
comparaison demandée avec la branche par défaut a été exécutée contre son SHA
connu `ae84415be0b9516422805910be999a2c1e6350c0`, car aucun nom local `main`
n'était présent. Cette comparaison de tout l'historique a retourné **CRITICAL**
(1 811 fichiers, 18 821 symboles, 526 processus au contrôle précédant le dernier
garde OAuth et cette note). Elle a été signalée séparément : elle ne constitue
ni une validation de cette divergence, ni le périmètre de la correction Gmail.

## Limites et suites

- **PARTIEL** : texte inline uniquement, jusqu'à 64 Kio décodés par message et
  256 Kio par lot ; au maximum 2 Mio par réponse JSON, 100 parties et profondeur
  MIME 12. Le dépassement est explicite. HTML seul, pièces jointes, texte stocké
  séparément et autres encodages nécessitent un traitement spécialisé ou une
  revue ; leur contenu n'est pas prétendu lu.
- **PARTIEL** : cinq pages au maximum. Un retard supérieur bloque le curseur au
  lieu d'oublier silencieusement les pages restantes. Une reprise de gros retard
  reste à concevoir dans le suivi existant.
- **PARTIEL** : le curseur est encore écrit après collecte et avant les décisions
  LLM/effets externes. Ce lot n'ajoute ni ingestion durable, ni reprise d'un
  traitement interrompu, ni déduplication durable entre pollings.
- **HORS PÉRIMÈTRE** : la réservation durable du handler Edge d'envoi appartient
  à un lot distinct. Cette correction ne qualifie pas l'envoi exactement une fois.
- **NON TESTÉ** : OAuth réel, réponse visible dans un fil Gmail réel, envoi réel,
  déploiement, exécution continue et disponibilité 24 h/24.

## Références officielles

- [Gestion des fils Gmail](https://developers.google.com/workspace/gmail/api/guides/threads)
- [Lecture d'un message Gmail](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get)
- [Ressource Message et conditions d'ajout à un fil](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages)
- [RFC 5322, structure des messages et en-têtes de réponse](https://www.rfc-editor.org/rfc/rfc5322.html)
