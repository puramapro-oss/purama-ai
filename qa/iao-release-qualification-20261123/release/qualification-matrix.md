# IAO — qualification du banc local et critères de sortie

Date : 23 novembre 2026. Base : `970ff2255e2037625a62745ecac3e6cd9c04b702`.

## Conclusion du périmètre

**PASS pour la correction du banc et les contrôles disponibles ; PARTIEL pour la qualification avant déploiement.** Le défaut reproduit concerne le script existant `karta/scripts/qualify-lmstudio.ts` : des paramètres cloud ambiants invalides interrompaient sa construction avant tout appel au serveur local, alors que ce processus annonçait les ignorer. Les deux cas de régression sont rouges avant correction. Après isolation du cache cloud et fourniture d'un catalogue local explicite, les neuf cas du nouveau banc passent. Les 79 contrôles existants de readiness et de transport local ainsi que le typecheck passent également.

Ce lot ne change ni le routage de production, ni les modèles, ni les comptes fournisseurs. Il ne relance pas l'audit des dépendances déjà réalisé. Les observations Mac et les inférences réellement accessibles appartiennent au lot racine et doivent être rattachées à leurs propres reçus.

## Ce qui est réellement exécuté

Le nouveau test lance le véritable CLI dans un processus Node enfant, charge le véritable SDK Anthropic et échange sur une vraie socket HTTP loopback. Le serveur fournit un inventaire et des réponses **synthétiques**. Il n'y a donc aucune inférence de modèle dans cette suite. Les réponses contrôlées permettent de vérifier les verdicts du banc, son isolement des identifiants cloud et son refus des préconditions absentes.

| Axe | Preuve disponible dans ce lot | Statut du contrôle | Preuve nécessaire avant une affirmation live |
| --- | --- | --- | --- |
| Sélection volontaire du banc | Le CLI refuse l'absence d'opt-in et de modèle exact avant réseau | PASS | Exécution explicitement choisie sur l'hôte et le modèle visés |
| Indépendance des paramètres cloud | Deux paramètres ambiants invalides reproduisent l'échec avant réseau, puis passent après correction du seul CLI | PASS après correction | Le catalogue de ce petit banc ne qualifie aucun niveau de réflexion supplémentaire |
| Modèle chargé et capacité outils | Le CLI refuse un modèle absent de l'inventaire et refuse le cas outils sans capacité déclarée | PASS sur fournisseur synthétique | Inventaire actuel du serveur local, poids présents et modèle chargé ; une déclaration du serveur ne prouve pas à elle seule la qualité des outils |
| Résultat du modèle | Texte incorrect et titre d'outil incorrect entraînent un exit 1 ; la réponse brute reste exclue du rapport | PASS sur réponses contrôlées | Réponses issues du modèle réellement exécuté, au-delà des deux petites tâches du smoke test |
| Transport local | Les contrôles existants de transport, inclus dans les 79 tests du lot, couvrent sélection, capacités, délais, annulation, redirections et isolement | PASS sur transport instrumenté | Route native réellement disponible avec le même client et la même configuration |
| Disponibilité technique | Les tests séparent `/live` et `/health`, bloquent le travail sans dépendances, conservent l'arrêt d'urgence et valident le schéma d'usage | PASS sur dépendances simulées | Redis et Supabase cibles effectivement accessibles, protocole et schéma conformes, sondes bornées passantes |
| Preuve d'usage | Les réponses synthétiques produisent un reçu ; le schéma `model_usage` absent refuse la readiness | PASS du contrat | Reçu d'une inférence réelle, puis écriture et relecture du résultat dans le stockage cible |
| Modes, réflexions et tailles de projets | Couverture confiée aux lots profils et interface, pas au smoke LM Studio | NON TESTÉ par ce lot | Référencer les reçus de ces lots ; ne pas extrapoler deux prompts à tous les modes |
| Facturation et coût | Aucun appel fournisseur payant lancé dans ce lot | NON TESTÉ pour les comptes réels | Compte actuel autorisé, réponse d'inférence effective et données de coût réellement disponibles ; un catalogue HTTP 200 ne suffit pas |
| Charge, durée et coût par utilisateur | Les limites du transport sont testées avec réponses contrôlées | NON TESTÉ sous charge réelle | Scénarios représentatifs, concurrence cible, latences et consommation mesurées, durée et échecs inclus |
| Hors connexion complet | Le transport composant est local | NON TESTÉ de bout en bout | Application, données, modèles et outils nécessaires présents ; scénario réel sans réseau avec résultat persistant |
| Déploiement | Aucun déploiement ni modification de service effectué par ce lot | NON TESTÉ | Version figée, gates d'intégration verts, environnement cible vérifié, activation autorisée et vérification après déploiement |

