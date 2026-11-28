# Histoire Git originale de la réconciliation

`original-history.bundle` conserve les objets Git originaux jusqu'au candidat
`83d0ecceb28b41d0f7f35e6e1d65affbc26855e6`, d'arbre
`90bdf6ee2ae98df73a179ea690fb70aa7c7ef564`.

- Taille exacte : **127 047 octets**.
- SHA-256 : `b17cb987675e3ff1f91903e4669027edb5abdb566caf98eb0dcc934f1ef19c6a`.
- Référence incluse : `refs/heads/audit/unlazy-reconciliation-20261125`.

## Prérequis

Le bundle est incrémental par rapport à
`d25f2e72a59689def3d8095db31c086a8b6eeca9`. Git inscrit les trois prérequis
de frontière suivants, tous accessibles depuis cette base :

1. `9ab7e16b9d1230185d52d216a406c90a3a4a486d` ;
2. `795d7db298416f98cf95103c096714f82c01c8cb` ;
3. `d25f2e72a59689def3d8095db31c086a8b6eeca9`.

Un dépôt possédant l'histoire de d25 dispose de ces objets. Un clone shallow
contenant uniquement d25 peut nécessiter la récupération de ses ancêtres avant
l'import ; la présence de d25 seule ne suffit pas à le démontrer.

## Commits préservés

| Commit original | Parents originaux, dans leur ordre |
| --- | --- |
| `383d54cc3b47415b2cc5fe3e2351a9212dc95ad3` | `9ab7e16b9d1230185d52d216a406c90a3a4a486d` |
| `42b86982fe880539b41827fe0969fd6285ac759c` | `383d54cc3b47415b2cc5fe3e2351a9212dc95ad3` |
| `82d7e11299bab207688144807b35bd86451041ef` | `42b86982fe880539b41827fe0969fd6285ac759c`, `795d7db298416f98cf95103c096714f82c01c8cb` |
| `0685c1a76e99d52f95cb840f14571f9f9f506d14` | `d25f2e72a59689def3d8095db31c086a8b6eeca9`, `82d7e11299bab207688144807b35bd86451041ef` |
| `83d0ecceb28b41d0f7f35e6e1d65affbc26855e6` | `0685c1a76e99d52f95cb840f14571f9f9f506d14` |

Si une publication par le connecteur recrée les commits avec de nouveaux
identifiants, les arbres doivent être strictement identiques et la correspondance
des commits doit être consignée dans le reçu de publication. Ce bundle conserve
l'histoire originale indépendamment des nouvelles métadonnées de publication.
Il n'inclut pas le commit qui ajoute le bundle lui-même.

## Vérification de récupération

Le 25 novembre 2026, un dépôt bare séparé a d'abord reçu seulement l'histoire de
d25. L'absence du commit 83d y a été contrôlée, puis le bundle a été vérifié et
importé. Le HEAD restauré et son arbre ont exactement correspondu aux identités
ci-dessus ; `git fsck --connectivity-only --no-dangling` a terminé avec sortie 0.

Dans un dépôt disposant des prérequis, l'import peut être vérifié sans déplacer
une branche existante :

```sh
git bundle verify qa/iao-unlazy-reconciliation-20261125/original-history.bundle
git fetch qa/iao-unlazy-reconciliation-20261125/original-history.bundle refs/heads/audit/unlazy-reconciliation-20261125:refs/heads/recovered-iao-unlazy
git rev-parse refs/heads/recovered-iao-unlazy
git rev-parse 'refs/heads/recovered-iao-unlazy^{tree}'
```

## Contrôle des contenus à publier

Un scan ciblé de sept familles de secrets littéraux a examiné les 124 nouveaux
objets de type blob ou commit du lot, après décompression logique des objets Git.
Aucun motif n'a été trouvé. Aucun fichier de credentials, configuration Git de
transport ou variable d'environnement n'est incorporé par cet archivage.
Les métadonnées d'auteur Git et les chemins locaux déjà présents dans les reçus
sont conservés. Ce contrôle ciblé ne constitue pas une certification exhaustive
de l'absence de données sensibles.

Cet ajout documentaire ne modifie aucun fichier produit, test, dépendance ou
configuration de déploiement.
