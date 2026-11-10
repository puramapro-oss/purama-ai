# Réconciliation IAO — qualification du 10 novembre 2026

**PASS sur le périmètre local vérifié ; PARTIEL pour la préparation d'une mise en vente.** Cette réconciliation conserve les fonctionnalités récentes de la PR33 et réunit les corrections d'autorisation, de commerce, de contrats et d'interface qui avaient été développées dans des branches parallèles. Elle inclut aussi les deltas propres des PR34 et PR35 découverts pendant la revue finale.

Le parent unique est `58a85a9f7ae0c20abc37158ea0901243e0bf2acd`. Les résultats détaillés, commandes, empreintes des 106 chemins de code, tests et contrôles, ainsi que la définition des compteurs sont dans [results.json](results.json). Avec cette paire de documents, le diff de revue comporte **108 chemins**. Les journaux bruts complets restent dans le dossier de preuves externe ; ils ne sont pas recopiés massivement dans le dépôt.

## Continuité et choix d'intégration

| Source | Décision vérifiée |
|---|---|
| PR29, `8f38de97…` | Composition ciblée des garanties d'autorisation, de commerce, de fondateur, d'OTS et d'isolation. La PR29 et la PR33 sont des branches parallèles : les défauts étaient encore présents dans la PR33, sans avoir nécessairement été introduits par elle. |
| PR31 et PR32 | Les fonctionnalités déjà présentes dans la PR33 ne sont pas dupliquées. Les assertions de contenu binaire et d'instantané de la PR32 restent conservées avec le cœur OTS borné. |
| PR33, `58a85a9…` | Conservation du contrôle `public.has_role`, du HMAC sur les octets reçus, des lectures HTTP strictes, des comparaisons d'état et de soumission, et des 63 fichiers de preuve hérités, vérifiés identiques. |
| PR34, `5fe914c…` | Import exact de ses six blobs propres, contre son parent `8631305…`. Cette branche est une sœur de la tête retenue : son diff global contre `58a85a9…` n'a pas été appliqué. |
| PR35, `959aa41…` | Import exact de ses deux blobs propres contre `58a85a9…`, pour le modèle serveur d'agent-chat et ses six cas de contrôle. |

Les huit blobs des PR34/35 ne chevauchent aucun des 98 chemins du candidat précédent. Parmi ces 98 chemins, le seul changement ultérieur est l'ajout d'agent-chat au même contrôle Deno de la CI. Les deux revues indépendantes des deltas propres PR34/35 n'ont signalé aucun défaut bloquant concret. Elles constituent des lectures de code, distinctes des exécutions de tests.

Les budgets, les briefs, les continuations avec approbation et `karta/src/chef/process.ts` de la PR33 sont préservés. Les migrations KARTA 001–025, les fonctions de crédits supplémentaires et de réservation de prospection restent intactes. Les deux fichiers de verrouillage n'ont pas changé. Le déclenchement automatique Vercel de la branche de travail reste désactivé ; les déclenchements CI sur branche principale, PR et action manuelle sont conservés.

## Défauts corrigés et comportement résultant

| Domaine | Résultat |
|---|---|
| Autorité KARTA | Les droits sont relus après la construction asynchrone du contexte et immédiatement avant l'appel au modèle. Une révocation annule l'exécution sans modèle ni outil. Les tentatives de clôture sont bornées ; une notification en erreur ne transforme pas un résultat durable. |
| Scheduler PR34 | Le scan transmet son `AbortSignal`, partage le travail en cours et impose un délai de 30 secondes, même si le client ignore l'annulation. Un arrêt détruit les tâches ; les générations et l'identité des tâches empêchent les retours tardifs et anciens callbacks de relancer un agent après arrêt ou redémarrage. |
| Modèle PR35 | Agent-chat utilise `ANTHROPIC_MODEL_MAIN` côté serveur, avec le repli existant aligné sur chat. Le client ne choisit pas le modèle à la place du serveur. |
| Commerce | Les plans refusent les valeurs inconnues et les propriétés héritées. Un retour d'URL ne prouve aucun paiement. Les clients ou abonnements ambigus sont refusés ; une page Stripe `has_more` active ou en essai retourne 409 avant d'accorder un droit. |
| Versements et privilèges | Aucun faux paiement ou marquage de commission payée n'est produit côté navigateur. Le mécanisme de versement indisponible retourne 503. Les écritures financières clientes sont interdites, avec conservation des crédits supplémentaires et de la prospection. |
| Fondateur | Les agrégations sont bornées, les erreurs restent visibles et les résultats sont isolés par compte. Le point d'entrée réel est qualifié avec `Deno.serve` et le SDK Supabase exact. |
| OTS et webhook | Le client humain conserve son autorisation et la RLS ; seul le secret de service exact permet le chemin de service. Trois contrôles d'identité et de rôle encadrent les opérations. Les écritures comparent l'instantané de contrat, l'état et la soumission. Les signataires absents, vides ou non confirmés ne produisent pas une complétion fictive. |
| PDF et preuve | L'origine HTTPS DocuSeal configurée doit correspondre exactement. Les origines étrangères et imitatrices sont rejetées avant le chargement du PDF. Les tailles, délais, octets PDF et preuves sont vérifiés ; deux calendriers utilisables sont exigés. Les vues binaires, instantanés et anciennes preuves restent compatibles. |
| Isolation et voix | Les réponses et opérations d'un ancien compte ou d'une ancienne conversation ne remplacent plus l'état courant. Les garanties récentes d'annulation et de consentement vocal sont conservées. |
| Bien-être | Après reproduction d'un vrai défaut lors de la réouverture du dialogue, Escape ferme localement la pause. Le composant Dialog partagé et les assertions du scénario original restent inchangés. |