Ce script attend l'inventaire LM Studio `/api/v1/models` et son protocole Messages `/v1/messages`. La disponibilité d'Ollama ou de son endpoint compatible OpenAI `/v1/models` ne prouve pas la compatibilité de ce script. Aucun serveur, poids ou service n'a été installé, activé ou remplacé dans ce lot.

## Régression nouvelle : matrice finie de neuf cas

| Cas | Résultat attendu | Réseau attendu |
| --- | --- | --- |
| Configuration locale correcte | Deux `PASS`, exit 0, reçus d'usage présents | Deux inventaires et deux inférences synthétiques locales |
| Catalogue cloud ambiant invalide | Deux `PASS`, exit 0 | Même route locale ; pas d'accès cloud |
| Cache cloud ambiant invalide | Deux `PASS`, exit 0 | Même route locale ; pas d'accès cloud |
| Opt-in absent | `BLOQUÉ`, exit 1 | Aucun appel |
| Modèle exact absent | `BLOQUÉ`, exit 1 | Aucun appel |
| Modèle non chargé | Deux `NON VALIDE`, exit 1 | Deux inventaires, aucun prompt soumis |
| Outils non déclarés | Texte `PASS`, outil `NON VALIDE`, exit 1 | Un seul prompt soumis |
| Texte sémantiquement faux | Texte `NON VALIDE`, outil `PASS`, exit 1 | Reçus retenus ; corps fournisseur exclu du rapport |
| Titre d'outil sémantiquement faux | Texte `PASS`, outil `NON VALIDE`, exit 1 | Reçus retenus ; corps fournisseur exclu du rapport |

Les identifiants des fixtures sont inventés. L'environnement des enfants est une liste explicite de variables : aucun secret du poste ni fichier `.env` du projet n'est hérité. La fonction d'outil du smoke test lève une erreur si quelqu'un essaie de l'exécuter ; le banc vérifie uniquement la décision retournée.

## Reçus et limites de preuve

Chaque commande a un reçu JSON avec arguments, répertoire de travail, code de sortie et durée, ainsi que les empreintes utiles. Les logs se trouvent dans ce dossier.

- `qualification-env-red.json` : reproduction initiale avec CLI inchangé et serveur synthétique ; environnement sain exit 0 et quatre requêtes, chacune des deux configurations invalides exit 1 et zéro requête.
- `cli-red-command.json` et `cli-red.log` : neuf tests, deux échecs attendus avant correction, sept succès.
- `cli-green-command.json` et `cli-green.log` : les mêmes neuf cas deviennent verts, exit 0 ; fournisseur toujours synthétique.
- `typecheck-before-command.json` : vérification TypeScript partagée après typage des matrices du nouveau test, exit 0.
- `typecheck-after-command.json` : vérification TypeScript partagée après correction du CLI, exit 0.
- `existing-readiness-command.json` et `existing-readiness.log` : 79 tests existants, quatre fichiers, exit 0.
- `gitnexus-impact.json` : cible exacte `main`, risque `LOW`, un appelant direct (le fichier du script), aucun processus/module affecté. Les liens aval vers des fixtures ne sont pas une preuve d'appels effectifs ; la lecture du code et l'exécution du CLI complètent le graphe.

La correction force le cache prompt cloud à `off` dans le processus de qualification et passe un catalogue réduit au modèle explicitement demandé, avec `reasoning: "none"` et le plafond préexistant de 1024 tokens. Elle ne sélectionne aucun autre modèle, n'ajoute aucun repli, n'exécute aucun outil et ne modifie pas la configuration du runtime de production.

Revue indépendante en lecture seule par `qual_profiles` : aucun blocage relevé sur le plan, le nouveau banc et la frontière de preuve ; aucun test n'a été réexécuté par le relecteur. Aucun changement de `usage.ts` n'a été effectué : le traitement des identifiants contenant `@` relève d'une politique de minimisation existante, qui n'est pas élargie par ce lot.

Le reçu de chaque étape conserve l'empreinte de la version qu'elle a réellement vérifiée. Une réussite ultérieure ne doit pas effacer l'échec initial. Les statuts de comptes ou d'hôtes datés du 12 ou du 13 novembre sont des faits historiques, pas une observation actuelle de disponibilité.
