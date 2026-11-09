# Jev dans KARTA — connecteur facultatif, 9 novembre 2026

## État réel

Le schéma et le transport Jev sont implémentés, ainsi qu'une factory d'outil KARTA
`createJevJudgmentTool`, exportée par le registre existant. **L'outil est désactivé
par défaut et n'est ajouté automatiquement à aucun agent.** Aucun compte fournisseur,
crédit, appel réel, déploiement ou jeu d'évaluation sémantique n'a été utilisé ici.

Les tests simulés valident les contrats logiciels. Ils ne qualifient pas le modèle
sur les tâches PURAMA. L'intégrateur doit raccorder les callbacks décrits ci-dessous
aux services canoniques d'identité, de permissions, de qualification et de quota.
Ces callbacks ne sont pas implémentés par ce connecteur.

Validation locale exécutée : **83 tests Jev** (30 schéma, 19 transport, 34 outil),
**588 tests KARTA au total dans 49 fichiers**, compilation KARTA et TypeScript réussis.
Le fournisseur est simulé. La [preuve et les empreintes](../../test/evidence/jev-20261109.json)
documentent le périmètre ; aucune précision ou latence de modèle n'est mesurée.

## Rôle et périmètre

Jev est appelé pour des jugements structurés : classement, pertinence, comparaison de
candidats ou appréciation d'un critère borné. Ses réponses restent des **données**.
Elles ne déclenchent aucune action et n'accordent aucune permission. KARTA/KRIYA gardent
le contrôle des missions ; VAJRA garde les droits ; SATYA/PRAMANA gardent les preuves.

Cette version accepte du texte, 1 à 16 questions `noul`, `choice` ou `score`, avec
instructions textuelles. `state` est une chaîne. Images, Box, grand contexte et sortie
libre sont hors du contrat de cette version. Le modèle demandé et accepté est
`jev-1.14.0` ; un alias ou un autre modèle dans la réponse est refusé.

Les limites propres à IAO sont de 32 768 octets UTF-8 pour la requête sérialisée avec
le modèle et 524 288 octets pour la réponse. Ce sont des limites de transport,
**pas un comptage de tokens ni une réservation de coût**. La validation vérifie aussi
les champs, les options, les légendes, les probabilités et l'usage. Elle ne démontre
pas l'exactitude du jugement. La tolérance numérique de distribution/moyenne est 1e-6 ;
elle reste à confirmer sur de vraies réponses de cette version.

## Raccordement au serveur

La factory reçoit `enabled: true`, une clé API serveur, `authorizeAndReserve` et
`settle`. Si un élément manque, aucun appel n'est lancé. Aucune variable d'environnement
n'est lue implicitement ; aucune clé n'est acquise par l'agent. Le mode simulation
et l'absence d'identifiant d'opération empêchent aussi l'envoi.

`authorizeAndReserve` reçoit l'identité authentifiée KARTA, l'identifiant d'opération,
le modèle, la requête normalisée immuable et son SHA-256. Le service hôte doit :

1. Vérifier l'organisation, la finalité, les données autorisées et un mandat actuel.
2. Accepter seulement des questions/domaines qualifiés pour cette version. Une chaîne
   `qualificationRef` ne constitue pas à elle seule une preuve de qualification.
3. Réserver atomiquement le budget dans le mécanisme canonique, avec une borne de coût
   établie par le serveur. Refuser si cette borne n'est pas disponible sous budget strict.
4. Dédupliquer la même opération et traiter les précédentes tentatives ambiguës.
5. Retourner un permis lié à l'utilisateur, à l'opération, au modèle et au SHA-256 exact,
   avec référence de réservation, échéance, signal de révocation et seuils qualifiés.
6. Annuler ou faire expirer toute réservation acquise après l'annulation de l'admission.

