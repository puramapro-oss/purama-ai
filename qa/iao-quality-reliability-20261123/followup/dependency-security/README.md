# Audit complémentaire des dépendances et du contrôle CI

Date : 23 novembre 2026. Base : `26eb27298976a8dd0cf1397f7bbaff00ea4360a3`.

## Résultat

Les deux audits npm ont réellement interrogé `https://registry.npmjs.org` sur les verrous existants, dépendances de production et de développement incluses. Aucun paquet n'a été installé ou mis à jour. Les empreintes des verrous avant et après sont identiques.

| Périmètre | Critiques | Élevées | Modérées | Faibles | Résultat au seuil high |
| --- | ---: | ---: | ---: | ---: | --- |
| KARTA | 0 | 0 | 0 | 0 | PASS |
| Site | 0 | 0 | 0 | 3 entrées pour un même avis | PASS avec avis résiduel |

Les trois entrées faibles sont `elliptic@6.6.1`, `bitcore-lib@8.25.47` et `opentimestamps@0.4.9`, toutes rattachées à **GHSA-848j-6mx2-7j84 / CVE-2025-14505**. Elles appartiennent au graphe de production du site. Ce ne sont pas trois vulnérabilités indépendantes.

L'[avis primaire GitHub](https://github.com/advisories/GHSA-848j-6mx2-7j84), consulté le 23 novembre, concerne une erreur de signature ECDSA et ne signale aucune version corrigée. La proposition automatique npm de rétrograder `opentimestamps` vers `0.0.0` implique une rupture majeure ; elle n'a pas été appliquée. Aucune suppression fonctionnelle ni modification de primitive cryptographique n'a été improvisée.

## Qualification du chemin utilisé

Les adaptateurs de preuves existants importent les primitives OpenTimestamps nécessaires au hachage, à la sérialisation et à la vérification. Le test existant ciblant cet avis remplace la méthode de signature ECDSA de l'instance transitive exacte par un piège qui échoue si elle est appelée. Le parcours contrat, le refus de contenu altéré, le refus de preuve malformée et la vérification de racine Merkle passent avec **zéro appel de signature**.

- `npm run test:dependencies` : **5 tests PASS**, dont transport HTTP local et compatibilité du graphe installé.
- `node --experimental-vm-modules --test --test-name-pattern=GHSA-848j-6mx2-7j84 tests/opentimestamps-content.mjs` : **1 test ciblé PASS**.

Cette preuve concerne les parcours exercés. L'avis reste présent dans le verrou ; elle ne démontre pas l'absence d'exposition dans tout usage possible du paquet.

## Contrôle CI réparé

Le workflow `PURAMA CHEF hardening` excluait explicitement ses deux audits npm des événements `pull_request`. Ses déclenchements `push` ne couvraient pas la branche de consolidation. Un contrôle positif des tests pouvait donc précéder la fusion sans audit npm frais.

Seules les deux étapes concernées de `.github/workflows/purama-chef-hardening.yml` sont modifiées :

- `Audit complete KARTA dependency lock` ;
- `Audit complete site dependency lock`.

Elles exécutent désormais `npm audit --package-lock-only --audit-level=high --ignore-scripts`, sans exclusion des PR. Les dépendances de développement sont incluses. Le seuil élevé est conservé ; les droits du workflow restent `contents: read`. Aucun `audit fix`, installation, nouvel accès ou secret n'est ajouté.

La validation locale par `js-yaml` confirme un YAML valide, le déclencheur PR et l'absence de condition excluante sur les deux étapes. La comparaison structurée confirme que tout le reste de la configuration est identique. `git diff --check` passe. **L'exécution des deux nouvelles étapes sur GitHub reste à attester par la CI du commit publié.**

## Vérification limitée des secrets et de la configuration

Les tests KARTA existants couvrent déjà la réduction des traces privées, les erreurs sans diagnostic sensible, les jetons d'administration et l'absence d'envoi de credentials ambiants dans le transport modèle. Ils font partie de la suite précédente ; ils n'ont pas été relancés artificiellement dans ce sous-lot.

Aucun job autonome nommé Gitleaks ou TruffleHog n'est déclaré dans les workflows inspectés. Cela ne décrit pas la configuration de sécurité GitHub externe aux fichiers du dépôt.

Un contrôle local borné a examiné **169 fichiers sources suivis** dans les chemins indiqués par `source-secret-patterns.json`, avec six motifs de clés privées et de formats de tokens : **zéro correspondance**. Aucun fichier de secrets ambiants, valeur de variable d'environnement ou compte distant n'a été lu. Le contrôle exclut les tests, les preuves historiques et l'historique Git ; il ne remplace pas un scanner exhaustif ni un audit de toutes les configurations déployées.

## Preuves

- `site-audit-full.json`, `karta-audit-full.json` : réponses npm complètes.
- `site-audit-receipt.json`, `karta-audit-receipt.json` : commande exacte, répertoire, code de sortie, durée et empreintes des verrous.
- `compatibility.log`, `elliptic-path.log`, `targeted-verification.json` : exécutions ciblées et reçus.
- `workflow-verification.json` : structure des deux étapes avant/après, éligibilité PR, droits et empreinte du workflow.
- `source-secret-patterns.json`, `source-secret-scope.json` : périmètre, motifs, limites et empreintes des sources contrôlées, sans copie de valeur sensible.

Périmètre de modification : le workflow et ces preuves uniquement. Aucun modèle, plafond, connecteur, dépendance, donnée utilisateur ou comportement produit n'a été modifié par ce sous-lot.