### Lecture DocuSeal : borne réelle de dix secondes

Le helper GET impose un délai total de **10 s**, un plafond de **1 MiB**, un décodage UTF-8 strict et une limite aux fragments vides. Il refuse les redirections, n'ajoute aucun retry et n'attend pas indéfiniment la fermeture d'un flux. Le transport des écritures POST/PUT/DELETE reste inchangé.

La même fixture finale donne **7 PASS / 14 FAIL avant**, puis **21 PASS après**. Un contrôle supplémentaire avec le vrai runtime Deno 2.9.6 et un serveur HTTP local donne trois résultats vérifiés : réponse normale en 16,6 ms ; serveur silencieux avant les en-têtes, 504 en 10 001,4 ms ; corps bloqué, 504 en 10 001,5 ms. Le serveur a été fermé. Un premier résultat réel 502 à l'expiration du corps est conservé dans les preuves ; sa classification a été corrigée et les trois contrôles rejoués sur l'empreinte finale.

## Exécutions et absence de double comptage

| Groupe | Résultat final |
|---|---:|
| KARTA complet, après PR34/35 | **1 507 / 1 507**, 88 fichiers |
| Plans commerce | 17 / 17 |
| Handlers commerce | 42 / 42 |
| Fondateur client et serveur | 47 / 47 |
| Handlers OTS Deno | 42 / 42 |
| Cryptographie et client OTS Node | 24 / 24 |
| Pont npm avec le vrai Deno | 3 / 3 |
| Fixture d'autorisation OTS | 24 / 24 |
| Sécurité HTTP, webhook, OTS et GET DocuSeal | 179 / 179 |
| Compatibilité des dépendances | 5 / 5 |

Les **24 nouveaux cas PR34/35** donnent 6 PASS / 18 FAIL avant intégration, avec un rejet asynchrone non traité, puis 24 PASS après. Le filtre ciblé écartait seulement 49 cas préexistants du fichier partagé ; ceux-ci ont ensuite été exécutés dans les 1 507 cas complets. Les quatre fichiers de tests donneurs ont gardé leurs empreintes exactes.

Les **124 cas navigateur distincts** passent dans Chrome 157.0.8103.39 : isolation de compte 25, fondateur 16, AdminContracts OTS 7, commerce 29, consentement vocal 17, état d'interface 9 et bien-être 21. Les bundles ont été compilés sous Linux puis exécutés dans Chrome macOS avec des transports synthétiques et le réseau extérieur fermé. Aucun build ni installation n'a été lancé sur le Mac. Les passages finaux n'ont ni retry, ni skip, ni cas instable déclaré. Les 173 fichiers bruts transférés ont été contrôlés par empreinte.

Les échecs initiaux sont conservés : isolation de compte 14/25 avant contre 25/25 après ; bien-être 20/21 avant la correction Escape, puis 21/21 ; premier timeout de navigation commerce, suivi d'un passage complet 29/29 sans changement de bundle, d'assertions ou de délai. Les options GPU Linux provoquaient également un crash de Chrome macOS : les trois configurations dédiées n'appliquent désormais ces quatre options que sous Linux.

**Douze contrôles PostgreSQL 18.6 natifs** vérifient séparément les migrations composées, les privilèges et la concurrence : huit paiements identiques ne créditent qu'une fois, quatre réservations n'ont qu'un propriétaire, quatre admissions d'envoi n'autorisent qu'une tentative, et les reprises ambiguës restent refusées. Les onze fichiers SQL utilisés sont empreintés. Le cluster synthétique sur l'interface locale a été arrêté sans PID résiduel. Les trois contrôles HTTP Deno ci-dessus restent séparés de ces contrôles PostgreSQL.

