# PURAMA — coordination des agents, budgets, crédits et prospection

Date de qualification : **10 novembre 2026**.

**Complément de réconciliation CHEF #21/#27 :** [réservations persistantes, migration additive 024 et nouvelle passe KARTA à 980/980](budget/reconciliation.md). Ce complément distingue ses preuves des résultats historiques ci-dessous et conserve les protections de la base #27.

**État global : PARTIEL pour la mise en service.** Les correctifs ci-dessous sont préparés et vérifiés dans des environnements isolés. Ils ne sont pas appliqués à la production. Les tests locaux de ONE ne constituent pas un raccord actif à ses fournisseurs.

## Périmètre

Le correctif initial part exactement de `1daf6314d60f6dd336c3a3601ddf73cf432ef4b3`, sur la branche `audit/aether-karta-consolidation-20261110`. La qualification finale rapproche ce lot du nouveau commit commun `27815bcc9660adcc925f1a6c2b8651ff04ff5062`, publié pendant les essais. Il prolonge le moteur KARTA/CHEF existant et les parcours de l'application PURAMA. Aucun second moteur, changement d'hébergement, nouveau tarif ou quota commercial n'est introduit.

Les **37 fichiers de source, migration et banc de test** sont répertoriés avec leurs empreintes dans [le manifeste final](integration/final-source-manifest.json). [Le contrôle du checkout de validation](integration/verified-remote-source-manifest.json) confirme la correspondance de leurs 37 empreintes. Les deux manifestes de dépendances et leurs verrous sont inchangés.

Le rapprochement conserve les 26 fichiers ajoutés ou modifiés par le commit commun. Ses migrations 019/020 et la réservation de 018 dans la PR #20 motivent la renumérotation de notre série en **021/022/023**, sans changer un octet de leur SQL. Le chargeur du test de quarantaine utilise une liste CHEF explicite : la sélection numérique précédente aurait aussi chargé les nouvelles migrations KARTA sans leurs prérequis. La proposition de raccord des consignes de la PR #20 reste non appliquée ; elle appartient à un autre contrat que les briefs CHEF.

Les journaux initiaux conservent les anciens numéros 018/019/020. Les notices utilisent les nouveaux noms ; [le manifeste de la première qualification](integration/qualified-1daf-source-manifest.json) conserve les empreintes et chemins historiques.

## Ce qui est corrigé

### 1. Des agents simultanés qui respectent un budget partagé

La migration 021 réserve la capacité dès l'admission d'une tâche. Sous verrou de mission, elle additionne la consommation enregistrée, les estimations complètes des tâches actives et l'estimation de la candidate. Les plafonds de tokens et de coût sont vérifiés séparément.

Le défaut a été reproduit sur la base : deux tâches estimées à 70 pouvaient être admises sous un budget commun de 100 avant le retour de leur consommation. Après correction, une seule est admise. Le scénario a aussi été vérifié sur **douze connexions PostgreSQL simultanées**, avec observation des sessions et des verrous.

Une réservation temporaire laisse avancer une autre tâche admissible. Une estimation inconnue dans une dimension plafonnée bloque l'admission ; un zéro explicite reste valide. Les contrôles de génération, de scope, de dépôt et de concurrence existants restent en place.

Les estimations `estimatedTokens` et `estimatedCostMicros` traversent désormais la normalisation du brief, son hash, le RPC et l'insertion SQL via 022. Les briefs historiques sans ces champs conservent leur hash. Voir [budget](budget/README.md) et [estimations](estimates/README.md).

**Limite :** une réservation fondée sur une estimation ne garantit pas le montant réel facturé par un fournisseur. Le rapprochement des reçus d'usage et les plafonds fournisseurs restent nécessaires.

### 2. Un arrêt d'agent confirmé avant une reprise

Le driver et le vérificateur refusent un signal déjà annulé. Chaque exécution POSIX possède un groupe de processus dédié. L'annulation adresse SIGTERM, puis SIGKILL si nécessaire ; la fin du processus direct et la disparition du groupe sont attendues.

Lorsque l'arrêt ne peut pas être confirmé, le superviseur exige une quarantaine durable, passe la tâche en `blocked_external` et interrompt le daemon. Un échec de persistance interrompt également le daemon. Les générations ne sont pas réattribuées artificiellement pour faciliter une reprise.

La migration 023 protège l'admission et la validation finale contre les périmètres en quarantaine. Son journal survit à la suppression d'une tâche ou d'une mission. Une lease expirée produit une quarantaine avant le blocage de la tâche ; elle n'autorise plus automatiquement un nouveau processus. Une portée inconnue conduit à une exclusion conservatrice globale. Voir [le dossier CHEF](chef/README.md).

