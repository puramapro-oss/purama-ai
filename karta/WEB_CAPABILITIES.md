# IAO — accès aux services et aux sites

Date de revue : 1er novembre 2026.

## Périmètre de cette proposition

Ce lot ajoute un **planificateur déterministe de capacités web** à KARTA. Il choisit
une voie de préparation à partir d'une intention et de faits résolus côté serveur.
Il ne pilote pas de navigateur, ne crée aucun compte, ne génère aucune clé API et
ne confère aucune autorisation d'exécution. Ses résultats portent explicitement
`phase: "planning"` et `executionPerformed: false`.

Le planificateur est fourni comme une factory d'outil : l'application doit lui
injecter un résolveur de contexte de confiance. Il n'est pas accordé par défaut
aux agents personnalisés et ne prend pas des champs `authorized` ou des secrets
dans les arguments du modèle. Un contexte absent ou invalide doit rester un
blocage explicite.

L'objet de ce lot est d'éviter trois erreurs lors de la future intégration :
inventer un accès disponible, contourner une autorisation par un autre transport,
ou répéter une opération dont l'effet précédent est inconnu.

## Existant réutilisé

Base de travail : `codex/purama-chef-hardening-20260927`, commit
`fd76a082874f3498b618b2543c44fa6d61bdfac7`.

- KARTA : `engine/types.ts`, `engine/tool-input.ts`, registres et outils existants.
- CHEF : brief, graphe de tâches, budget, persistance, leases, worker externe,
  vérificateur indépendant et collecte de preuves.
- Les permissions de fichiers `ChefDriverRequest.accessMode` / `allowedPaths`
  ne sont pas des autorisations d'accès aux comptes ou sites.
- Aucun deuxième moteur de mission, coffre ou système de facturation n'est créé.

Les branches distantes doivent être distinguées :