Les anciens passages, les replays ciblés, les 15 cas binaires et les 21 cas GET déjà inclus dans les 179, ainsi que les preuves héritées, ne sont jamais ajoutés une seconde fois. Le compteur détaillé de `results.json` désigne des identifiants fichier+cas, pas un nombre de risques indépendants.

## Assertions et conclusions explicitement réconciliées

Les 37 cas OTS originels sont conservés : 36 appels de test identiques par AST, et un cas renforcé pour refuser par 409 des signataires absents ou vides, tout en conservant l'absence de changement d'état et d'appel interne. Cinq nouveaux cas portent le groupe à 42. Les 11 expressions de test donnant les 15 cas binaires restent identiques.

Cinq attentes de statut conservent le contrat plus strict des handlers composés : lecture DB 500→503, soumission absente 400→409, PDF absent 404→502, exception PDF 500→502 et exception de calendrier 500→502. Les anciens succès de PDF sur une origine étrangère deviennent des refus 502 avec zéro chargement PDF, stamp, écriture et événement. Le succès sur l'origine configurée reste testé.

La revue de la fixture d'autorisation a détecté puis restauré son garde historique : une écriture simulée n'est confirmée que si tous les filtres `.eq` et `.is` correspondent. Six assertions de filtres d'instantané ont été ajoutées au cas administrateur existant ; les 24 cas ont repassé. Les adaptations de capture `Deno.serve`, de SDK et de transport n'enlèvent aucune assertion d'autorisation.

**Correction d'une conclusion antérieure :** la colonne `actor_type` est de type `TEXT`, sans contrainte CHECK dans le schéma réel. L'affirmation précédente selon laquelle `service` serait incompatible était erronée. La valeur `service` de la tête retenue est conservée pour le stamp interne, et `user` pour l'administrateur. La matrice finale externe répertorie chaque adaptation et remplace explicitement cette ancienne conclusion.

## Collecte Playwright et contrôles statiques

La collecte générale passe de **339 occurrences dans 13 fichiers à 198 dans 9 fichiers**, sans perte des 198 occurrences retenues. La différence de 141 correspond exactement à **47 définitions × 3 projets** : voix 17, état 9, bien-être 21. Ces quatre fichiers de scénarios sont identiques à la tête retenue et toutes leurs définitions se retrouvent dans leurs configurations dédiées, dont les commandes CI sont conservées. La différence numérique ne provient pas de tests Node supprimés.

Ces 47 définitions ont été exécutées dans leurs bancs Chrome dédiés. Les **94 variantes générales supplémentaires tablette/mobile ne sont pas qualifiées** ; les **198 autres cas n'ont été que collectés**, pas exécutés dans ce lot. Les tests Node et Deno sont exclus séparément du mauvais runner et conservent leurs propres scripts exécutés.

Les types du site et du fondateur, les types/build KARTA, le build de production Vite et les contrats DB passent. Le lint global termine avec **0 erreur et 32 avertissements**, dont trois dans la sortie générée KARTA. Actionlint 1.7.12 et `git diff --check` passent. Les **sept vrais points d'entrée Deno** sont qualifiés et présents dans le même run CI : OTS stamp, OTS verify, webhook, abonnement, versement, fondateur et agent-chat.

La résolution locale de Stripe 18.5.0 et du type Supabase 2.91.0 du reader fondateur utilise leurs vrais paquets officiels et des mappings explicites ; elle ne modifie aucun verrouillage produit. La résolution distante d'origine via `deno.land` ou `esm.sh` reste non qualifiée dans cet environnement. Les échecs initiaux sont conservés.

GitNexus 1.6.12 sert aux impacts et à la revue finale des différences. Son FTS indisponible, la limite de processus et certains identifiants de symboles absents rendent le graphe **PARTIEL**. Les agrégats HIGH/CRITICAL ont été signalés avant les éditions ; ils ne sont pas présentés comme une liste certaine d'appelants. Les différences de sources et leurs empreintes complètent cette analyse.

## Limites de livraison

La CI hébergée n'a pas été exécutée sur ce candidat. Aucun déploiement, paiement réel, versement fournisseur, livraison réelle de webhook ou disponibilité actuelle des calendriers Bitcoin n'est prouvé par ces tests locaux. Le refus 503 d'un versement indisponible évite un faux succès ; il ne constitue pas un moyen de paiement opérationnel.

Un échec d'audit après une écriture de contrat ou de preuve retourne une erreur, mais ne démontre pas un rollback transactionnel. Les navigateurs autres que Chrome, la charge réelle, les variantes mobiles mentionnées et l'infrastructure de production restent à qualifier. La conservation durable et la publication du dossier brut sont des étapes séparées ; cette paire de fichiers ne prétend pas qu'elles sont déjà accomplies.
