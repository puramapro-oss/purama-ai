# Réception ciblée IAO / Partenaires — 23 novembre 2026

## Résultat et périmètre

Les correctifs IAF01–IAF04 sont implémentés sur la base `d150c87ff9e3c7530765c4abaf5412c637b74366` de `audit/reliability-oauth-20261110`, qui contient la PR91 fusionnée. Le présent lot conserve le hub de contrats, les réservations de prospection et l’historique de conversation existants.

| Lot | Comportement obtenu |
| --- | --- |
| IAF01 | Dossier partenaire vérifié côté serveur, conversation isolée par compte/dossier, bouton explicite préparant réellement un contrat puis accès à sa revue. |
| IAF02 | PDF immuable, version et SHA-256, revue explicite, approbation exacte, réserve d’envoi SQL, reçu DocuSeal validé, état incertain sans renvoi automatique, projection de signature vers le prospect. |
| IAF03 | Délégation du scheduler uniquement avec le secret de service exact ; le scheduler ne peut pas approuver un document ou un email à la place de l’utilisateur. |
| IAF04 | Fuseau explicite, jours et heures vérifiés avant préparation et envoi, quota au jour local, reprise du même brouillon, sélection n8n bornée et aucun élément `_skip` envoyé au fournisseur. |

**PARTIEL pour l’objectif produit global.** Le texte libre du chat conseille et prépare ; il ne constitue pas un mandat d’exécution multicanal. Les appels téléphoniques, campagnes réelles, nouveaux droits ONE, primes et paiements ne sont pas activés par ce lot. Les conditions du contrat proviennent de la configuration enregistrée et sont présentées dans la revue du PDF ; ce correctif ne fixe pas un barème commercial général.

## Protection de la mise en ligne

Le client utilise exclusivement **`partner-contract-action`**. Cette nouvelle entrée importe le point d’entrée corrigé de `partner-generate-contract`, donc réutilise le même moteur et les mêmes données.

Cette séparation est nécessaire : un serveur historique ignore `action: 'prepare'` et envoie immédiatement. Une interface récente ne doit jamais lui envoyer cette requête pendant un déploiement partiel. Si la nouvelle fonction n’existe pas, la requête échoue sans revenir à l’ancienne route. L’ancien point d’entrée, une fois corrigé, refuse les anciennes commandes ambiguës avec HTTP 409.

Les changements de compte ou de dossier invalident les résultats tardifs. Dans l’écran Prospects, la lecture approuvée est liée au compte, au prospect, à la version et à l’empreinte du PDF ; les requêtes de contrat sont sérialisées dans le cycle du compte. Une réponse perdue à l’approbation laisse seulement une action de vérification de l’état.

## Vérification et portée des preuves

Le fichier [verification.json](./verification.json) donne les commandes, résultats, limites et empreintes des reçus. [source-manifest.json](./source-manifest.json) identifie les fichiers du lot. Les données des tests sont fictives et les transports fournisseurs sont simulés.

| Contrôle | Résultat |
| --- | --- |
| Handler/RPC de prospection et workflows versionnés | 96 tests réussis sur la version finale : 88 handler/SQL, 8 workflows. |
| Interface de contrat et parseur | 42 tests réussis, dont le refus de revenir à l’ancien endpoint. Les réglages font l’objet d’une réception séparée de 5 cas, comprenant la normalisation des fuseaux nommés. |
| Politique des assistants et nouveaux points d’entrée | 57 tests réussis, dont préparation via la nouvelle entrée et refus de commande historique avant effet. |
| Webhook et persistance | 46 tests réussis, sans test ignoré. |
| Chat partenaire et isolation | 13 tests serveur/PGlite et 22 tests de composants réussis. Les empreintes du reçu sont rapprochées du code final. |
| Contrats, PDF réel et réservations SQL | 38 tests réussis avant le seul changement final du littéral `app_slug`; ce dernier changement est vérifié séparément sur les vraies migrations et le vrai RPC. |
| PDF multipage | Rectangle de signature retrouvé sur la page 8 par PyMuPDF, avec les mêmes coordonnées que la requête API. |
| Types et revue | TypeScript ciblé frontend et handlers, lint ciblé, revue indépendante et vérification du diff. |

