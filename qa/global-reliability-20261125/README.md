# Audit de fiabilité IAO — 25 novembre 2026

## Identité et portée

Base : `d25f2e72a59689def3d8095db31c086a8b6eeca9`, arbre
`ee2538b86074a45ed446890cc2cf1fbe0fab0d96`, branche de consolidation
`audit/reliability-oauth-20261110`. Le correctif est préparé sur une branche
isolée ; les sources des autres travaux sont préservées.

La demande d'audit et de correction du 25 novembre autorise la correction des
contrats existants. Ce lot ne crée ni nouvelle autorité d'identité, ni nouvelle
mémoire, ni migration. Il traite trois défauts reproduits et précise la portée
historique du registre des agents. La qualification de production reste séparée.

## Défauts corrigés

### Identité stable d'une consultation et conservation des reçus

Les options facultatives omises ou explicitement vides produisaient des ordres
de champs différents. Après le véritable parseur de requête, quatre demandes
équivalentes donnaient quatre empreintes et pouvaient provoquer un faux conflit
de reprise dans PostgreSQL.

La normalisation construit désormais ses champs dans un ordre stable. Les textes,
choix explicites et ordres des listes restent significatifs. Après un conflit
uniquement, l'adaptateur peut lire quatre champs de l'identité historique, avec
les filtres propriétaire et opération. Il valide une copie passive stricte puis
compare l'intégralité des demandes normalisées. Si elles correspondent, le RPC
de reprise reçoit la requête et l'empreinte historiques originales.

Cette reprise ne recrée pas l'opération, ne construit pas de fournisseur et ne
réserve pas un second budget. Les reçus, générations et résultats existants ne
sont pas réécrits. Un client injecté sans port de lecture historique conserve un
refus ; il ne bascule jamais sur une autre base.

Preuve : [conseil-receipt.json](conseil-receipt.json). Les 27 cas initiaux donnent
19 PASS / 8 FAIL avant la correction ; le lot final comprend aussi un test du
SDK Supabase installé et donne **28/28 PASS**. Huit suites préexistantes donnent
**248/248 PASS**. Ce dernier nombre recouvre la campagne complète et ne s'y ajoute
pas. Les migrations réelles sont exécutées dans PostgreSQL/WASM ; ce banc sériel
ne prouve pas les temps d'attente entre connexions PostgreSQL natives.

### Refus HTTP 413 et erreurs d'authentification 401

Le lecteur HTTP rejetait un corps dépassant 65 536 octets, mais la route IAO
transformait son refus en 400. Le refus 413 est maintenant conservé uniquement
à la sortie de ce lecteur de confiance, au moyen d'une erreur interne distincte.
Une erreur arbitraire de l'autorité ou du port d'exécution ne choisit pas le
statut de la réponse.

Les exceptions de l'autorité d'authentification sont normalisées en 401,
conformément à la révision 3 du contrat. Le message est constant et ne divulgue
pas de détail interne. Cela couvre la vérification initiale et celle qui précède
immédiatement l'admission, ainsi que la lecture et l'annulation.

Le même fichier de tests HTTP donne **24 PASS / 16 FAIL avant**, puis
**40/40 PASS après**. Les 16 échecs initiaux étaient deux refus de taille et
quatorze erreurs d'authentification. La régression de neuf fichiers donne
**265/265 PASS**, sans test ignoré ; elle conserve notamment les statuts
404/409/503, la portée d'identité, les délais et l'arrêt global. Les autorités et
services utilisent des doubles explicites ; le serveur et le transport HTTP
locaux sont réels.

Preuves : [avant](routes-red-receipt.json), [après](routes-green-receipt.json),
[régression](routes-regression-receipt.json).

### Registre historique

`AGENTS-STATUS.md` reçoit une note de continuité en tête. Son relevé de juillet
est conservé intégralement et n'est plus présenté sans réserve comme le statut
de novembre. Les conditions de déploiement coordonné restent applicables.

## Qualification intégrée locale