**Limite :** un groupe POSIX n'est ni une sandbox contre un processus qui change volontairement de session, ni une preuve d'arrêt d'un job distant. Windows reste refusé avant lancement. Aucune levée automatique de quarantaine n'est fournie.

### 3. Un paiement confirmé ne crédite qu'une fois

Le webhook historique n'accorde un crédit qu'après confirmation du paiement et persistance du reçu. Une session terminée mais encore impayée attend le succès asynchrone. Le mois de crédit provient de l'événement de succès signé, pas de sa date de livraison.

Deux contraintes uniques protègent la session et l'événement. Les répétitions relisent et contrôlent les attributs immuables. Une erreur de base ne produit pas un faux acquittement. Les anciens crédits sans preuves suffisantes exigent une réconciliation ; la migration refuse les doublons historiques sans les supprimer.

Le premier test PostgreSQL natif a révélé une collision entre les deux index que les tests à un seul backend n'avaient pas reproduite. Le correctif traite les conflits de tous les index puis vérifie strictement la session. Le rejeu final de **douze livraisons concurrentes** produit une seule ligne de **2 000 actions**, avec des réponses cohérentes aux répétitions. Ce volume appartient au pack historique existant ; il ne définit pas un nouveau quota d'abonnement. Voir [facturation](billing/README.md).

### 4. Une prospection approuvable, traçable et sans renvoi aveugle

Une réservation persistante protège chaque compte, prospect et étape. Une protection supplémentaire par destinataire normalisé survit à la suppression puis au réimport du prospect. L'opposition reste persistante. L'état du compte, les réponses, les échéances, le destinataire, l'expéditeur et les approbations sont revérifiés avant envoi.

Le parcours manquant d'approbation est raccordé à l'interface : aperçu du message figé, destinataire et expéditeur visibles, bouton explicite, version liée à l'utilisateur et à l'email. Les trois étapes de relance sont accessibles avec vérification de leur échéance côté serveur.

L'aperçu HTML est isolé dans une iframe sans permissions, avec une politique CSP restrictive. Le test navigateur injecte du contenu hostile et contrôle le document réellement affiché, les requêtes, la navigation et l'absence d'exécution dans le parent.

Un succès nécessite une preuve fournisseur persistée. Un timeout ou une confirmation perdue reste un résultat incertain, sans renvoi automatique. L'interface n'affiche pas « Email transmis » sur la seule approbation, ni sur un statut `sent` dépourvu d'identifiant fournisseur. Voir [prospection](outreach/README.md).

## Matrice de validation

| Contrôle | Résultat et portée | Preuve |
|---|---|---|
| Budget dédié | **PASS, 18/18** ; vrai SQL dans PGlite, reproduction avant/après | [Après](budget/mac-budget.txt), [avant](budget/mac-baseline.txt) |
| Estimations | **PASS, 58 tests ciblés**, dont 44 nouveaux et 14 existants | [Dossier](estimates/README.md) |
| Crédit final | **PASS, 38/38**, après le correctif découvert en concurrence native | [Journal final](integration/billing-final.txt) |
| Prospection handler/client/SQL | **PASS, 47/47** | [Journal](outreach/final-test.log) |
| Ensemble KARTA intégré | **930 cas couverts par la passe globale et la reprise ciblée** : 929/930 dans la passe globale, puis 5/5 pour le fichier corrigé ; réserve expliquée ci-dessous | [Passe globale](integration/combined-karta-full.txt), [reprise finale](integration/combined-process-verified.txt) |
| Concurrence PostgreSQL 18.4 | **PASS, 7/7**, dont trois scénarios à douze connexions, sur la base réunie et les migrations renumérotées | [Résultats détaillés](integration/combined-native-postgres-results.json), [journal](integration/combined-native-postgres.txt) |
| Qualité KARTA et prospection dans Playwright | **PASS, 18/18** : 17 parcours navigateur et un test de classification ; profil isolé, appels externes interceptés | [Journal final](integration/combined-browser-verified.txt) |
| TypeScript et compilation KARTA | **PASS**, sur la base réunie ; types revérifiés après la dernière correction de fixture | [Types](integration/combined-karta-types-verified.txt), [build](integration/combined-karta-build.txt) |
| TypeScript et compilation application | **PASS**, application et base commune réunies | [Types](integration/combined-app-typecheck.txt), [build](integration/combined-app-build.txt) |
| Audit des dépendances de production, seuil high | **PASS au seuil demandé** : KARTA 0 avis ; application 6 avis faibles/modérés | [KARTA](integration/karta-audit.txt), [application](integration/app-audit.txt) |
| ONE existant, checkout séparé | **PASS, 378/378**, types, lint et build ; source inchangée | [Qualification et limites de preuve](one/qualification.json) |
| Services et production réels | **NON TESTÉ / non activé** | Voir les conditions de mise en service ci-dessous |

### Lecture exacte de la passe KARTA

