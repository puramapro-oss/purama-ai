# Agent email : frontière entre réglages et credentials Gmail

## Résultat

**PASS pour ce lot local : 13 cas sur 13, sans cas ignoré, et ESLint ciblé réussi.** La même suite sur la source avant correction produit 5 réussites et 8 échecs. Aucun fournisseur réel, envoi, migration distante ou changement de droits SQL n'a été utilisé. Le clone macOS en qualification générale n'a pas été modifié.

Cette preuve complète le lot commerce sans modifier ses sources ou ses résultats.

## Défaut reproduit

La lecture utilisait `select('*')`. La ligne retournée contenait donc les colonnes Gmail réelles, même si `EmailAgentConfig` ne les déclarait pas. L'écran des paramètres retirait les métadonnées connues puis enregistrait le reste de cet objet. Les champs privés présents à l'exécution survivaient à cette opération.

Le contre-exemple charge une configuration, simule une reconnexion qui remplace les credentials en base, retire les métadonnées connues comme le fait l'écran, puis enregistre une signature. Sur le code initial, cette écriture remet les anciens credentials. Le cas final vérifie que le nouveau compte Gmail, ses credentials, les compteurs et le curseur de traitement restent inchangés.

Le banc exécute le véritable module TypeScript avec uniquement des ports Supabase et OAuth inertes. Il ne fournit aucune API réseau, navigateur ou processus au module.

## Modification bornée

`getConfig` utilise une projection explicite des 30 champs publics, à la lecture et au retour de la création initiale. Les credentials, leur échéance, le curseur de traitement et les futures colonnes privées ne sont pas demandés.

`updateConfig` construit à l'exécution un objet contenant uniquement les 18 réglages modifiables. Il conserve les valeurs `false`, les valeurs `null` autorisées et les listes vides. Les propriétés héritées, inconnues ou non définies ne sont pas transmises. Un patch sans réglage modifiable est refusé avant toute écriture. Le type du paramètre est également limité à ces réglages.

`disconnectGmail` reste une action distincte : écriture explicite de `gmail_email: null` et `is_active: false`, pour le `user_id` demandé, suivie d'une vérification du reçu. Les credentials conservés, le chiffrement et la révocation chez Google ne sont pas modifiés.

Les 35 autres déclarations existantes sont identiques par comparaison de leur source AST, dont `getGmailOAuthUrl`, les réglages par défaut et les autres opérations métier. La [preuve de conservation](source-preservation.json) décrit les trois fonctions modifiées et les trois déclarations ajoutées.

## Qualification

| Contrôle | Résultat | Preuve |
| --- | --- | --- |
| Source avant correction, même suite finale | 5 PASS, 8 FAIL sur 13 | [journal avant](before.txt), [reçu](before-result.json) |
| Source corrigée | 13/13 PASS, aucun cas ignoré | [journal final](after.txt), [reçu](final-result.json) |
| ESLint du module et du nouveau test | PASS, sortie vide | [reçu lint](lint-result.json) |
| Conservation des autres déclarations | PASS | [comparaison AST](source-preservation.json) |

Exécution : **Linux, Node v24.22.1**. La contre-épreuve utilise l'arbre de travail après les changements OAuth de l'assemblage principal, avant ce correctif : SHA-256 `fc58235d7055f4f707539bfdf0127a2806b94b7d706cdb861aea09e0353f94a0`. Son contenu exact est conservé dans le champ `source` de [source-before.json](source-before.json).

Le [manifeste](manifest.json) et le [registre des journaux](log-normalization.json) distinguent la source initiale de la qualification finale. Les entrées des commandes finales sont identiques avant et après leur exécution.

Commande qualifiée depuis le dépôt :

```sh
node --test --test-reporter=tap tests/oauth-gmail/config.test.mjs
```

## Impact et limites

Les impacts GitNexus des trois fonctions ont été observés avant édition. Le graphe retourne `UNKNOWN`, sans appel résolu ; les corps des fonctions indexées correspondent exactement aux corps audités. La relecture manuelle identifie les écrans `EmailAgent` et `EmailAgentSettings`. Le risque manuel est **CRITICAL** pour l'intégrité des credentials. Les observations sont résumées dans [impact.json](impact.json). L'index partagé n'a pas été réécrit.

Le conflit de première création est conservé : si une autre opération crée déjà la ligne, l'erreur de contrainte unique reste visible. Aucun remplacement automatique ni `upsert` n'a été ajouté. Le test confirme l'absence de réécriture ; il ne constitue pas un test de concurrence PostgreSQL réel.

La projection et le filtre protègent ce parcours contre des objets obsolètes. **Ils ne constituent pas une nouvelle permission de colonnes en base.** Les politiques SQL restent inchangées et un client modifié n'est pas contenu par une liste blanche JavaScript. L'autorisation SQL, le chiffrement et la révocation fournisseur restent hors de ce lot.

Le contrôle TypeScript de l'application assemblée, la CI hébergée et les parcours navigateur complets appartiennent à l'assemblage principal. Aucun résultat de production ou de fournisseur réel n'est revendiqué.