| Proposition existante | Situation observée le jour de la revue |
| --- | --- |
| [PR 1 — sécurité IAO/KARTA](https://github.com/puramapro-oss/purama-ai/pull/1) | Ouverte, non fusionnée ; contient déjà plusieurs corrections des statuts et reprises |
| [PR 2 — PURAMA CHEF](https://github.com/puramapro-oss/purama-ai/pull/2) | Ouverte, non fusionnée ; base de ce lot |
| [PR 3 — OAuth et sécurité](https://github.com/puramapro-oss/purama-ai/pull/3) | Ouverte, non fusionnée ; réconciliation requise avant nouvelles connexions réelles |

L'audit de `main` au commit `d116dc8a6429ea76c67167a195eb3f723f2251fb`
ne décrit donc pas à lui seul toutes les corrections préparées. L'état des branches
ne prouve pas l'état du Mac, d'Hostinger ou de la production.

## Contrat de confiance

L'intention du modèle reste limitée au service, à l'action et à l'identifiant
d'opération. Le contexte serveur apporte l'identité, les droits, les capacités
réelles, la fraîcheur des preuves et le budget estimé.

Le résolveur doit construire ce contexte depuis les sources authentifiées de
l'application. Déplacer un booléen `authorized: true` fourni par le modèle dans un
objet nommé « contexte serveur » ne transforme pas ce booléen en autorisation.

La factory borne l'attente du résolveur à cinq secondes et lui transmet un
`AbortSignal`. Le résolveur doit respecter ce signal pour arrêter ses propres
requêtes ; le délai du wrapper ne peut pas tuer une entrée/sortie qui l'ignore.
Les messages bruts d'erreur du résolveur ne sont pas exposés.

Une route proposée ne constitue jamais un ticket d'exécution. Le futur worker
doit relire les droits, l'arrêt, la session, le budget et l'état d'opération au
moment d'agir. Les paramètres métier précis doivent être liés à l'opération dans
le stockage serveur ; un même identifiant ne doit pas désigner deux demandes
différentes.

Les secrets restent dans le mécanisme de secrets du serveur. Le plan, les prompts,
les traces et les reçus ne doivent contenir ni mot de passe, ni token, ni cookie,
ni clé API. Les identifiants utilisés par l'outil sont des références opaques.

## Routes à raccorder

| Route | Usage | Conditions importantes |
| --- | --- | --- |
| API officielle | Action ou lecture documentée | Droits du compte, scopes, service et opération compatibles |
| MCP | Outil exposé par un serveur autorisé | Authentification et autorisation propres au serveur ; MCP ne crée pas de droits |
| WebMCP | Outil structuré proposé par le site | Site et navigateur compatibles ; capacité effectivement présente |
| Parcours navigateur validé | Automatisation connue | Session séparée, recette et domaine vérifiés, preuves de résultat |
| Adaptation navigateur | Préparation d'un parcours changé ou nouveau | Observation, réparation bornée, nouvelle qualification avant usage |
| Intervention humaine ciblée | Connexion, consentement ou challenge imposé | Reprise après actualisation du contexte serveur |

Une indisponibilité technique peut justifier une autre route autorisée. Un refus
d'autorisation, une suspension de compte ou un résultat précédent incertain ne
justifient pas de changer de moteur pour recommencer la même opération.

Le sélecteur conserve l'ordre de priorité du tableau et peut examiner une autre
route validée si la première manque d'identifiants, est périmée ou dépasse le
budget. Il ne prétend pas calculer un optimum global de coût et de qualité.
Un coût inconnu ne vaut pas zéro. Chaque alternative conserve ses propres droits,
son propre compte et ses propres preuves ; aucun credential n'est transféré.

Dans ce premier contrat, `account.challenge` désigne un blocage global du compte
et bloque tous les canaux. Le résolveur ne doit pas convertir automatiquement un
CAPTCHA d'une page en interdiction globale si une API indépendante reste
expressément autorisée. Les challenges propres à une route demandent un contrat
plus fin avant leur prise en charge.

Pour une opération incertaine, vérifier l'état distant avant toute nouvelle
création : compte, clé, formulaire ou publication. Une requête interrompue peut
avoir produit son effet avant la perte de réponse. Sans idempotence proposée par
le fournisseur, ne pas promettre « exactement une fois ».

## Choix techniques étudiés

La documentation et les licences ci-dessous ont été consultées. Aucun benchmark
comparatif ni test sur compte réel n'a été effectué pour cette sélection.

| Projet | Fonction documentée | Position pour IAO |
| --- | --- | --- |
| [Playwright](https://playwright.dev/docs/best-practices) / [Playwright MCP](https://github.com/microsoft/playwright-mcp) | Navigation, actions structurées, locateurs accessibles, tests | Base pour les parcours déterministes ; Apache-2.0 |
| [Stagehand](https://github.com/browserbase/stagehand) | Observation, action, extraction, adaptation de sélecteurs | Candidat TypeScript pour la couche adaptative ; MIT, utilisation locale possible |
| [browser-use](https://github.com/browser-use/browser-use) | Agent Python, sessions, sauvegarde et rejeu de parcours | Alternative si un worker Python existant le justifie ; MIT |
| [Skyvern](https://github.com/Skyvern-AI/skyvern) | Workflows visuels et SDK compatible Playwright | Option pour un besoin métier démontré ; cœur AGPL-3.0 |
| [WebMCP](https://developer.chrome.com/docs/ai/webmcp) | Outils déclarés par le site | Proposition de standard, pas un accès universel aux sites |
| [OpenHands SDK](https://github.com/OpenHands/software-agent-sdk) | SDK/Agent Server Python, client TypeScript et API REST, espaces isolés | Option d'exécutant sous CHEF ; MIT ; aucun remplacement d'IAO |
| [Nango](https://nango.dev/docs/guides/platform/self-hosting/self-hosting) | Gestion de connexions | Ne pas ajouter par défaut : offre gratuite auto-hébergée limitée, offre complète Enterprise, licence ELv2 |

Le choix minimal proposé est : conserver CHEF/KARTA, utiliser les API déjà
présentes, puis qualifier un seul worker navigateur. Playwright et Stagehand
sont des candidats complémentaires ; cumuler plusieurs agents navigateur n'est
pas une preuve de robustesse supplémentaire.

### Adaptation et consommation

[Stagehand v4 act](https://docs.stagehand.dev/v4/basics/act) distingue l'instruction
en langage naturel (inférence) et l'action structurée rejouée (sans inférence).
`selfHeal` peut réinterpréter une action dont le sélecteur échoue. Cela ne vérifie
pas à lui seul que l'effet métier d'un bouton est resté identique.

Le [cache serveur Browserbase](https://www.browserbase.com/changelog/caching-configurable)
est une fonction hébergée distincte. Ne pas le présenter comme un cache cloud
gratuit inclus dans un déploiement local. Le coût du modèle et du navigateur
reste à mesurer sur le parcours réel.

Priorités d'optimisation : API ou code déterministe pour les tâches connues,
réutilisation de parcours qualifiés, contexte ciblé, concurrence bornée et
escalade du modèle seulement si nécessaire. Mesurer le coût par résultat vérifié,
en incluant tentatives, navigateur, modèles auxiliaires, stockage et vérification.
Une estimation n'est ni une réservation de budget ni une dépense mesurée.

### Connexions et secrets

La [spécification d'autorisation MCP](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
conserve les frontières d'identité, de ressource et de permission. L'enregistrement
d'un client OAuth ne crée pas un compte utilisateur ni un abonnement.

[Playwright](https://playwright.dev/docs/auth) rappelle que les états de session
peuvent permettre d'usurper le compte. Le serveur Playwright MCP précise qu'il
n'est pas une frontière de sécurité. L'isolation des sessions, le filtrage réseau,
les droits et le coffre doivent donc être imposés par l'hôte, pas par un prompt.

Les étapes MFA, passkey, CAPTCHA, consentement ou identité requises par un service
restent des étapes à satisfaire selon son parcours officiel. Elles ne deviennent
pas des permissions parce qu'un agent sait cliquer.

## Validation de ce lot

Les résultats d'exécution définitifs et leurs limites sont enregistrés dans
`test/evidence/web-capabilities-20261101.json` après les contrôles finaux.

Les tests ciblés doivent couvrir l'isolation des identités, les champs forgés,
les droits expirés, les budgets invalides, l'incertitude d'effet, le choix des
routes et l'absence de secrets dans les sorties. Des cas générés vérifient des
invariants ; ils ne sont pas des milliers d'essais sur des sites réels.

Les tests unitaires KARTA remplacent les identifiants réels et refusent les appels
fournisseurs. Une suite verte n'établit donc ni connexion réelle, ni fonctionnement
OAuth en production, ni fonctionnement de Stagehand ou d'un site tiers.

## Conditions de livraison du mode complet

1. Réconcilier les corrections OAuth et les branches de sécurité existantes.
2. Raccorder le résolveur à VAJRA/aux comptes réels avec droits et preuves
   spécifiques à chaque route, sans inscrire de secrets dans les arguments.
3. Qualifier un premier worker navigateur isolé avec session par utilisateur,
   domaines autorisés, contrôle réseau et arrêt effectif.
4. Réaliser un premier parcours à faible impact : compte autorisé, lecture ou
   téléchargement, validation structurée, preuve de résultat et reprise après
   expiration de session.
5. Ajouter ensuite la préparation de comptes et clés par fournisseur, avec
   idempotence/réconciliation et reprise humaine ciblée lorsque nécessaire.
6. Vérifier le parcours complet dans PURAMA ONE et mesurer succès, faux succès,
   coût, délai et interventions avant activation.

Ce lot ne fusionne aucune PR préalable, ne modifie aucune production et n'annonce
pas le mode complet comme disponible. Les droits, l'accès aux comptes et les
sites cibles devront être effectivement raccordés et testés.

## Recherche personnalisée et sources — lot du 10 novembre 2026

L'outil existant `web_search` reste le point d'accès à Tavily. Ce lot prolonge
la correction de réponse et de transport de la PR #26, au commit de départ
`a65151540557719ec8adb1bc755f2d05d9e63d3f`. Il ne crée ni moteur de recherche,
ni registre de preuves, ni mémoire ou fournisseur supplémentaire.

### Contrat compatible

Un appel historique `{ "query": "question" }` conserve exactement la sortie
`{ results: [{ title, url, snippet }] }`. Le format enrichi est demandé avec
`response_format: "evidence"`. Les agents statiques et le registre d'agents
personnalisés utilisent le même objet `webSearchTool`.

| Paramètre optionnel | Portée |
| --- | --- |
| `response_format` | `legacy` ou `evidence` ; ancien format par défaut |
| `language` | Code court tel que `fr`, `en`, `zh-cn` ; préférence de classement, sans exclusion automatique des autres langues |
| `time_range` | `day`, `week`, `month`, `year` ; fenêtre demandée de publication, sans garantie sur les résultats dépourvus de date |
| `max_age_hours` | Entier de 0 à 720 ; âge maximal demandé de la copie du fournisseur, distinct de la date du document |
| `include_domains` | De 1 à 10 domaines explicites ; mode fournisseur restrictif |
| `exclude_domains` | De 1 à 10 domaines explicites ; exclusion incompatible avec une inclusion entièrement couverte refusée |

Les listes sont validées et normalisées, y compris les noms de domaine
internationaux. Elles ne constituent pas une autorisation réseau pour un futur
lecteur de pages. Le validateur refuse URL, chemins, ports, identifiants, tableaux
creux, propriétés héritées, accesseurs au premier niveau et champs non reconnus avant le transport.
Une copie des paramètres propres est réalisée avant les attentes asynchrones.
Les détails d'une entrée invalide ne sont pas recopiés dans l'erreur publique.

Le mode enrichi demande explicitement une recherche `basic`, sans paramètres
automatiques, réponse générée, page brute ni images. Il conserve la limite de
cinq résultats, le délai total de 30 secondes et la borne de 1 Mio. Il ajoute
les métadonnées de date et de consommation disponibles dans la réponse du
fournisseur, sans seconde requête ni nouvelle dépendance.

### Nature et traçabilité des résultats

En mode enrichi, `results` garde la projection titre/URL/extrait ; un objet
`evidence` ajoute les informations suivantes :

- Identifiant local de récupération et identifiants de source délimités par
  cette récupération. Un identifiant transmis par le fournisseur ne remplace
  jamais ces identifiants internes.
- Heure de réception locale (`retrieved_at`), fournisseur, filtres demandés et
  compteur de résultats. Cette heure n'est ni une date de publication ni une
  preuve de lecture de la page source.
- État explicite `content_kind: "search_excerpt"`,
  `verification_status: "unverified"`, `page_read_by_karta: false`.
- Identifiant de requête fournisseur et crédits déclarés lorsqu'ils ont une
  forme valide ; `null` lorsque la donnée est absente ou inexploitable. Les
  crédits déclarés ne sont pas une facture vérifiée ni un débit du quota ONE.
- Pour chaque source, rang du fournisseur et extraits distincts conservés,
  avec la date estimée fournie lorsqu'elle est interprétable. Une date absente,
  impossible ou ambiguë reste inconnue. Une date limitée au jour conserve cette
  précision et n'acquiert pas artificiellement une heure.

Les occurrences d'une même URL normalisée sont regroupées dans le format
enrichi. L'URL d'origine de la première occurrence reste affichable et les
extraits différents restent associés à cette même source. Les paramètres,
leur ordre, les signatures, fragments, schémas et la casse du chemin ne sont
pas supprimés arbitrairement. Le regroupement ne prétend pas reconnaître les
articles recopiés sur plusieurs sites, ni établir l'indépendance des sources.

Les scores de pertinence, les réponses générées et les champs inconnus du
fournisseur ne sont pas transmis comme autorité. Une citation doit ensuite
être rattachée à l'affirmation qu'elle soutient par l'intégration IAO et
SATYA/PRAMANA. Les extraits sont des données externes non fiables : leur contenu
ne donne aucune permission d'exécuter une action.

### Confidentialité et canal de réponse

`tracePolicy: "metadata_only"` réutilise le mécanisme central de KARTA. La
requête, les résultats, la décision et les erreurs privées sont exclus des
traces et notifications automatiques de diagnostic du cycle protégé, y compris
pour les agents statiques. Le retour d'un ancien run est également minimisé.

La protection n'efface pas les journaux historiques déjà stockés. Elle ne
supprime pas les paramètres métier nécessaires aux approbations, la requête
envoyée à Tavily ni les envois explicitement demandés via d'autres outils.
Le `trigger_source` doit rester un identifiant technique contrôlé par le serveur.
Le contenu nécessaire à une réponse utilisateur doit passer par un canal métier
autorisé ; il ne faut pas réactiver les logs privés pour l'afficher.

### Raccordement à Mon quotidien

Le parcours cible conserve ONE/AETHER pour l'interface, IAO pour la compréhension
et la synthèse, SMARANA/AKASHA pour les préférences autorisées, KARTA/KRIYA pour
les actions, ONE ID/VAJRA pour les droits et PURA Capsule pour le partage choisi.
Les paramètres de recherche n'importent pas automatiquement un profil privé.
La langue et les critères peuvent être modifiés ou désactivés par la personne.

La boucle inspectée appelle le modèle avant les outils puis produit une trace ;
elle ne réinjecte pas leurs résultats dans un nouvel appel de synthèse. Ce lot
ne constitue donc pas encore une réponse sourcée dans ONE. Les étapes de
réception restantes sont :

1. Identifier le checkout ONE actif et son adaptateur serveur ; dériver le compte
   et l'espace depuis la session, jamais depuis un `userId` libre du navigateur.
2. Transmettre le résultat métier à IAO et SATYA/PRAMANA sans stockage public ni
   fuite intercompte. Relier chaque affirmation importante aux extraits ou aux
   pages effectivement lues ; rendre visibles contradictions et données inconnues.
3. Raccorder le coût aux réservations et quotas communs, puis l'annulation au
   transport. Le délai interne ne prouve pas une annulation immédiate depuis ONE.
4. Tester recherche, sources, comparaison, arrêt, rechargement, changement de
   compte et reprise sur mobile et clavier. Une permission ou un prix périmé
   doit être revérifié avant toute action.
5. Qualifier une première action de faible impact et une Capsule sans transfert
   de secrets ou de permissions, puis mesurer temps, coût et taux de résultat
   correct sur des usages réels.

### Vérification et références

Le reçu [websearch-personalization-20261110.json](test/evidence/websearch-personalization-20261110.json)
conserve les commandes, résultats, empreintes et limites du lot. Les tests
utilisent le vrai outil, le registre et la boucle ; les fournisseurs, modèles,
stockages et notifications sont simulés. Aucune clé Tavily réelle n'était
disponible dans l'environnement de ce lot. Qualité, latence, prix effectif et
fonctionnement en production restent **NON TESTÉS**.

Sources officielles consultées le 10 novembre 2026 :

- [Contrat Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search).
- [Pratiques de recherche Tavily](https://docs.tavily.com/documentation/best-practices/best-practices-search).
- [Sécurité des agents OWASP](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html).
- [Critères d'accessibilité WCAG 2.2](https://www.w3.org/TR/WCAG22/).