- TypeScript KARTA : **PASS**, sortie 0.
- Compilation KARTA : **PASS**, sortie 0.
- Revue indépendante des trois fichiers produit : aucun défaut bloquant établi.
- Reprise UI : trois tests ciblés PASS. L'UUID reste conservé tant qu'une
  annulation durable n'a pas été confirmée ; aucun déverrouillage optimiste ajouté.
- `git diff --check` : PASS pour le delta produit.
- Campagne KARTA complète : **5 389 PASS / 35 FAIL / 0 ignoré**, 5 424 cas recensés.

La campagne complète locale est donc **PARTIELLE**, pas PASS. Les 35 échecs sont
tous des refus système `listen EPERM` à la création de sockets Unix, dans trois
fichiers : cancellation 14, provider 10, response boundary 11. Aucun de ces
tests ni de leurs garanties n'est retiré ou modifié. La qualification complète
de la candidate doit être reçue dans la CI normale du dépôt.

Preuves : [types et compilation](karta-static-receipt.json),
[campagne complète](karta-full-receipt.json),
[classification des échecs](karta-full-analysis.json),
[reprise UI](ui-recovery-receipt.json), [revue](review-receipt.json).
Les nombres de campagnes qui se recouvrent ne sont pas additionnés.

Les journaux bruts et grands rapports sont conservés sous leur nom suivi de
`.gz`, sans modification de leurs octets décompressés. Le
[manifeste des archives](archive-manifest.json) relie leurs empreintes exactes
aux noms d'origine utilisés par les reçus. Les originaux de préparation restent
également présents dans l'espace de travail.

## Analyse d'impact

GitNexus 1.6.12 a indexé la base, résolu les symboles et leurs appelants, puis
réindexé le delta. La correction d'authentification est traitée comme CRITICAL
en raison de sa frontière de confiance, même lorsque le graphe classe certaines
fonctions LOW. Le graphe signale des parcours tronqués et des relations
interlangages non résolues ; FTS est indisponible. Les lectures des sources et
les tests complètent ces limites, sans transformer le graphe en preuve exhaustive.

Le contrôle du delta sélectionné avant l'ajout de ses journaux relève 86 symboles
et 12 parcours affectés, avec un risque HIGH. Les trois fichiers produit sont
ceux décrits ci-dessus. La comparaison demandée avec `origin/main`
(`ae84415b`) couvre aussi toute la consolidation préexistante : 3 331 fichiers,
25 999 symboles et 565 parcours, risque CRITICAL. Elle ne mesure donc pas la seule
taille de ce correctif. La PR doit cibler la branche de consolidation existante.
Les commandes et limites sont conservées dans
[le reçu du contrôle avant commit](gitnexus-precommit-receipt.json).

## Limites et suite d'intégration

Le CLI de cette base appelle `startApiServer` sans `iaoRuntime`. L'entrée native
`/iao/requests` conserve donc 503 sans injection explicite. Cela ne décrit pas
les autres parcours, notamment le Conseil. `/health` conserve sa signification
documentée de disponibilité des dépendances KARTA.

La branche historique `codex/t03-iao-local-transport-20261014`, relue à
`347ed23154cf40e70adab2142c5a91997e883c15`, n'injecte pas davantage cette composition.
Une autorité de session/espace, un port SMARANA durable et un producteur Fabric
RPC/2 qualifié après redémarrage restent nécessaires. Aucun composant factice
ne remplace ces garanties dans cette correction.

Le calcul erroné rapporté lors d'un ancien essai de modèles n'a pas été retrouvé
comme scénario exact reproductible dans ce lot. Il n'est pas déclaré corrigé.
`complete` reste distinct de `verificationStatus: unverified` et la présentation
conserve cette distinction.

Aucune migration distante, activation de modèle, fusion vers `main`, nouvelle
facturation ou mise en production n'est réalisée par ce lot. Les diagnostics
personnels d'infrastructure sont conservés dans le compte rendu privé ; ils ne
font pas partie des preuves publiques de code.
