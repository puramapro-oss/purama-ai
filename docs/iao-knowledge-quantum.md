# IAO : connaissances publiques et calcul quantique local

Date : 12 novembre 2026. Extension du candidat consolidé PR45, initialement
examiné à `8259b84e65ca89b01bd1b1fc46576cb60bb8a1ec`, puis réconcilié avec
`cbd60006552f27771ef0f8b67623087c296fcf67`. Les cinq fichiers de cette avancée
amont ne touchent ni KARTA ni les quatre points de raccord de ce lot.

## Périmètre livré

Ce lot ajoute deux capacités au KARTA existant : `knowledge_search` et
`quantum_simulate`. Il conserve les catalogues, les permissions d'agents et la
politique de traces existants. Il ne crée pas une autre IA, une autre application,
une seconde mémoire ou un autre orchestrateur.

Les preuves du lot sont dans `qa/knowledge-quantum-20261112/`. Les contrôles locaux,
les appels publics réels, les simulations, la CI distante et la production sont
des niveaux de preuve distincts. Le fichier `verification.json` porte les
commandes et leurs résultats constatés, lorsqu'ils sont disponibles.

Contrôles locaux finalisés : 248 tests ciblés réussis dans neuf fichiers (dont
147 nouveaux cas), typage strict des nouveaux modules et du script de vérification,
72 comparaisons indépendantes Qiskit et deux requêtes publiques du code final.
Le typage global et la suite KARTA complète ont été interrompus par les limites
de ressources du runner local ; l'installation des dépendances du site a rencontré
`ENOSPC`. Ces contrôles ne sont pas présentés comme réussis localement. La CI
distante et son commit exact doivent être lus séparément.

### Limite d'intégration importante

Le cycle KARTA actuel demande une décision au modèle, exécute les outils puis
conserve des résumés de statut. Les résultats complets des deux nouveaux outils
ne sont pas automatiquement renvoyés à un second appel du modèle, à SMARANA ou
au chat `agent-chat`. La politique `metadata_only` empêche leur exposition dans
les journaux. Ajouter un outil au catalogue ne prouve donc pas un parcours
conversationnel de recherche puis de synthèse.

Les agents existants gardent leur sélection d'outils. Un agent personnalisé peut
sélectionner les nouvelles capacités après intégration et déploiement du candidat.
Une activation de compte, un déploiement ou un test matériel ne découle pas de la
présence de ces fichiers dans Git.

Le registre ignore désormais les propriétés héritées de l'objet JavaScript.
Avant correction, les trois noms `__proto__`, `constructor` et `toString`
renvoyaient trois entrées non déclarées ; après correction ils n'en renvoient
aucune. Un test de régression vérifie aussi que les outils autorisés restent
résolus. Cette preuve porte sur le filtrage des noms, sans prétendre démontrer
une exécution arbitraire dans la version précédente.

## 1. Recherche de connaissances

Entrée :

```json
{
  "query": "quantum computing",
  "sources": ["crossref", "wikidata"],
  "limit": 2,
  "language": "en"
}
```

`sources` est explicite. La requête est limitée à 1 000 caractères et chaque
source à cinq résultats. Les deux fournisseurs peuvent répondre en parallèle ;
chaque fournisseur possède une admission bornée dans le processus KARTA.

| Source | Lecture effectuée | Identité stable | Limite de la lecture |
| --- | --- | --- | --- |
| Crossref | Métadonnées bibliographiques sélectionnées : titre, DOI, éditeur, type, date disponible | DOI normalisé | Aucun article, abstract ou PDF téléchargé ; aucune licence du texte intégral présumée |
| Wikidata | Recherche de libellés et descriptions d'entités | QID | Ni tout le graphe, ni toutes les références de l'entité ; données structurées CC0 |

Chaque résultat contient la source, l'identifiant canonique, une URL construite
sur un domaine connu, la date de réception et la date de publication quand elle
est fournie. Une date partielle reste partielle : une année n'est pas transformée
en date au 1er janvier. Des métadonnées exactement identiques sont regroupées,
avec les rangs des réponses conservés ; les descriptions contradictoires restent
visibles. Deux titres similaires ne suffisent pas à fusionner deux documents.

Le résultat indique `verification_status: unverified`, `content_kind:
metadata_only`, `source_text_trust: untrusted_data` et `full_text_retrieved:
false`. La récupération d'une notice prouve qu'elle a été reçue ; elle ne valide
pas toutes les affirmations du document.

