# Réponses partenaires, admission à l’affiliation et contrôles de fin de parcours

## Périmètre et continuité

Demande de Matiss : terminer le parcours médias existant et ses automatisations, sans doublon ni perte de travail. Lot `PRET_A_CODER`, dans la continuité de la PR 111 et de la demande de finalisation du 24 novembre 2026. Branche isolée `fix/partner-completion-20261124`, base initiale `9ab7e16b9d1230185d52d216a406c90a3a4a486d`. La PR 112, réalisée en parallèle, a ensuite rejoint la consolidation avec `48869219a22fef71edeb069a2f2b50d966edc363` ; son parcours de découverte doit être conservé lors de l’intégration. L’avance suivante PR 113 (`afaffbe26d7976f132d053b4600eb4fba300437b`), limitée aux preuves et gardes Wealth, reste également conservée.

Responsabilités : `conversation_completion` pour la préparation et les gardes des réponses ; `affiliation_bridge` pour l’admission du contrat signé et la contre-revue ; `readiness_review` pour le retrait d’autorisation dans les contrats, les vues de suivi et la garde Gmail/KARTA ; root pour les clients, la navigation, l’export, la composition et la réception.

## Critères de réception

- Une réponse humaine vérifiée mène à un brouillon local unique, puis au même aperçu, à la même approbation et au même expéditeur Email Agent.
- Le reçu le plus récent, la boîte, le destinataire, l’offre et les permissions sont contrôlés avant préparation et aux frontières de l’envoi.
- Un refus, un retrait, un brouillon rejeté ou une réponse remplacée ne sont pas réinterprétés comme une autorisation.
- Les envois Gmail directs de KARTA ne contournent pas le parcours médias et éditorial lié et approuvé. La correspondance legacy valide conserve son parcours ; les refus, suppressions et retraits explicites restent bloquants pour tous les profils.
- Une demande de signature médias préparée avant retrait ne peut pas partir après celui-ci ; les contrats déjà signés restent consultables.
- Un dossier d’admission est dérivé du contrat réellement approuvé et marqué signé dans le hub, avec des preuves concordantes et un rejeu idempotent.
- Les erreurs de lecture et changements de compte ne produisent ni faux montants nuls, ni données d’un autre compte, ni chargement permanent.
- Les accords médias sont listés depuis le snapshot signé du hub ; un refus ultérieur ou une reclassification du prospect ne masque pas cet historique et ne réactive aucun contact.
- La qualification financière manquante reste visible ; aucun lien actif, bénéficiaire, paiement ou API ONE n’est inventé.

## Réalisation

Les migrations additives 503 à 506 complètent les contrats, reçus, journaux et fonctions existants. La préparation de réponse n’effectue aucun POST Gmail : elle produit un texte factuel en français, anglais, allemand, espagnol, italien ou portugais. Les intentions bornées sont la demande de précisions et le rappel de l’offre qualifiée. La réponse entrante est relue intégralement dans les limites admises et présentée comme contexte privé ; son contenu ne devient pas une instruction d’agent.

Les quatre frontières Email — aperçu, approbation, réservation et départ — recontrôlent le contexte partenaire. Les finaliseurs et la réconciliation restent en place pour conserver un résultat fournisseur prouvé même si un refus arrive pendant un envoi déjà engagé. La navigation vers un journal utilise son identifiant exact, indépendamment des 200 dernières lignes de l’activité.

L’admission médias est un dossier versionné à partir du contrat signé. Il conserve le snapshot 30/30, les dix clauses, la version et l’empreinte du PDF approuvé, ainsi que les événements et identifiants de signature rapprochés. Le JSON n’est pas un nouveau document signé cryptographiquement, et l’empreinte ne prétend pas être celle du PDF après signature. L’interface vérifie aussi la cohérence des identités, des conditions et des indicateurs financiers internes avant export.

Le moteur et le registre ONE existants restent la destination à réutiliser. Leur révision de référence est `a5fed2edaaa2332c0e9aba3321d9ee32cf89a17e`. Leur API de production, les identités bénéficiaires, le catalogue et la politique exécutable ne sont pas qualifiés par ce lot. Les huit prérequis sont explicitement affichés. Les barèmes physiques et historiques ne sont pas remplacés par la règle médias.

