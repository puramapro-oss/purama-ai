# Découverte de partenaires — réception du 24 novembre 2026

Ce lot fiabilise la fonction existante `partner-find-prospects`, son client et le dialogue de recherche de `PartnerAgentProspects`. Il conserve les contrats, barèmes, réglages et fournisseurs existants. Aucun second moteur de prospection n’est créé.

**Base des reproductions et des premières réceptions :** `18c40d0eb59b48636dd8d8fb54c0516b700ed746`.

**Base d’intégration :** `04ff79c`, après l’avance de la consolidation IAO. Cette avance ne modifie pas les chemins ni les dépendances de ce lot. Les reçus antérieurs restent attachés à leurs sources et ne deviennent pas rétroactivement des tests de la composition finale.

## Problèmes et corrections

La recherche pouvait accepter des données insuffisamment vérifiées, perdre la distinction entre un échec et des écritures déjà réalisées, ou laisser un résultat ancien agir sur un autre compte. Le dialogue ne s’ouvrait pas avec le composant Radix réel, à cause d’une option de sélection vide.

- **Fonction Edge :** bornage des entrées et des réponses, délai partagé, rapprochement des coordonnées avec les sources, conservation de la provenance et des règles d’approbation, contrôle des doublons et distinction des résultats partiels ou non confirmés. Le modèle configuré reste prioritaire ; à défaut, le modèle actif déjà utilisé dans le projet remplace le modèle retiré, sans modifier le plafond de sortie.
- **Dialogue :** option « Toutes » valide, verrou synchrone contre le double déclenchement, compte et epoch liés à l’opération, propriétaire du formulaire capturé à l’ouverture et masquage immédiat des données d’un ancien compte. Les modifications, fermetures et réouvertures invalident la réponse de l’ancien brouillon.
- **Client HTTP :** décodage du corps original de `FunctionsHttpError`, sans clone, plafonné à 16 KiB et une seconde grâce au lecteur partagé. Les états `failed`, `partial`, `unknown` et le compteur `confirmed_inserted` sont vérifiés. Une réponse indécodable reste non confirmée et ne produit aucun compteur inventé.
- **Retour utilisateur :** messages français définis localement, sans diagnostic brut du fournisseur. Les écritures partielles restent explicites ; le formulaire est conservé et invite à vérifier la liste avant une nouvelle recherche. Aucun nouvel essai automatique n’est ajouté.

## Réception et preuves

| Contrôle | Résultat et portée | Preuve |
| --- | --- | --- |
| Client et interface ciblés | **PASS : 83/83**, cinq fichiers, après les corrections de compatibilité TypeScript | [Reçu client et journaux](ui-client-receipt.json) |
| Composition des 83 cas | 27 frontières client, 21 cas DOM de découverte, 12 contrats, 18 cas de propriété des réglages, 5 horaires | Même reçu ; ces sous-ensembles sont inclus dans le total |
| Lint ciblé | **PASS**, cinq chemins, zéro avertissement | Même reçu |
| Reproductions antérieures | Défauts initiaux, ouverture Radix, réponses obsolètes et contre-épreuve du commit avant effets passifs conservés | [Base](baseline.json) · [Réception UI antérieure](ui-discovery-receipt.json) |
| Backend final | **PASS : 152/152** = 89 découverte + 63 politique assistant ; empreintes finales vérifiées | [Reçu backend et journaux](backend-evidence/receipt.json) |
| TypeScript global | **PASS**, exit 0 en 16,743 s sur la composition `04ff79c` et les sources finales | [Reçu final](typecheck-final-receipt.json) ; échec initial conservé sous `typecheck-client-initial*` |
| Typage Deno natif | **PASS**, Deno officiel 2.9.7 / TypeScript 6.0.3, six sources identiques, exit 0 en 6,655 s ; dépendances publiques authentiques | [Reçu Linux final](native-typecheck-final-linux.json) ; ancien [reçu Mac](native-typecheck.json) historique |
| Build final | **PARTIEL**, quatre ressources hors ligne validées ; processus interrompu au rendu des chunks, exit 137. Bundle final non qualifié | [Dernière tentative](build-final-receipt.json), essais antérieurs conservés |
| Contrôle final des changements | **PARTIEL** : index ciblé reçu (79 fichiers, 1 482 nœuds, 3 174 arêtes), deux commandes exit 0. Impact agrégé **CRITICAL** conservé | [Index final](gitnexus-final-index-receipt.json) |

