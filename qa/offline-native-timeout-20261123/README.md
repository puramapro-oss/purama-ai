# IAO hors ligne — revalidation après redémarrage

Date : 23 novembre 2026. Base : `6db3a1ef6df8f0124707663dafb87620ac9996ff`, branche de la PR 99. Ce lot prolonge la qualification native existante, sans modifier le modèle, les empreintes d’intégrité, les critères de chiffrement ou les scénarios d’isolation.

## Résultat et portée

**PASS pour les corrections et contrôles logiciels locaux exécutés. La nouvelle recette Android native reste NON TESTÉE avant son exécution en CI.** Les tests du contrôleur utilisent des frontières natives et une horloge explicitement synthétiques ; leurs résultats ne remplacent pas une inférence sur appareil.

Le précédent run GitHub `45232818699`, job `137896602820`, avait réellement préparé le pack Qwen épinglé, généré `bonjour` avec `llama.rn` sur CPU, enregistré les fixtures chiffrées et produit le reçu `prepared`. Le second processus a ensuite retourné `timeout` sans reçu complet.

La commande de qualification a commencé à 18:18:47.287 UTC ; `prepared` a été observé à 18:28:15.488 UTC, puis l’échec à 18:31:17.509 UTC. La préparation a donc duré environ 568 secondes et la phase suivant le redémarrage environ 182 secondes. L’ancien journal ne contient pas assez de jalons pour attribuer cet échec précisément au hachage, au test natif initial ou à la génération.

## Défauts reproduits et correction

1. **Budget incorrect pour la vérification à froid.** `inspect()` et la phase `requireReady()` d’une génération incluaient une relecture SHA-256 du pack de 639 446 688 octets et un test natif, mais utilisaient déjà le budget de génération de 180 secondes. Le test rouge démontre un abandon après 180 001 ms alors qu’aucune génération utilisateur n’a commencé.
2. **Transition avec timer retardé.** Une résolution tardive pouvait arriver avant l’exécution du callback du timer. Une échéance monotone absolue est maintenant vérifiée avant la transition et après le travail ; le test rouge montre que la simple remise à zéro du timer ne suffit pas.
3. **Diagnostic insuffisant de la recette.** Le reçu d’échec n’indiquait pas l’étape courante. La recette enregistre désormais les étapes, la durée monotone et une progression du pack limitée aux changements de tranche de 10 %. Aucun prompt, clé, jeton ou texte d’exception native n’est ajouté à ce canal.

La vérification locale dispose d’un délai fini de 600 secondes. Après vérification réussie, la génération dispose de son propre délai de **180 secondes, inchangé**, avec une seule transition autorisée. La préparation explicite conserve son budget de 30 minutes. Un délai expiré ou une annulation ne peut pas être réarmé par un résultat tardif. Le verrou du moteur demeure détenu jusqu’à la fin effective de la libération native.

La recette après redémarrage est bornée à 840 secondes : vérification, génération et marge de 60 secondes pour les contrôles de persistance. Le script attend au plus 600 puis 900 secondes et possède un plafond global de 1 600 secondes, suivi du délai de terminaison forcée existant de 15 secondes. Tous les contrôles SHA-256, réseau, SQLCipher, mauvaise clé, restauration et isolation restent requis.

Le job Android conserve son plafond de 60 minutes. Dans le run historique, la préparation du runner et les builds ont pris environ 23 min 22 s avant le script ; le plafond du nouveau scénario laisse ainsi environ dix minutes de marge pour les artefacts et le nettoyage. Cette observation n’est pas une garantie de durée d’un prochain runner.

## Contrôles exécutés

| Contrôle | Résultat |
| --- | --- |
| Suites de départ moteur, pack et gardes de qualification | 43/43 PASS |
| Deux nouvelles régressions de budget, avant correction | 2 FAIL attendus parmi 26 tests |
| Diagnostic d’échec natif, avant correction | 1 FAIL attendu parmi 7 tests |
| Timer livré en retard, avant contrôle monotone | 1 FAIL attendu |
| Suite mobile hors ligne complète après correction | 164/164 PASS, aucune exclusion |
| Vérification TypeScript mobile | PASS sur exécution finale isolée |
| ESLint ciblé sur les deux fichiers TypeScript modifiés | PASS |
| Syntaxe Bash du script de recette | PASS |
| Export Metro Android, qualification activée | PASS, 1 648 modules |
| Export Metro iOS, configuration normale | PASS |
| Revue indépendante des cinq fichiers | PASS, aucune observation bloquante ; revue statique |

Les tests couvrent la revalidation lente, le délai de génération conservé, l’expiration, l’annulation pendant la revalidation, le verrou jusqu’au nettoyage, la reprise ultérieure, le refus d’une intégrité incorrecte, la résolution tardive et les diagnostics sans contenu de conversation.

L’export Android initial utilisait une dépendance liée hors du checkout : Metro ne pouvait pas résoudre un paquet de compatibilité. Une copie isolée des dépendances déjà installées a permis l’export sans modifier les manifestes ni la configuration Metro. Un contrôle TypeScript exécuté pendant d’autres travaux a été interrompu par le processus hôte avec le code 137 ; la cause système précise n’a pas été établie. Son exécution isolée a ensuite réussi. Ces essais sont conservés dans les preuves.

## Analyse d’impact et coordination

Le checkout utilisé est isolé. La source de la PR 99 dans l’autre espace a été vérifiée propre et toujours au commit de base au moment de la préparation du lot. Aucun push, déploiement ou changement du Mac n’est effectué par ce lot local.

GitNexus a réussi une indexation mobile sur les sources avant modification. L’analyse de `runExclusive` indique un risque **HIGH**, avec trois appelants directs : `inspect`, `prepare` et `complete`. Les contrôles de changements identifient les cinq fichiers attendus et leurs flux. Les deux tentatives d’indexation globale puis le rafraîchissement mobile final ont quitté avec le code 1 sans diagnostic final exploitable ; le contrôle du diff a néanmoins réussi avec le graphe de départ. L’index mobile exclut les autres dossiers et comporte les limites de résolution et de parcours mentionnées dans son reçu. Les symboles liés à certains blocs de diff peuvent être approximatifs ; l’absence d’un lien n’est pas une preuve d’absence d’appel.

Pour aligner les chemins du diff Git sur la racine mobile de cet index, l’invocation de contrôle utilise temporairement `diff.relative=true`. Aucun fichier de configuration Git ou d’instructions du dépôt n’est modifié. Le périmètre réel est vérifié aussi par la liste des fichiers et la lecture du diff.

## Preuves

`verification.json` associe commandes, résultats et empreintes aux sources. Les journaux compressés conservent leurs octets d’origine ; aucun espace de sortie d’outil n’est réécrit pour obtenir un contrôle vert. `native-baseline.json` référence l’artefact GitHub original et les deux reçus. `independent-review.json` conserve la portée de la revue.

La suite native Android doit encore produire un reçu `complete` satisfaisant toutes les assertions du script sur le commit publié. Tant que ce reçu manque, la correction logicielle est qualifiée localement et la reprise native corrigée demeure **NON TESTÉE**.
