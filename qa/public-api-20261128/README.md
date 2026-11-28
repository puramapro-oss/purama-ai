# Qualification API IAO — 28 novembre 2026

Base : `272074017383c9a8f8c817d3bdea945cf692b3bc` ; branche `feat/iao-public-api-access-20261128`.

## Résultats locaux

| Contrôle | Statut | Preuve |
|---|---|---|
| HTTP public, SQL et intégration complète avec fournisseur de test | PASS — 88/88, trois fichiers | `targeted.log` |
| Concurrence PostgreSQL 18.7, connexions et verrous observés | PASS — 7/7 | `native/receipt.json`, `native/public-api-native.tap.txt` |
| Suite KARTA entière | PARTIEL — 6 167/6 202 ; 35 échecs `listen EPERM` sur les sockets Unix | `karta-tests.json.gz`, `verification.json` |
| Typage et compilation KARTA | PASS — deux codes de sortie 0 | `verification.json`, `typecheck.log`, `build.log` |
| Contrat OpenAPI 3.1 | PASS — validateur structurel 0.9.0 | `openapi-validation.json` |
| Fournisseurs payés, facturation et déploiement | NON TESTÉ | Aucun de ces effets n'a été déclenché. |

Les 88 nouveaux tests sont inclus dans les 6 202 de la suite KARTA ; les sept tests PostgreSQL natifs constituent une exécution séparée. Les compteurs du rapport Vitest décrivent 245 fichiers, dont trois présentent les blocages de sockets Unix. Aucun test n'a été retiré ou ignoré pour obtenir un succès artificiel. Le rapport compressé conserve les assertions et erreurs complètes.

Les tests d'intégration utilisent les routes du vrai serveur, le runtime de projet, le store et les migrations de production, et le SDK fournisseur installé. Seul le réseau fournisseur est remplacé par des réponses de test. Ils prouvent le raccordement et ses gardes, sans attester une inférence distante payée.

## Revue indépendante

La revue a conduit à deux contre-épreuves : une clé limitée à l'annulation ne doit pas lire une réponse terminée ; un arrêt HTTP ne doit pas abandonner le settlement d'un appel déjà envoyé. Les corrections figurent dans le transport et le drain du runtime. Leurs tests font partie des 88 réussites.

La séparation entre projet et propriétaire, les méthodes RPC fermées, la réautorisation SQL, les limites, les reçus après révocation et l'absence d'accès administratif ont également été relus. Les empreintes des sources qualifiées sont enregistrées dans `verification.json`.

## Impact et continuité

Les analyses avant modification de `startApiServer`, `handleRequest`, `drainRequests`, `createPublicApiRuntime` et `operation` figurent dans `gitnexus/`. L'extension FTS est indisponible ; certains appels dynamiques ne sont pas résolus par le graphe. Une recherche des appels dans le code et les tests complète ces limites.

L'analyse du changement préparé indique **HIGH**, 13 parcours affectés lors de la première réception, dont les entrées HTTP et la nouvelle autorité. Le risque a été signalé avant finalisation. La comparaison avec `origin/main` indique **CRITICAL**, car cette branche principale est très antérieure à la pile de travail existante : 3 585 fichiers historiques sont concernés. Ce résultat n'est pas présenté comme le périmètre créé aujourd'hui. La proposition cible la branche fournisseurs existante, sans fusion globale vers `main`.

L'index final conserve les avertissements de limites du graphe. Les comptes ne constituent pas une preuve d'exhaustivité ; les tests et la revue des frontières restent nécessaires.

## Conditions encore ouvertes

L'activation publique, les certificats et le domaine de production, les contrats fournisseurs, les tarifs clients, le débit commercial et les délégations ONE/OAuth ne sont pas établis par ces essais. Le budget demeure partagé par propriétaire dans CHEF ; le plafond par projet porte sur une opération estimée. La révocation interdit les réservations suivantes, sans rappeler une requête déjà envoyée.

Les résultats de CI, une fois disponibles, doivent être rattachés à leur SHA exact et ne pas remplacer les résultats locaux historiques.