Les nombres de tests des exécutions successives **ne s’additionnent pas**. Les anciens résultats de 50, 51 ou 82 cas gardent leur portée historique. Le diagnostic des fixtures HTTP a identifié une différence de realm entre les octets natifs Node et JSDOM : les fixtures emploient maintenant de vrais `Response` et `ReadableStream` avec des vues d’octets du realm courant. Le lecteur de production, ses limites et les assertions n’ont pas été relâchés.

## Portée du graphe et limites

Le [graphe utilisé](graph-scope.json) couvre la découverte, ses appelants et les composants et lecteurs partagés nécessaires. Il ne constitue pas une indexation intégrale du dépôt. L’[impact du client](gitnexus-review-impact-client.json) est reçu LOW ; les liens React non résolus ont été signalés et complétés par la lecture des routes et des appels. Le contrôle final signale **CRITICAL** sur 107 fichiers préparés, 210 symboles et 32 flux ; ce décompte inclut les preuves et fixtures. La comparaison avec `main` porte sur 2 999 fichiers de toute la consolidation, 576 symboles et 78 flux. Ce signal d’impact statique reste visible ; les limites du graphe interdisent d’en déduire à lui seul une validation globale. La contre-revue du code exact et les tests décrits complètent cette analyse. Voir le [reçu des changements](gitnexus-final-changes-receipt.json).

Le plafond de 16 KiB et le délai d’une seconde concernent le **corps d’erreur HTTP décodé par ce client**. Le transport des réponses réussies par le SDK reste inchangé. La validation de l’enveloppe ne prétend pas vérifier tous les champs d’un `PartnerProspect` ; la liste rafraîchie reste la source d’affichage des détails.

Les tests utilisent le vrai code, les classes SDK et les contrôles React/Radix avec des transports contrôlés. Ils ne certifient ni les comptes fournisseurs, ni une base réelle, ni les parcours commerciaux en production. Fermer le dialogue ne prétend pas annuler une écriture déjà acceptée par le serveur. Aucun envoi, campagne, commission, paiement, migration ou déploiement n’est autorisé ou exécuté par ces reçus.

## Préparation à la publication

L’[inspection des fichiers destinés à la publication](publication-review.json) décrit son périmètre et sa date. Les diagnostics d’infrastructure et les probes historiques conservés hors du dépôt ne font pas partie de ce lot. Les mentions « production » des journaux désignent le mode de compilation ou une limite explicite ; elles ne constituent pas une preuve de mise en service.

**Statut global : PARTIEL.** Les 235 cas ciblés distincts, les contrôles de typage et la contre-revue portent sur le code corrigé. Le bundle final, le parcours réel avec fournisseurs et base de données, puis le déploiement restent à recevoir. Ce lot ne déclare aucune mise en service commerciale.

Les journaux `.log` sont conservés sous leur forme compressée `.log.gz` ; les reçus donnent les empreintes du contenu décodé. Les premières tentatives de compilation incluent une saturation explicite du tas V8 à 640 MiB, des interruptions 137 et un diagnostic `jitless` incompatible avec WebAssembly. Le dernier essai conserve `npm run build`, le contrôle des ressources et la configuration Vite/minification du projet, sans supprimer de gate.

[Réception globale et empreintes](verification.json) · [Contre-revue indépendante](independent-review.json).

## Reprise de la compilation

Le [scénario de compilation isolée](isolated-build.md) et son [script](isolated-build.py) sont préparés pour un environnement suffisamment doté. Leur exécution distante est **NON TESTÉE** ; seule la syntaxe du script a été vérifiée. Ils ne remplacent pas un reçu de compilation. Le [reçu de préparation](isolated-build-pending.json) conserve cette limite.
