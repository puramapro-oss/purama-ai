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
| Contrats, PDF réel et réservations SQL | 38 tests réussis sur les sources finales dans GitHub Actions, inclus dans les 4 401 tests KARTA. Les résultats locaux antérieurs et le delta d’identité restent conservés séparément. |
| PDF multipage | Rectangle de signature retrouvé sur la page 8 par PyMuPDF, avec les mêmes coordonnées que la requête API. |
| Types et revue | TypeScript ciblé frontend et handlers, lint ciblé, revue indépendante et vérification du diff. |

**Historique de la réception locale des 38 cas contrats :** des relances sur le dernier instantané ont été arrêtées avec code 137 avant résultat. Elles ne sont pas comptées comme réussies. La preuve conserve le passage 38/38, l’identité canonique vérifiée séparément, et les 57 cas des points d’entrée. Les contrôles du scheduler ont ensuite réussi dans une exécution séquentielle avec ressources bornées. Le typecheck global local a également été interrompu ; les contrôles ciblés et les réussites ultérieures de CI décrites ci-dessous sont distincts de cette tentative.

PGlite exécute les vraies fonctions SQL, mais ses requêtes concurrentes ne qualifient pas la contention entre transactions PostgreSQL natives. Les tests JSDOM qualifient les interactions et le cycle des comptes, pas un rendu dans un navigateur réel. Le téléchargement local de Playwright a échoué avec HTTP 403. Les suites navigateur existantes ont ensuite été exécutées sur GitHub ; cette exécution ne qualifie pas encore le nouveau parcours complet d’approbation de contrat.

## Réception GitHub et correction d’une fixture