Sur la base réunie `27815…`, la passe complète a exécuté **930 tests dans 64 fichiers : 929 réussis et un échec**, sans cas ignoré. La commande conserve un seul worker, un délai de test de 30 secondes et un délai de préparation de 90 secondes. Elle n'est pas présentée comme une exécution globale verte.

L'échec porte sur la présence de la première pulsation d'un descendant, avant l'annulation à tester : `vi.waitFor` imposait implicitement une préparation inférieure à une seconde. Le même scénario inchangé a réussi seul en 727 ms. Une première correction limitée à ce scénario a ensuite révélé la même hypothèse dans la préparation du test de refus de signal. Les trois préparations sont maintenant bornées explicitement à trois secondes et disposent d'un nettoyage dans `finally`, même en cas d'échec initial. Le timeout du processus, les délais de grâce/confirmation et les assertions après signal sont conservés. L'enveloppe Vitest du scénario dont le nettoyage peut durer 2,5 secondes est portée à dix secondes pour ne pas interrompre ce nettoyage.

Le fichier final `chefProcess.test.ts` a été rejoué intégralement : **5/5 PASS**, sans cas ignoré. Le typecheck global a ensuite terminé 0. Aucun fichier produit n'a changé après la passe globale : seules des fixtures et la configuration du banc de navigateur ont été ajustées. La couverture finale de 930 cas est établie par cette passe et la reprise ciblée, pas par une seconde exécution globale verte.

La qualification initiale sur `1daf…` est également conservée : **800 réussis, 3 timeouts de tests et 10 cas non exécutés après un timeout de préparation** ; reprise des deux fichiers concernés à **77/77 PASS**, puis crédit final à **38/38 PASS**. Ces comptes historiques et ceux des sous-lots se recouvrent ; ils ne doivent pas être additionnés comme des tests distincts.

### Échecs intermédiaires conservés

Le [rapport PostgreSQL avant correction](integration/native-postgres-before-fix.json) conserve la violation `23505` de l'index d'événement, résolue dans le résultat final. Les anciens journaux navigateur conservent une assertion incorrecte sur `frame.url()` pour une iframe opaque, puis une attente trop courte lors de la compilation à froid. Le test final vérifie `document.URL` et `location.href` égaux à `about:srcdoc`, attend explicitement la réponse de préparation et conserve toutes les assertions d'isolation.

Le premier lancement navigateur sur la base réunie s'est arrêté avant les tests parce que le port 4176 appartenait à une autre instance. Le banc partage désormais une origine de boucle locale configurable via `PURAMA_QUALITY_PORT`, avec port strict et réutilisation interdite. Le rejeu réussi utilise **48716**. Le serveur de l'autre travail n'a pas été arrêté. Les trois specs qui fixaient l'origine utilisent le helper commun ; la qualification d'exécution porte sur les 18 cas KARTA/prospection, tandis que les autres specs ont été contrôlées par découverte et typage, sans nouvelle revendication de couverture navigateur.

Les manifestes et métadonnées intermédiaires des sous-dossiers documentent leurs étapes historiques. Pour l'état final, utiliser le manifeste final, les résultats préfixés `combined-` et la présente synthèse.

Les couleurs de terminal, espaces de fin de ligne et lignes vides terminales des journaux de console ont été normalisés pour leur publication. [Le registre de normalisation](integration/console-log-normalization.json) conserve les empreintes avant/après ; aucun résultat ou fichier JSON de preuve n'a été modifié par ce traitement.

## Environnements et reproductibilité

La qualification intégrée a utilisé un checkout isolé sur macOS, avec les verrous npm du dépôt. Le cluster PostgreSQL est temporaire, utilise un socket Unix privé sans écoute TCP, un environnement PG contrôlé et des données fictives. Les douze connexions sont distinctes ; `pg_stat_activity` et `pg_locks` confirment leur chevauchement. Le rapport confirme l'arrêt du serveur et la suppression du cluster, sans erreur de fermeture des clients.

Le banc natif charge explicitement les migrations CHEF et les deux périmètres crédit/prospection. Il ne qualifie pas automatiquement la concurrence native des nouvelles livraisons KARTA de la base commune ; leurs migrations 019/020 et les nouveaux chemins associés sont exercés dans la suite PGlite réunie. Les deux runtimes utilisent des tables et chemins distincts.

Le script [native-postgres.py](integration/native-postgres.py) est inclus pour reproduction avec les outils PostgreSQL installés. Aucun paiement, email ou appel fournisseur n'a été créé pendant ces scénarios. Le navigateur utilise un profil de test, sans session personnelle réutilisée ; les requêtes et WebSockets externes sont interceptés.