Le connecteur contrôle les liaisons et l'échéance reçues. Il ne remplace pas ces services
par un second routeur ou un registre de budgets. Le `ToolExecutionContext` existant
ne transporte ni budget ni signal d'annulation ; le signal du permis doit donc être
réellement raccordé par le serveur aux révocations et à l'arrêt de la mission.

Les seuils sont fournis par question. Choice/Score utilisent un seuil de `confidence` ;
Noul utilise deux bornes séparées, avec abstention entre elles. Un résultat admis est
appelé `candidate`, jamais « vrai » ou « autorisé ». Pour une classification avec cas
hors périmètre, l'hôte doit qualifier une stratégie d'abstention appropriée, par exemple
un Noul de pertinence complémentaire ; aucune détection universelle n'est supposée.

## Temps, facturation et erreurs

L'admission et l'appel partagent une échéance de 10 secondes ; la réconciliation a une
échéance séparée de 2 secondes. Le connecteur interrompt son attente et transmet
l'annulation. Un callback injecté qui ignore le signal peut continuer son propre travail :
l'hôte doit respecter l'échéance et les règles de réservation tardive.

Une seule tentative réseau est effectuée, vers l'URL officielle fixe, sans redirection
ni reprise automatique. La réponse est lue progressivement sous la limite d'octets.
Les erreurs ne renvoient ni corps fournisseur, ni clé, ni message privé du callback.

`settle` reçoit une seule fois, pour un permis validé, le fait qu'une tentative a pu
partir, son issue et l'usage connu. Une erreur, une réponse perdue ou invalide ne vaut
pas coût zéro. Le service hôte doit conserver puis rapprocher les montants incertains.
Un échec ou timeout de réconciliation produit `accounting_unconfirmed`, sans restituer
un jugement comme succès. La validité du permis est revérifiée après cette attente.

Le résultat est enveloppé dans `decisions` : un nom de question tel que `error` ne peut
pas être interprété comme le statut global de l'outil. Les résultats indisponibles ont
`ok: false` et sont reconnus comme échecs par le contrôleur KARTA existant.

## Avant activation

- Vérifier le compte, les crédits, la version disponible et les conditions contractuelles.
  L'accord TypeSafe prévoit des applications clientes et restreint notamment la revente
  autonome, la distillation et certains usages concurrents ; la compatibilité du cas IAO
  doit être clarifiée avant exploitation.
- Vérifier le traitement des données applicable au compte. La documentation actuelle
  indique un traitement aux États-Unis et un ZDR sur demande ; aucune activation ZDR
  n'a été constatée pour ce projet.
- Raccorder et tester les services d'admission/réconciliation, la révocation et les
  quotas concurrents. Les fixtures de tests ne sont pas ces services.
- Configurer le masquage/la conservation des traces : la boucle KARTA existante peut
  journaliser les paramètres d'outils. Ne pas introduire de données privées avant
  d'avoir validé cette politique et les accès aux journaux.
- Qualifier les résultats français, cas ambigus, options permutées, contenus adversariaux,
  calibration, taux d'abstention, coût complet et latence depuis l'infrastructure cible.
- Ajouter explicitement l'outil à la liste autorisée de l'agent choisi seulement après
  ces contrôles. Aucun agent existant ni `CUSTOM_AGENT_TOOLS` n'est modifié ici.

Le protocole commun reste `IAO-EVALUATION-PROTOCOL.md` à la racine du dépôt.

## Références officielles consultées

- [Modèles](https://docs.typesafe.ai/models)
- [API System One](https://docs.typesafe.ai/api/system-one)
- [Choice](https://docs.typesafe.ai/primitives/choice) et [Score](https://docs.typesafe.ai/primitives/score)
- [Erreurs](https://docs.typesafe.ai/api/errors)
- [Jev et décisions du code](https://typesafe.ai/blog/dont-call-it-a-decision-model)
- [Contrat](https://typesafe.ai/legal/mca)
- [Données](https://help.typesafe.ai/articles/5974925716) et [activation ZDR](https://help.typesafe.ai/articles/9520184411)