La [première exécution CI](https://github.com/puramapro-oss/purama-ai/actions/runs/45092414496) porte sur la tête `d633b769f8ed8f03df64088c7267c18d85b76d17`, fusionnée à sa base sous `5fe12ae67a0ad382f37d88704c0b98258b299d74`. Les deux arbres ont été récupérés et vérifiés identiques : `b4d65fb82d0e8e3d2482605b5b3fa5ae4caf6af6`.

**KARTA : PASS, 4 401 tests dans 192 fichiers**, dont les 38 cas contrats finaux, puis typecheck et build. La réserve locale des 38 cas est levée par cette exécution indépendante. Le job site a aussi réussi son lint, son build, le typecheck global et les suites navigateur précédant `ui-state`.

**CI site initiale : PARTIEL, 24/26 cas ui-state réussis.** Les deux cas de sauvegarde partenaire n’enregistraient rien : leur fixture de configuration existante omettait le nouveau champ obligatoire `outreach_timezone`. Le transport fournissait ce fixture sans complément ; la vraie validation refusait cette configuration avant toute écriture. La migration et le défaut produit contiennent déjà `UTC`.

La correction ajoute uniquement `outreach_timezone: 'UTC'` au fixture partenaire. Les scénarios d’isolation et la validation produit restent intacts. Le job site exécute désormais `tsc --noEmit -p tests/ui-state/tsconfig.json` tôt dans sa séquence ; ce contrôle a réussi localement et détecte ce type d’écart de schéma avant les longues suites navigateur. Le manifeste inclut ces deux fichiers complémentaires.

Les [extraits de logs CI](./evidence/ci-first-run.json) distinguent les réussites, les deux échecs et la provenance. La deuxième CI confirme **26/26 cas ui-state réussis** à la révision testée ; le détail de l’autre échec et de son complément de correction figure ci-dessous. Le code applicatif reste identique à la tête déjà reçue par les 4 401 tests.

### Suivi du transport de test asynchrone

La [deuxième CI](https://github.com/puramapro-oss/purama-ai/actions/runs/45094643856), sur `00586c2ffae7619198b989b5f9df78a3cb1cea4c`, confirme de nouveau **4 401/4 401 tests KARTA** et **26/26 tests ui-state**. Elle relève **16/17 cas async-ui réussis** : le faux `Query` ne possède pas `is`, appelé par le vrai client pour filtrer l’historique partenaire sans dossier avec `partner_prospect_id IS NULL`. La requête n’est donc jamais enregistrée par le simulateur.

La reproduction avant modification a confirmé ce `TypeError` avec le vrai client et le transport simulé ; le contrôle email fonctionne. Le transport de test est complété avec la méthode manquante et la conservation explicite du filtre `null`. Dans ce complément, les assertions d’isolation, le code produit et les contrôles de permissions restent inchangés. L’intégration part de `cbff901591d92f3760a657b1d35654db76d477a0` et conserve les corrections parallèles des paramètres partenaires et du calcul local ; la CI doit qualifier cette composition. Les [extraits du deuxième run](./evidence/ci-second-run.json) conservent les résultats et leur provenance.

L’environnement local est devenu indisponible après cette reproduction. La reprise utilise les sources de la révision publiée et la même branche GitHub ; aucun contrôle local après ce correctif n’est présenté comme exécuté. Les suites existantes `ui-state`, `async-ui` et `mobile-auth`, avec leur préparation de navigateur, passent désormais plus tôt dans le job site. Chaque commande reste présente une fois. **Le résultat de la CI suivante est suivi dans la PR #93.** L’authentification mobile, sautée après l’échec précédent, reste à recevoir.

## Revue indépendante et procédure suivie

La cartographie avant édition identifie : `PartnerAgentProspects` et `src/lib/partner.ts` vers le contrat, les workflows outreach/relance vers `partner-send-outreach`, `PartnerAgent` / `AgentChatTab` vers `agent-chat`, puis les réservations, le hub, le webhook et le reporting des signatures. Le risque principal concerne l’identité, l’accord exact et les effets d’envoi.

La procédure de contrôle ciblée proposée précédemment a été suivie à la reprise, dans le contexte de l’instruction renouvelée de poursuivre : cartographie sourcée, travail isolé, typage, régressions ciblées, revue indépendante et contrôle du diff avant commit. **Aucun contrôle GitNexus n’est déclaré exécuté et `AGENTS.md` est inchangé.** Cette lecture ne produit pas un graphe d’appels dynamique et ne qualifie pas les workflows externes non versionnés. Le lot est comparé à sa base ; l’écart préexistant de cette branche avec `main` ne constitue pas une modification de ce lot.

Les défauts trouvés en revue ont été corrigés : validation conservée pour un autre PDF en cas de concurrence, ancien aperçu après changement de compte, statuts JSON malformés, état d’approbation restant occupé, horloge capturée avant attente d’un verrou, jours multidimensionnels faisant échouer la découverte, reprise d’un brouillon approuvé hors horaires, et compatibilité dangereuse avec l’ancien endpoint.

## Reprise : isoler les sauvegardes et signatures tardives

**PASS local sur les comportements ciblés ; réception de la nouvelle tête en CI requise.** Ce complément appartient à la même PR93, sur la base `00586c2ffae7619198b989b5f9df78a3cb1cea4c`. La correction concurrente du fixture et son contrôle TypeScript sont conservés par avance rapide. Le composant produit de cette base est identique à celui de `d633b769`, sur lequel la régression a été reproduite.

- Identité et validation : `puramapro-oss/purama-ai`, paramètres partenaires existants, `PRET_A_CODER` ; validation collective du 21 novembre puis demande actuelle d’auditer et corriger le code.
- Responsable du correctif : `/root/iao_audit` ; contre-revue du diff et des nouveaux tests par `/root`.
- Périmètre : `PartnerAgentSettings.tsx`, son nouveau fichier de régression et une ligne dans le contrôle TypeScript partenaire existant. Les contrats, migrations, workflows, autorisations et transports fournisseurs sont conservés.
- Critères : aucune restitution de A dans B, invalidation après A→B→A ou démontage, brouillons plus récents conservés, opérations de B indépendantes d’une attente de A, et une seule requête par action simultanée dans un cycle de compte.

La nouvelle normalisation du fuseau remplaçait toute la configuration après la sauvegarde. Une réponse de A pouvait donc remettre ses réglages dans l’écran de B ; elle pouvait aussi écraser les saisies effectuées pendant l’attente. Le téléchargement de signature avait le même problème de copie périmée et ses notifications tardives n’étaient pas isolées.

Les deux opérations capturent maintenant le compte, son cycle et une réservation locale de requête. Changement de compte, démontage ou remplacement de réservation rendent leur restitution inerte. Les opérations de B repartent avec leur propre état d’attente. Les mises à jour fonctionnelles conservent les nouvelles saisies ; la normalisation du fuseau ne s’applique que si ce champ correspond toujours à la valeur envoyée. Les doubles clics et sélections de fichier ne créent plus deux requêtes avant le rendu React suivant.

| Vérification de ce complément | Résultat |
| --- | --- |
| Reproduction sur le composant original | 12 échecs attendus et 1 réussite sur 13 nouveaux cas, commande complète avec code 1. |
| Régression finale après composition avec la correction du fixture | **18/18 tests réussis** : 13 nouveaux cas et les 5 contrôles de fuseau existants, code 0. |
| TypeScript ciblé existant, nouveau fichier de tests inclus | **PASS**, code 0. |
| Lint du composant et des deux fichiers de tests | **PASS**, code 0. |
| Revue indépendante | Diff et cas de concurrence relus par l’agent principal ; aucun défaut supplémentaire identifié dans ce périmètre. |
| TypeScript global local | Deux tentatives non reçues : interruption 137 puis limite de heap 134 ; le contrôle global reste à recevoir en CI sur la nouvelle tête. |
| GitNexus du complément | Impacts obtenus sur un index précédent, risque `UNKNOWN` ; reconstructions exactes interrompues 137. La détection finale a été appelée et a échoué faute d’index enregistré : contrôle de graphe **PARTIEL**, jamais déclaré réussi. |

Les reçus exacts sont dans `evidence/settings-ownership-*.log.json` et la section `settings_ownership_followup` de `verification.json`. Les tentatives interrompues restent distinctes des commandes complètes. Les nouvelles assertions exécutent le véritable composant React dans JSDOM avec des réponses différées et des données fictives ; elles ne contactent aucun fournisseur et ne sont pas des résultats de navigateur réel.

La cartographie manuelle identifie l’import différé dans `src/App.tsx`, la route `/dashboard/partner-agent/settings` et le harness `tests/ui-state/harness.tsx`. Le graphe ancien ne résout pas tous les callbacks React ; `UNKNOWN` ne signifie pas absence de risque. Les succès des 4 401 tests KARTA cités plus haut appartiennent à leur tête historique et ne sont pas ajoutés aux 18 cas de ce complément.

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