## Vérifications et limites des preuves

Les tests locaux légers et leur réception exacte figurent dans `verification.json`. Les scénarios SQL utilisent les migrations réelles ; les transports fournisseurs sont contrôlés dans les tests. Quatre scénarios Chromium ont été ajoutés à la suite qualité existante : réponse et approbation, refus, export d’admission et erreur de suivi indépendante du dossier.

PGlite local avait été interrompu même sur un lancement minimal au lot précédent ; aucun nouvel essai SQL local n’est présenté comme réussi. Le navigateur local avait échoué avant toute assertion avec un refus de socket ; les nouveaux scénarios sont confiés au job navigateur existant. Aucun gate n’est supprimé ou assoupli. Les résultats de CI finaux sont attachés à la demande d’intégration et à la version suivante du document canonique.

L’index GitNexus disponible est partiel et en retard. Deux tentatives de rafraîchissement ont été interrompues avec le code 137 ; la seconde utilisait la rétention symbolique et une mémoire réduite. Les impacts ont été réellement interrogés sur l’index restant ; UNKNOWN n’est pas présenté comme absence de dépendance. Le rayon des fonctions SQL et des objets-outils est complété par les lectures des appelants et par les tests. Les fonctions partagées de suivi et de messages ainsi que les frontières d’envoi ont été annoncées à impact élevé avant édition. Le contrôle des changements avant commit est conservé séparément : staged (23 symboles, 20 processus) et comparaison main signalent un impact critique agrégé. La composition suivante conserve les différences attendues des deux fichiers partagés ; le CLI utilisé a disparu du cache lors du second contrôle, dont l’échec est conservé sans prétendre à une nouvelle analyse complète.

## Exploitation

Cette réception ne déploie pas les fonctions, migrations ou workflows sur un compte réel. Elle ne prouve pas un consentement, une signature, une attribution commerciale, une commission ou un paiement réel. Les données de la partie contractante, du catalogue, des conditions exécutables, des bénéficiaires et des prestataires doivent correspondre aux sources d’exploitation. Aucun e-mail prospect, engagement commercial, campagne, dépense, versement ou déploiement n’est exécuté par cette réalisation.

### Ordre de qualification pour une mise en service ultérieure

1. Identifier la base canonique, ses schémas et son état de référence ; conserver une sauvegarde et les écarts historiques avant toute reprise. Le choix d’un hébergeur ne désigne pas automatiquement le jeu de données.
2. Maintenir le traitement commercial en pause pendant la réception des migrations. Vérifier les dépendances existantes de découverte, politique médias, reçus et approbation Email, puis appliquer 503 à 506 dans leur ordre. La fenêtre entre 504 et 506 bloque volontairement les contrôles Email qui ne disposent pas encore du classifieur ; elle n’autorise aucun contournement.
3. Vérifier les signatures des RPC et leurs privilèges : préparation et liste d’admission accessibles au seul rôle authentifié avec propriétaire issu de la session ; garde d’envoi direct accessible au service ; tables de preuves non modifiables par le client. Confirmer le rechargement du schéma avant d’activer le nouveau runtime Gmail ou l’endpoint de préparation.
4. Recevoir le runtime et l’interface ensemble avec deux comptes d’essai appartenant à l’équipe. Vérifier le refus, le retrait tardif, le rejeu du brouillon, l’aperçu exact, l’historique signé après reclassification et l’isolation des exports. Les premiers contrôles utilisent des fournisseurs d’essai ; une invitation ou un envoi réel exige son contexte et son autorisation effectifs.
5. Raccorder les huit prérequis au moteur ONE existant. Recevoir attribution, encaissement, remboursement et règlement dans leur environnement autorisé avant d’afficher un affilié actif ou un versement disponible. Le JSON d’admission ne remplace aucun de ces contrôles.
6. En cas d’incident, remettre le traitement en pause et conserver reçus, brouillons, contrats et admissions. Réconcilier les résultats fournisseurs incertains avant reprise ; une restauration de code ne justifie ni suppression de preuves ni répétition d’un envoi ou d’un paiement.

Cette procédure est un ordre de réception, pas un reçu de déploiement. Les tests CI et leurs fournisseurs contrôlés conservent la portée décrite ci-dessus.
