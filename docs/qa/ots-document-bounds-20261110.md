# Récupération bornée du PDF signé — candidat du 10 novembre 2026

Base exacte : `49959aea13568b6c9ef44f968afc815275778e24`. Ce correctif est préparé
dans une copie locale distincte. Il ne modifie pas les preuves de qualification
du gel précédent et ne constitue pas un déploiement.

## Défaut constaté et périmètre

Le stamper obtenait les métadonnées avec `docusealFetch`, puis lisait le PDF avec
`fetch` et `arrayBuffer`, sans plafond de réponse ni délai local. Le délai de
15 secondes de `deliverOtsStamp` borne l'attente du webhook ; il ne bornait pas
ces opérations internes et ne propageait pas leur annulation après la lecture
du corps de requête.

`ots-document.ts` remplace uniquement cette récupération dans
`contracts-ots-stamp`. Le client général `docusealFetch`, ses deux appels dans
`contracts-create`, son appel dans `contracts-cancel` et son appel dans le
webhook sont inchangés. Le GET de métadonnées que le webhook effectue avant
`deliverOtsStamp` reste une phase distincte, sans borne globale ajoutée ici.

## Politique interne retenue

| Phase | Plafond |
| --- | --- |
| Métadonnées JSON du document signé | 256 KiB d'octets réellement lus |
| PDF signé | 16 MiB d'octets réellement lus |
| Métadonnées + en-têtes PDF + corps PDF | Un budget monotone commun de 10 secondes |

Ces valeurs sont un choix technique conservateur, pas des limites annoncées par
DocuSeal. Le corpus réel de contrats doit être vérifié avant activation. La
mémoire du collecteur est bornée par un tampon à croissance géométrique plafonnée,
sans objet conservé par fragment ; un PDF n'est pas traité en continu jusqu'au hachage. Les plafonds ne
sont contrôlables ni par le corps HTTP ni par un en-tête utilisateur.

Le budget n'est pas réinitialisé entre les phases. Les gardes vérifient l'horloge
avant/après chaque lecture, après les réponses fetch, après le décodage des
métadonnées et à la restitution des octets. Le handler revérifie la validité avant
le hachage et avant de démarrer l'estampillage après le hachage asynchrone.
Les expirations produisent 504 et les interruptions 503 ; une réponse trop grande
ou incohérente produit 502. Aucune preuve ni écriture n'est déclenchée pour ces
corps refusés. Les erreurs réseau génériques conservent la réponse 500 assainie
du stamper ; les erreurs HTTP de métadonnées sont refusées sans lire un corps
d'erreur fournisseur et produisent 502.

Le délai de 10 secondes ne couvre pas les opérations DB précédentes ni la durée
d'une opération OpenTimestamps déjà démarrée. Il ne crée aucune transaction,
outbox, garantie d'exécution unique ou annulation physique d'un effet distant.

## Réutilisation du transport et compatibilité

`request-body.ts` possède une seule boucle de lecture bornée. `readRequestText`
conserve son adaptateur UTF-8 incrémental strict, son BOM exact pour HMAC, les
codes 400/408/413, le contrôle de longueur et le refus des flux vides abusifs.
`readBoundedBytes` utilise la même boucle avec un collecteur binaire ; le PDF ne
subit aucun décodage de texte. Chaque fragment est copié dans l'accumulateur avant
la lecture suivante pour ne pas dépendre d'un tampon réutilisé par le producteur.
La croissance géométrique évite qu'une fragmentation en millions de petits
morceaux crée autant d'objets conservés. Une régression vérifie 65 537 fragments
d'un octet issus du même tampon fournisseur, avec une empreinte finale exacte.

L'annulation du fetch est signalée et mise en concurrence avec sa promesse. Le
lecteur est annulé et libéré sans attendre une promesse de cancellation bloquée.
Une réponse fetch arrivée après l'échec est annulée et ne reprend pas le travail.
La consommation du corps utilise une seule course avec l'arrêt pour tout le flux,
sans réaction de promesse retenue pour chaque fragment. L'erreur d'arrêt est
mémorisée : une lecture tardive ne peut ni écrire dans le collecteur ni terminer
un résultat après l'interruption, même si le contrôle de l'horloge seul ne la
reflète pas encore.

Le jeton PDF reste réservé à l'origine exacte configurée ; les URL avec
identifiants et les protocoles précédemment interdits restent refusés. Les
redirections du PDF restent interdites. Le nouveau chemin de métadonnées conserve
les en-têtes DocuSeal et refuse également les redirections de son jeton.

