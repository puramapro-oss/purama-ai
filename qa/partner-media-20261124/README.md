# Partenariats médias : réception du lot du 24 novembre 2026

Base de travail : `18c40d0eb59b48636dd8d8fb54c0516b700ed746`, branche de consolidation `audit/reliability-oauth-20261110`. Lot isolé : `fix/partner-media-readiness-20261124`.

## Résultat livré

La recherche, la qualification, la préparation de propositions médias et éditoriales, les relances dans le fil d'origine, la réception des réponses et la préparation du contrat médias réutilisent le système partenaires existant. Trois migrations additives portent les nouvelles preuves et règles. Aucun contact historique n'est réputé avoir donné son accord par migration.

La découverte reprend les pays et langues du compte et ne retient une adresse que lorsqu'elle apparaît dans le résultat source conservé. L'import reste `identified`. Une qualification authentifiée distincte enregistre le rôle, la source, la langue, le pays et une preuve explicite d'accord avant un envoi Resend. Le propriétaire peut retirer cette permission. Le serveur vérifie de nouveau ces éléments avant l'envoi ; une modification du destinataire, de l'offre ou de l'identité invalide l'ancien contexte.

Les propositions médias utilisent le taux de 30 % et les faits de l'offre fournis, avec des gabarits français, anglais, allemand, espagnol, italien et portugais. La description du produit n'est pas traduite ni inventée automatiquement. Une langue non prise en charge bloque la préparation avec un motif visible. Le parcours rédactionnel propose une couverture indépendante, sans promesse de commission. Le mode assistant identifie IAO ; le mode signé par une personne exige l'approbation réelle du message.

Les relances médias sont limitées à deux. Elles utilisent le RFC `Message-ID` réellement obtenu auprès de Resend, distinct de son identifiant API, et des en-têtes `In-Reply-To` / `References` vérifiés. Un changement de destinataire ou de boîte empêche la réutilisation de l'ancien fil. La boîte Gmail raccordée est vérifiée dans le parcours de réception ; une ancienne connexion ne peut pas écrire sous une nouvelle version de connexion.

Une réponse vérifiée suspend les relances. Les refus reconnus, plaintes et rejets confirmés produisent une suppression durable. Les reçus sont dédupliqués par compte, les anciennes réponses ne remplacent pas une réponse plus récente et une acceptation tardive d'envoi ne rétrograde pas un partenaire signé ou actif. Le workflow n8n appelle l'endpoint de réception sans exporter de jeton OAuth Gmail. Une preuve RFC déjà liée permet de lire Gmail lors d'une indisponibilité ultérieure de l'historique Resend, en conservant un résultat partiel explicite.

Le contrat médias est déterministe : taux 30/30, offre exacte et dix clauses renseignées. Les conditions historiques restent dans leur parcours existant. L'aperçu et l'approbation portent sur le PDF exact avant signature. Les refus de préparation sont affichés comme des motifs métier, et les incidents techniques restent des erreurs techniques.

## Vérifications locales observées

| Périmètre | Résultat |
| --- | --- |
| Recherche : handler réel avec fournisseurs simulés | PASS, 23 tests |
| Messages médias et intégration du sender | PASS, 25 tests |
| Contrat médias, rendu PDF réel, empreinte et approbation | PASS, 31 tests |
| Réception : parsing, workflow, preuve déjà liée et annulation | PASS, 31 tests |
| Paramètres : persistance, compte et nouvelles clauses | PASS, 33 tests |
| Messages d'interface des contrats | PASS, 40 tests |
| Typage complet du site | PASS |
| Typage complet KARTA après correction du type Node du test | PASS |
| Typage ciblé du handler de réception | PASS |
| Contrôle des espaces du diff | PASS |

Total : **183 tests ciblés exécutés avec succès**. Les doubles exécutions d'une même suite ne sont pas additionnées. Les fournisseurs utilisés par les tests sont simulés ; aucun prospect n'a été contacté. Le reçu structuré et les empreintes des journaux figurent dans `verification.json`.

## Vérifications à recevoir dans la CI

Les migrations et transactions SQL doivent passer les suites KARTA, y compris qualification, permissions, retrait d'accord, instantanés figés, files, contrats et réception. Le moteur PGlite local a été interrompu avec le code 137 même dans un essai minimal ; aucune réussite SQL locale n'est revendiquée.

Les six recettes navigateur doivent passer le job `site`. Chromium local a échoué avant toute assertion produit avec `socket() failed: Operation not permitted`. Les workflows PR existants découvrent les nouveaux tests sans nouveau déclencheur. La commande Deno existante inclut maintenant les quatre endpoints partenaires concernés.

L'analyse GitNexus applicative est partielle. Les impacts des fonctions existantes ont été examinés, notamment les deux modules de retours d'interface classés HIGH et annoncés avant édition. Les symboles SQL, plusieurs nouveaux callbacks et le workflow ne sont pas résolus dans l'index : leur statut est UNKNOWN, complété par lecture des appels et tests ciblés. La comparaison avec `main` inclut également les travaux antérieurs de consolidation ; le diff de ce lot doit être examiné contre sa base ci-dessus.

## Limites fonctionnelles conservées

- Ce lot ne déploie pas les migrations, fonctions ou workflows en production et ne prouve pas les identifiants ni la délivrabilité d'un compte réel.
- Réception et suspension ne constituent pas un moteur de négociation autonome. La génération et l'envoi d'une réponse mandatée depuis un reçu partenaire ne sont pas raccordés ici.
- Les 30 % constituent la proposition et le contrat. L'enrollment, l'attribution des ventes et le règlement automatique médias ne sont pas raccordés au commerce. Voir `commission-bridge-audit.md` pour les sources et les dépendances structurées manquantes. L'interface ne présente plus cette activation comme automatique.
- Les annulations, retours, pays, produits, échéances, fenêtres et bénéficiaires doivent être explicitement structurés avant toute automatisation financière ; aucun paramètre financier n'est déduit du texte libre du contrat.
- Une politique fournisseur d'accord préalable s'applique même lorsqu'une autre règle permettrait une prospection professionnelle. Un résultat de recherche ou une adresse publique ne constitue pas cet accord.

## Références techniques et fournisseur consultées

- Resend, acceptable use : https://resend.com/legal/acceptable-use
- Resend, preuve RFC des envois : https://resend.com/changelog/message-id-for-sent-emails
- Resend, reçu d'un envoi : https://resend.com/docs/api-reference/emails/retrieve-email
- Commission européenne, transparence de l'interaction avec une IA : https://digital-strategy.ec.europa.eu/en/faqs/transparency-obligations-under-article-50-ai-act

Ces références motivent les garde-fous ; elles ne constituent pas une preuve d'exploitation en production. Les résultats distants de CI sont attachés à la demande d'intégration du lot.