### Comportement en cas de panne

- Recherche complète avec résultats : `status: complete`, `ok: true`.
- Toutes les sources ont répondu, sans résultat : `status: empty`, `ok: true`.
- Une partie seulement répond : `status: partial`, `ok: false`, avec les résultats
  déjà reçus et l'état de chaque source conservés.
- Aucune source exploitable : `status: failed`, `ok: false`.
- Mode d'essai KARTA : `status: not_executed`, aucune requête réseau.

KARTA refuse `ok: false` comme réussite de mission. Ce choix évite de déclarer
une recherche fédérée entièrement réussie lorsqu'un fournisseur manque.

### Contraintes de transport et de confidentialité

Les destinations sont fixes ; aucun endpoint, en-tête d'authentification,
identifiant d'utilisateur ou secret n'est accepté dans les paramètres du modèle.
Les redirections sont refusées. Le délai inclut le téléchargement et le parsing
du corps, limité à 512 Kio par source. Les accesseurs, proxies, prototypes
particuliers, tableaux creux et paramètres inconnus sont refusés. Les entrées
sont copiées avant toute attente réseau.

Le singleton de recherche partage son admission entre les agents d'un même
processus. Crossref est limité à une requête en vol et à au moins 1,1 seconde
après la précédente réponse. Les délais `Retry-After` sont respectés. Une requête
en cours entraîne un état `busy`, sans file d'attente non bornée ; aucune reprise
automatique n'est cachée. Un transport qui ignore l'annulation garde sa
réservation jusqu'à son arrêt réel.

**La limite est locale au processus.** Plusieurs workers doivent partager une
admission distribuée existante ou utiliser un point de sortie unique avant une
mise en charge. Ce lot n'établit pas une garantie de quota à l'échelle du cluster.
Il n'ajoute ni cache de requêtes, ni copie de corpus, ni stockage de résultats.

## 2. Simulation de circuits quantiques

Entrée d'exemple pour une paire de Bell :

```json
{
  "qubits": 2,
  "gates": [
    { "gate": "H", "target": 0 },
    { "gate": "CX", "control": 0, "target": 1 }
  ],
  "shots": 1024,
  "seed": 42
}
```

Le résultat attendu idéal donne des probabilités de 1/2 pour `00` et `11`, et
zéro pour `01` et `10`. Les nombres de tirages peuvent fluctuer ; une graine
fixée rend cette partie reproductible.

Le simulateur s'exécute sur un ordinateur classique. Il fait évoluer un vecteur
d'état complexe en virgule flottante, depuis l'état entièrement nul, puis mesure
en base computationnelle en fin de circuit. Les limites sont : dix qubits,
128 portes et 8 192 tirages. Les portes H, X, Y, Z, RX, RY, RZ, CX et CZ sont
prises en charge. Qubit 0 est le bit de poids faible.

Chaque réponse déclare explicitement :

```json
{
  "execution_kind": "local_simulator",
  "backend_kind": "classical_statevector",
  "physical_quantum_hardware": false,
  "quantum_advantage_demonstrated": false,
  "external_api_calls": 0
}
```

Elle inclut les probabilités, les comptages, la norme de l'état et l'empreinte de
l'entrée validée. Le générateur de tirages est reproductible et non
cryptographique. La fonction `exportQuantumCircuitOpenQasm` exporte le circuit
en OpenQASM 2 avec mesure finale, sans le soumettre à un fournisseur.

Un cycle KARTA en mode `simulation` saute normalement tous ses outils. Un appel
direct au simulateur peut, lui, faire un vrai calcul local même avec ce mode.
Un cycle KARTA `live` exécutant cet outil reste un calcul scientifique simulé :
`live` ne désigne pas un processeur quantique physique.

### Vérification indépendante

`karta/scripts/verify-quantum-qiskit.py` compare les probabilités à Qiskit après
lecture de l'OpenQASM par son parseur strict. Le script ne réutilise pas les
matrices TypeScript pour produire sa référence. Qiskit est une dépendance de
vérification séparée ; le runtime KARTA n'a pas de nouvelle dépendance.

Commande depuis `karta/`, avec un environnement Python de vérification où les
dépendances du fichier `scripts/requirements-quantum-verification.txt` sont déjà
installées :

```text
python scripts/verify-quantum-qiskit.py --output ../qa/knowledge-quantum-20261112/qiskit-oracle.json
```