Pour une réponse dont `Content-Encoding` n'est ni absent ni `identity`,
`Content-Length` peut décrire les octets encodés alors que `fetch` fournit les
octets décodés. Le plafond reste appliqué aux octets effectivement lus ; la
comparaison de longueur et le rejet anticipé fondés sur cette longueur encodée
sont désactivés dans ce seul cas. Les requêtes entrantes conservent leur contrôle
strict existant. Les tests gzip/br représentent des réponses déjà décodées ; ils
ne certifient pas le comportement d'un proxy déployé.

## Preuves locales

- Avant correction produit : 24 contre-tests ciblés, 2 PASS et 22 FAIL. Les
  positifs confirment les octets binaires et la frontière exacte ; les échecs
  montrent les faux succès après dépassement/expiration/interruption ou une
  attente non bornée. Il ne s'agit pas de 22 défauts indépendants.
- Quatre cas supplémentaires de réponses décodées ont été exécutés avant la
  correction : l'acceptation de petites réponses était déjà correcte mais les
  lecteurs restaient verrouillés ; les dépassements décodés étaient acceptés.
- Un raffinement intermédiaire a reproduit deux faux rejets lorsque la longueur
  encodée dépassait le plafond décodé. La condition a été corrigée, sans changer
  les contrôles de longueur des requêtes entrantes.
- `npm run test:contracts-auth` : 134 PASS sur le collecteur final, dont les
  31 nouveaux cas PDF ; aucun
  échec, cas ignoré ou annulation.
- `npm run test:contracts-security` : 195 PASS ; aucun échec, cas ignoré ou
  annulation. Les assertions existantes n'ont pas été assouplies.
- Lint ciblé des quatre fichiers TS/MJS : PASS, sans avertissement.
- Contre-mesure indépendante du lecteur, Node 24 avec heap limité à 128 MiB :
  pour 100 000 fragments d'un octet, le heap après GC à la dernière lecture passe
  de 46 693 304 octets avant correction à 11 489 744 octets après correction.
  Les points intermédiaires corrigés restent entre 11 489 744 et 11 506 880
  octets. Les deux mesures ont conservé l'identité des sources mesurées ; elles
  qualifient ce scénario synthétique, pas la charge d'une production réelle.
- Types stricts des helpers via TypeScript : PASS avec une déclaration explicite
  et minimale de `Deno.env.get`, sans prétendre exécuter Deno par cette commande.
- Deno 2.9.6 préexistant, sans installation : les cinq recettes
  `runtime.ts`, `webhook-runtime.ts`, `webhook-donor-runtime.ts`,
  `body-runtime.ts`, `delivery-runtime.ts` passent **54/54**, vérification des
  types incluse, sous `--cached-only --no-prompt --deny-net --deny-run`.
  Leur configuration remplace les ports serveur/DB/fournisseur par les fixtures
  existantes et conserve la bibliothèque OTS réelle avec calendrier simulé.
  La première passe de types avait révélé le besoin de vérifier explicitement
  que l'identifiant de soumission est un nombre ou une chaîne ; ce garde a été
  ajouté, sans cast et sans `--no-check`.

Ces nombres décrivent des commandes distinctes et des couvertures qui se
recoupent. Ils ne doivent pas être additionnés pour présenter des parcours
utilisateur uniques. Les 1 547 tests KARTA et les 23 tests SQL n'ont pas été
réexécutés : leurs sources, dépendances et fixtures concernées sont inchangées.

## Limites de qualification

GitNexus : impacts préalables disponibles sur le graphe précédent (lecteur LOW),
mais graphe courant indisponible après les échecs mémoire de la composition
précédente. Les tentatives `detect-changes` du candidat séparé sont conservées
comme PARTIEL ; l'inventaire Git et la fermeture des appelants complètent la
revue. Aucun nouvel index n'a été installé ou reconstruit pour ce correctif.

NON TESTÉ : DocuSeal réel, volumes du corpus réel, latence fournisseur, passerelle
Edge hébergée, secrets/ACL de production, confirmations Bitcoin et déploiement.
La qualification isolée ne remplace pas ces contrôles avant activation.

Références du comportement de décompression :
[Fetch Standard](https://fetch.spec.whatwg.org/),
[constat dans le projet Undici](https://github.com/nodejs/undici/issues/2514) et
[constat dans le projet Deno](https://github.com/denoland/deno/issues/12291).
