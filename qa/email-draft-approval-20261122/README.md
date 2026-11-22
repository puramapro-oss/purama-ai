# Approbation Gmail liée à l’aperçu — candidat local du 22 novembre 2026

**Statut : PARTIEL.** Le code et les contre-épreuves sont livrés pour composition.
La qualification SQL et navigateur doit encore être exécutée en CI. Aucun envoi
Gmail, appel téléphonique, push ou déploiement réel n’a été effectué par ce lot.

## Contrat livré

Le client demande un aperçu serveur privé contenant le compte expéditeur,
le destinataire, l’objet, le texte complet et les identifiants Gmail du message.
L’interface affiche cette version intégrale. L’approbation nomme son identifiant,
lié au compte et au log, et expire après dix minutes. Le booléen public
`user_approved` ne suffit plus à autoriser une nouvelle émission.

Les RPC `email_agent_draft_preview(user_id, log_id)` et
`email_agent_draft_approve(user_id, log_id, approval_id, feedback)` sont réservés
au service. La réservation utilise quatre paramètres :
`email_agent_send_reserve(user_id, log_id, claim_token, approval_id)`.
Les noms réels des paramètres SQL sont préfixés `p_`. Les contrats `begin` et
`finish` gardent leurs signatures. Le payload historique du dispatch ne change
pas ; son `approval_id` est une colonne séparée.

L’approbation, la réservation et le départ comparent l’aperçu au log et à la
version de connexion. La comparaison est renouvelée dans `begin`, y compris si
Gmail a été reconnecté A → B → A après la réservation. Les anciennes fonctions
internes restent privées, et l’ancien RPC à trois arguments échoue fermé.

Une réponse tardive, une fermeture ou un changement de compte ne permet pas à
l’interface de déclencher l’étape suivante avec une ancienne vue. Les doubles
clics sont bloqués immédiatement, puis par la réservation durable existante.

Le finaliseur conserve le reçu et le compteur au plus une fois. Il ne remplace
ni un refus plus récent ni son `feedback_at`. Un log modifié pendant le POST
reste un brouillon ; le reçu concerne le contenu approuvé qui est réellement
parti. Les succès d’envoi exigent le booléen `matches_current_preview`, que
l’interface distingue de la simple existence d’un reçu. Le client sait aussi
appeler l’endpoint de réconciliation du lot parent, sans nouvelle tentative.

La migration historique `20261122004000` reste inchangée. Sa somme SHA-256 est
consignée dans `verification.json`. La nouvelle migration `20261122020000`
précède celle de réconciliation `20261122021000` lors de la composition.

## Preuves observées

| Contrôle | Résultat local |
| --- | --- |
| Tests Node du vrai client et de la configuration | **PASS — 23/23**, code 0 |
| Lint des 8 fichiers TS/TSX ciblés | **PASS — 0 erreur, 0 avertissement**, code 0 |
| Typage UI et imports réels, handler strict | **PASS**, code 0 chacun |
| Typage du test sender avec les options strictes KARTA | **PASS**, code 0 |
| Typage final complet du site | **BLOQUÉ — SIGKILL**, code -9, aucun diagnostic |
| SQL / handler PGlite | **NON TESTÉ** : 111 cas collectés, 0 assertion exécutée, code 1 |
| Essai SQL direct indépendant | **BLOQUÉ — SIGKILL**, code -9, aucune assertion observée |
| Navigateur système | **BLOQUÉ** : 9 scénarios, démarrage refusé par `socket()`, 0 assertion produit |
| Index exact et `detect_changes` | **BLOQUÉ** : reconstruction incomplète, clone non enregistré |
| Fournisseur réel / production | **NON TESTÉ**, aucun effet réel |

Le rapport JSON partiel de Vitest contient `success: true` malgré le code 1 et
l’absence d’assertions exécutées. Ce champ est explicitement ignoré : il ne
constitue pas un PASS. Quatre contre-épreuves ont été ajoutées après cette
tentative : édition pendant POST, retrait pendant POST, reconnexion A → B → A
avant préparation de l’accès et mutation après approbation avant réservation.
La suite finale contient donc **115 scénarios attendus**, à exécuter en CI.

Le typecheck complet du site avait réussi avant l’ajout final au contrat du reçu.
Ce passage antérieur ne qualifie pas la version finale. Les deux parties modifiées
du site sont néanmoins incluses dans le typage UI ciblé qui a terminé avec code 0.

La première tentative navigateur ne trouvait pas le binaire Playwright attendu.
La variante utilise le Chromium système existant, sans installation ; le système
interdit ensuite la socket de démarrage. Aucun contournement n’a été tenté.

## Portée et vérification restante

L’index historique GitNexus du dépôt source est à `812830f9`, dix commits derrière
la base au moment des analyses. Les contrôles sur les nouveaux symboles SQL sont
incomplets et déclarés UNKNOWN. L’identité des métadonnées n’a pas été modifiée
pour faire accepter une copie étrangère. Le `detect_changes` réellement exécuté
sur le clone exact refuse son absence d’enregistrement ; son reçu est conservé.

La contre-revue en lecture seule a trouvé puis vérifié statiquement le correctif
A → B → A. Elle ne remplace pas l’exécution SQL. Le parent doit maintenant composer
ce lot avec la réconciliation, exécuter la chaîne complète de migrations et les
assertions sur PostgreSQL natif, puis les scénarios navigateur. Il conserve la
responsabilité des workflows, de la publication du candidat et de toute décision
de déploiement. Les autorisations de mise en service, le drainage des anciennes
routes et les accès réels restent hors de ce lot local.

`verification.json` donne les empreintes des sources, les commandes et les reçus
de contrôle. Ces résultats bornent ce candidat ; ils ne certifient pas la
disponibilité générale 24/7 de tous les producteurs PURAMA.