**Limite de la réception consolidée des 38 cas contrats :** des relances sur le dernier instantané ont été arrêtées avec code 137 avant résultat. Elles ne sont pas comptées comme réussies. La preuve conserve le passage 38/38, l’identité canonique vérifiée séparément, et les 57 cas des points d’entrée. Les contrôles du scheduler ont ensuite réussi dans une exécution séquentielle avec ressources bornées. Le typecheck global de l’application a également été interrompu ; les contrôles TypeScript ciblés sont distincts de cette tentative.

PGlite exécute les vraies fonctions SQL, mais ses requêtes concurrentes ne qualifient pas la contention entre transactions PostgreSQL natives. Les tests JSDOM qualifient les interactions et le cycle des comptes, pas un rendu dans un navigateur réel. Le téléchargement du navigateur Playwright a échoué avec HTTP 403 ; aucun résultat navigateur n’est revendiqué.

## Revue indépendante et procédure suivie

La cartographie avant édition identifie : `PartnerAgentProspects` et `src/lib/partner.ts` vers le contrat, les workflows outreach/relance vers `partner-send-outreach`, `PartnerAgent` / `AgentChatTab` vers `agent-chat`, puis les réservations, le hub, le webhook et le reporting des signatures. Le risque principal concerne l’identité, l’accord exact et les effets d’envoi.

La procédure de contrôle ciblée proposée précédemment a été suivie à la reprise, dans le contexte de l’instruction renouvelée de poursuivre : cartographie sourcée, travail isolé, typage, régressions ciblées, revue indépendante et contrôle du diff avant commit. **Aucun contrôle GitNexus n’est déclaré exécuté et `AGENTS.md` est inchangé.** Cette lecture ne produit pas un graphe d’appels dynamique et ne qualifie pas les workflows externes non versionnés. Le lot est comparé à sa base ; l’écart préexistant de cette branche avec `main` ne constitue pas une modification de ce lot.

Les défauts trouvés en revue ont été corrigés : validation conservée pour un autre PDF en cas de concurrence, ancien aperçu après changement de compte, statuts JSON malformés, état d’approbation restant occupé, horloge capturée avant attente d’un verrou, jours multidimensionnels faisant échouer la découverte, reprise d’un brouillon approuvé hors horaires, et compatibilité dangereuse avec l’ancien endpoint.

## Mise en service restant à qualifier

1. Appliquer en recette les trois migrations `20261123003000`, `20261123020000` et `20261123030000`, après leurs dépendances existantes. Le fuseau ajouté aux configurations historiques vaut explicitement UTC et doit être choisi dans les réglages du compte.
2. Déployer les deux entrées de contrat, le webhook, `partner-send-outreach` et `agent-chat`, puis vérifier les droits de service, la lecture des objets et la création des liens temporaires. Déployer le client après la nouvelle entrée de contrat ; aucun fallback vers l’ancienne route.
3. Importer les deux workflows n8n dans l’environnement de recette et vérifier les identités, l’absence de candidat, un quota atteint, une plage fermée et une reprise différée. L’import ou l’activation réelle n’a pas été effectué ici.
4. Exécuter la contention sur PostgreSQL natif et un parcours fournisseur de recette : préparer, relire, approuver, recevoir la demande, signer et constater la projection du webhook. Aucun vrai prospect n’a été contacté pendant cette réception.
5. Vérifier le parcours dans un navigateur réel. Conserver l’état `unknown` jusqu’à rapprochement opérateur ; ce lot n’ajoute pas d’automate de renvoi ou de réconciliation sans preuve.

Le renderer conserve Helvetica/WinAnsi. Les caractères non pris en charge ou identités trop larges font échouer la préparation avant approbation ; il n’est pas qualifié pour tous les alphabets. La préparation est bornée à trois tentatives et une approbation à 24 heures.

## Sources techniques vérifiées

- [Référence officielle DocuSeal](https://www.docuseal.com/docs/api), consultée le 23 novembre 2026 : distinction submission/submitter, identifiant externe, géométrie d’entrée `/templates/pdf`, pages commençant à 1, champ obligatoire, lien partagé désactivé explicitement, répétition des callbacks en erreur selon le service.
- [Imports partagés des fonctions Supabase](https://supabase.com/changelog/33613-deploy-edge-functions-from-cli-without-needing-docker-import-files-outside-of-supabase-directory), consulté le 23 novembre 2026. Les tests exécutent l’import de la nouvelle entrée ; le bundling Supabase réel reste à vérifier en recette.
