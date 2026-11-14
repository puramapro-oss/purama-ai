# Recherche de connaissances publiques IAO

`knowledge_search` complète `web_search` dans KARTA. Il n’ajoute ni mémoire,
ni orchestrateur, ni collecte persistante. Les catalogues doivent tous réutiliser
le singleton exporté par `tools/knowledge-search.ts`.

## Périmètre réel

- Crossref : notices bibliographiques (DOI, titre, éditeur, type et date de
  publication quand disponibles). Aucun abstract ni article intégral retourné.
- Wikidata : entités trouvées par libellé/alias, avec ID, libellé et description.
  Aucun parcours automatique du graphe ni lecture des pages associées.
- Les sources doivent être choisies explicitement. Une requête publique suffit ;
  aucun secret, profil privé ou contenu personnel complet ne doit être envoyé.
- Les réponses indiquent `metadata_only`, `unverified` et
  `full_text_retrieved: false`. Une récupération réussie ne vérifie pas la
  véracité des données et ne signifie aucun accès universel.

Les erreurs et traces ne reproduisent pas le contenu brut du fournisseur.
`tracePolicy: metadata_only` utilise la protection de cycle existante de KARTA.
Les textes des sources restent des données non fiables, jamais des consignes
d’exécution ou une autorisation d’action.

## États et preuves

`complete` signifie que toutes les sources sélectionnées ont répondu avec un
format valide ; `empty` signifie qu’elles ont toutes répondu, sans résultat.
Les deux états ont `ok: true`, avec la vérification des contenus toujours
explicitement absente. Les identifiants et dates viennent du fournisseur ; une
année connue reste une année, et une date inconnue reste `null`.

En cas de panne partielle, le résultat garde les métadonnées reçues et les états
par source, mais expose **`status: partial`, `ok: false`**. C’est un choix
conservateur : `assertToolResult` doit empêcher le moteur de déclarer toute la
recherche réussie. Un appel direct peut examiner les métadonnées partielles ;
le moteur peut les traiter comme un échec et ne pas les réexposer. La reprise
doit cibler les sources nécessaires et respecter leurs délais. Une panne totale
produit `failed`, et une simulation `not_executed`, tous deux avec `ok: false`.
La simulation ne déclenche aucune requête.

Les doublons strictement identiques sont groupés en gardant leurs rangs. Deux
notices qui partagent un identifiant mais divergent restent visibles ; le titre
seul n’est jamais une clé d’identité. Aucune provenance n’est persistée ici :
le résultat peut être remis aux mécanismes existants SATYA/PRAMANA.

## Transport et limites

Endpoints HTTPS fixes, GET uniquement, redirections refusées, timeout de
15 secondes incluant le corps, limite de 524 288 octets par source. Les lecteurs
sont annulés lors des erreurs/interruptions et les résultats tardifs sont
refusés. Les paramètres sont copiés avant toute attente ; accesseurs, proxys,
prototypes personnalisés, tableaux creux, propriétés supplémentaires, sources
inconnues et valeurs hors bornes sont rejetés sans exposer leur contenu.

Il n’existe ni cache de requêtes, ni retry automatique, ni file d’attente.
Une source déjà occupée renvoie `busy`. Un délai restant renvoie `rate_limited`.
Chaque source utilise au plus une requête en vol **par instance de worker** ;
Crossref attend au moins 1 100 ms après la fin de la requête précédente,
Wikidata 500 ms. Les `Retry-After` et erreurs Wikidata `maxlag` sont respectés.
Un transport qui ignore l’annulation conserve sa réservation jusqu’à sa fin.

**Ce contrôle par processus ne prouve pas le respect d’un quota partagé par un
cluster.** Avant de multiplier les workers, employer la couche d’admission
partagée existante ou un worker de sortie unique. Ne pas instancier une nouvelle
factory par appel en production pour contourner ces limites.

## Licences et documentation consultée le 12 novembre 2026

- [Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/) : accès public sans clé. Les requêtes utilisent uniquement
  les champs nécessaires ; le User-Agent identifie le dépôt du projet.
- [Crossref métadonnées](https://www.crossref.org/documentation/retrieve-metadata/) : les métadonnées bibliographiques sont largement réutilisables ;
  les abstracts peuvent être protégés. `metadata_license` et `content_license`
  restent `null` pour les notices renvoyées, sans inventer de licence.
- [Crossref limites du 21 juillet 2026](https://community.crossref.org/t/refining-rest-api-limits-for-improved-stability-and-reliability/16137) : une recherche publique multi-résultats est limitée à 1 requête/seconde.
- [Wikidata accès](https://www.wikidata.org/wiki/Wikidata:Data_access) et
  [Wikibase API](https://www.mediawiki.org/wiki/Wikibase/API) : données CC0,
  User-Agent identifiable et `maxlag` ; `metadata_license: CC0-1.0` ne prétend
  pas attribuer une licence à une page Wikipedia ou à un article lié.
- [Limites Wikimedia](https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits) : limites dépendantes de l’identité du client, respect des réponses 429/503
  et de `Retry-After`.

Les sources décrivent des interfaces et conditions d’utilisation. Les tests
unitaires vérifient le contrat logiciel avec transports contrôlés ; le smoke
réel séparé vérifie uniquement les requêtes publiques observées à son horodatage.