ONE a été qualifié séparément au commit `485308a1d4b125c2973387285a2b16c251989231`. Son résultat est une observation de console conservée partiellement, avec la commande et son code de sortie dans la fiche de qualification. Aucun fichier source suivi de ONE n'a été modifié. Ses adaptateurs restent `NOT_CONFIGURED` et la production `NOT_ACTIVATED` dans la provenance examinée.

## Conditions de mise en service

1. **Arrêt coordonné des anciens lanceurs :** suspendre les workers existants et confirmer la fin de leurs processus avant les migrations CHEF et le démarrage des workers corrigés. Éviter un mélange durable d'anciens et de nouveaux lanceurs.
2. **Migrations et ingestion coordonnées :** respecter d'abord les prérequis 019/020 de la base KARTA commune, puis appliquer 021, 022 et 023 avec le nouveau normaliseur de briefs. La migration 019 peut déjà être présente à l'identique via la PR #20 ; son cycle de consignes 018 n'est pas intégré par ce lot. Vérifier les anciennes missions plafonnées dont les estimations sont absentes. Aucun coût n'est inventé et aucune donnée n'est complétée automatiquement. Le même couple version/hash renvoie l'existant ; une reprise doit tenir compte du travail déjà effectué.
3. **Crédits historiques :** examiner les doublons et preuves manquantes avant application de la migration de crédit. Un refus de migration demande une réconciliation documentée, sans suppression arbitraire des écritures.
4. **Prospection :** appliquer sa migration avant l'endpoint puis le client. Une RPC absente bloque l'envoi. Les cas incertains exigent une vérification fournisseur avant toute décision de nouvel envoi.
5. **Raccords réels :** configurer et qualifier les adaptateurs autorisés de ONE, les reçus d'usage, les secrets et comptes de test fournisseurs. Le raccord n8n actuel par jeton service-role/en-tête d'identité n'est pas une délégation utilisateur reconnue par cet endpoint ; aucun contournement de `auth.getUser` n'est ajouté.
6. **Vérification en environnement cible :** effectuer le parcours complet sur l'infrastructure retenue, puis autoriser la mise en production sur la base de ce résultat. Les présents tests ne prouvent ni une livraison réelle d'email, ni un paiement réel, ni la disponibilité du modèle configuré.

La quarantaine exige une résolution opérateur auditée conservant son journal, avec preuve d'arrêt et réconciliation des effets. Aucun bouton de remise à zéro aveugle n'est fourni. Le présent lot ne certifie pas la conformité internationale de campagnes, la rentabilité commerciale, ni un fonctionnement autonome illimité.

## Dépendances et portée de l'audit

Le contrôle exécuté est `npm audit --audit-level=high --omit=dev`. Son code de sortie nul ne signifie pas l'absence de tout avis. L'application conserve deux avis faibles et quatre modérés dans la chaîne `opentimestamps`, `bitcore-lib`, `elliptic`, `request`, `request-promise` et `request-promise-core`. La correction forcée proposée par npm rétrograderait `opentimestamps` à `0.0.0` avec rupture annoncée ; elle n'a pas été appliquée aveuglément. Les verrous n'ont pas été modifiés.

La [note de portée des dépendances](integration/dependency-scope.md) distingue les wrappers web sans consommateur identifié des imports serveur encore utilisés pour les preuves de contrats. Leur retrait du seul manifeste web ne corrigerait pas les fonctions serveur. Elle consigne également un contrôle d'autorisation local incomplet dans `contracts-ots-stamp`, dont la protection effective en passerelle reste non qualifiée. Aucun exploit n'a été exécuté ni observé.

Les impacts GitNexus ont été examinés avant modification dans chaque lot. L'index final et la détection de changements servent à contrôler le périmètre ; le graphe ne relie pas exhaustivement les RPC TypeScript aux fonctions SQL. Les tests du vrai SQL et des chemins appelants complètent donc cette analyse.

Le [contrôle final des 37 fichiers de source et de banc](integration/combined-gitnexus-detect-staged.txt) identifie 461 symboles et 12 processus affectés, avec un risque **HIGH**. La [comparaison finale avec `origin/main`](integration/combined-gitnexus-detect-main.txt) inclut les fondations préexistantes et le nouveau commit Aether : 290 fichiers, 2 488 symboles et 356 processus, risque **CRITICAL**, liste affichée tronquée par l'outil. Les fichiers de preuves et les scripts QA font aussi l'objet d'un contrôle de périmètre et de provenance ; ils ne sont pas des modules du runtime produit.

Ces risques ont été signalés avant publication et ne sont pas interprétés comme une mesure de qualité des tests. [L'indexation finale et les deux commandes](integration/combined-final-checks.json) ont terminé 0 sur le checkout isolé testé. Les analyses de la première base restent conservées. Une seconde indexation locale bloquée sur une identité de processus non vérifiable a été interrompue sans suppression du verrou, puis remplacée par les exécutions réussies sur macOS.