Le rapport contient les versions, les empreintes de code, les circuits testés,
la tolérance et l'écart observé. Ce contrôle valide des circuits sur simulateurs ;
il ne mesure ni l'intelligence générale d'IAO ni un avantage quantique matériel.

## 3. Extension hybride : conditions d'une exécution sur QPU

Le prochain raccord matériel doit réutiliser l'admission serveur, les budgets,
l'arrêt et la réconciliation de KARTA. Une valeur d'autorisation proposée par le
modèle ne constitue pas un mandat.

Pour IBM Quantum Runtime, les paramètres nécessaires incluent un compte, une
instance explicitement choisie, des identifiants conservés côté serveur et un
backend compatible. Un budget accepté, des limites de temps/tirages, un
identifiant idempotent de soumission et une réconciliation après réponse perdue
doivent précéder toute activation. Ne pas sélectionner implicitement une
instance payante à partir de credentials sauvegardés.

Les preuves futures doivent distinguer `classical`, `local_simulator`,
`cloud_simulator`, `qpu`, `hybrid_service` et `mock`. Un job QPU doit conserver
son fournisseur, son appareil, son identifiant et son état final. Un dry-run
fournisseur contenant des données factices ne vérifie pas une expérience.

L'utilité sera comparée à une référence classique sur des problèmes précis :
qualité de solution, préparation, transfert, transpilation, attente, exécution,
répétitions, coût et erreurs. Un résultat de Bell correct ne suffit pas à
démontrer une accélération d'une tâche réelle.

## 4. Couverture des connaissances à étendre

L'objectif est une couverture croissante de sources identifiées, utilisables et
pertinentes. L'accès aux données et le calcul quantique sont deux capacités
indépendantes. Une API d'IA ne fournit pas automatiquement son corpus privé
d'entraînement ; un protocole MCP ne crée pas de droits sur une base externe.

| Capacité suivante | Réutilisation dans PURAMA | Critère avant activation |
| --- | --- | --- |
| data.gouv.fr, OpenAlex, arXiv | Même outil de recherche et même enveloppe de provenance | Adapter les quotas, l'identité documentaire et les licences ; tester le transport |
| Documents et comptes personnels | Connecteurs et permissions existants ; SMARANA/AKASHA pour la mémoire autorisée | Identité, droits, finalité, révocation, séparation des utilisateurs et suppression |
| Synthèse conversationnelle sourcée | Parcours IAO/KARTA actuel | Canal privé de résultats, budget d'inférence, données externes traitées comme non fiables, citations et limites présentées à l'utilisateur |
| Indexation sélective | Stockage et mémoire existants | Déduplication, version, fraîcheur, licence, coût de réindexation et effacement |
| Calcul QPU | Même ordonnanceur KARTA et mêmes preuves SATYA/PRAMANA | Compte, admission serveur, budget, reprise idempotente et comparaison indépendante |

Ces lignes sont des travaux restants et des critères d'acceptation, pas des
connecteurs déjà implémentés. La recherche actuelle porte sur deux catalogues
publics seulement. Les comptes privés, toutes les données d'Internet et les bases
internes d'autres IA ne sont pas connectés par ce lot.

## Sources officielles consultées

1. Crossref, API REST : https://www.crossref.org/documentation/retrieve-metadata/rest-api
2. Crossref, conditions de réutilisation des métadonnées : https://www.crossref.org/documentation/retrieve-metadata/
3. Crossref, limites ajustées le 21 juillet 2026 : https://community.crossref.org/t/refining-rest-api-limits-for-improved-stability-and-reliability/16137
4. Wikidata, accès aux données : https://www.wikidata.org/wiki/Wikidata:Data_access
5. Wikimedia, API Wikibase : https://www.mediawiki.org/wiki/Wikibase/API
6. IBM, simulation Qiskit : https://quantum.cloud.ibm.com/docs/en/qiskit/simulate-with-qiskit-sdk-primitives
7. IBM, connexion Runtime : https://quantum.cloud.ibm.com/docs/en/ibm-quantum-compute/initialize-account
8. IBM, validation d'un avantage quantique : https://www.ibm.com/quantum/blog/quantum-advantage-era
9. MCP, autorisation : https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization

Les versions et conditions d'accès des fournisseurs peuvent évoluer. La
configuration opérationnelle doit être vérifiée lors de l'activation effective.
