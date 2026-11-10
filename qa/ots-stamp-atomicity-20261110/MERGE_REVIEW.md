# Diagnostic de rapprochement PR33 / PR36 — lecture seule

Références comparées : PR33 `a11b2d8298c5cd7f8ed8be3427a1c6b676310e3f`, PR36 `cb5accbeac30bf43872c0a7a19233a619faed4ca`, ancêtre commun `58a85a9f7ae0c20abc37158ea0901243e0bf2acd`. La commande `git merge-tree --write-tree --messages a11b2d8298c5cd7f8ed8be3427a1c6b676310e3f cb5accbeac30bf43872c0a7a19233a619faed4ca` retourne 1 et produit l'arbre virtuel `40e1b64cf99c66b432b630e742356fd8ad450c67`. Aucun index ou fichier de travail n'a été fusionné. Cet arbre contient des marqueurs de conflit et ne constitue pas un candidat exécutable.

Le journal et les hunks complets sont conservés dans `merge-tree.txt` et `merge-conflicts.json`. Onze fichiers sont en conflit. Six concernent l'interface et la configuration : `package.json`, `playwright.config.ts`, `ExecutionCounter.tsx`, `SpiritualLayer.tsx`, `AgentChatTab.tsx` et `CreatorAgentDetail.tsx`. Une réservation frontend active et une réservation spécifique aux deux fichiers de configuration ont été constatées dans la coordination accessible. Aucune résolution ni publication globale n'est entreprise ici ; la revue de ces six fichiers appartient à un lot distinct.

## Cinq conflits OTS et harnais

| Fichier | Analyse et garanties à conserver |
|---|---|
| `src/lib/opentimestamps.ts` | PR33 utilise l'entrée générale OpenTimestamps et contrôle la présence d'attestations. PR36 compose les modules cryptographiques amont avec `ots-core`, qui borne les preuves et le transport. Conserver les API `hashContent`, `stampHash`, `verifyProof` et l'alias `HashableContent`, la copie des octets avant tout await, le refus des calendriers tous défaillants et le transport contrôlé PR36. Ne pas remettre l'ancienne pile HTTP implicite en choisissant tout le fichier PR33. |
| `supabase/functions/contracts-ots-stamp/index.ts` | Conflit entre le handler monolithique PR33 et les helpers PR36. Conserver `authorizeOts`, les relectures après PDF et avant écriture, le client humain soumis à RLS, `signedPdf`, l'instantané complet et le stamp cryptographique borné. Le présent lot atomique s'applique au handler PR36 séparément et garde ces protections. |
| `supabase/functions/contracts-webhook/index.ts` | Les hunks conflictuels portent sur l'enveloppe, les identifiants positifs sûrs, les commentaires et le log. L'arbre virtuel conserve déjà l'admission HMAC et la livraison attendue de PR33. Toute résolution doit conserver ces blocs, la validation avant client privilégié et la suppression de détails privés des logs. |
| `tests/contracts-ots-auth.mjs` | Les harnais diffèrent sur le lookup `public.has_role`, le modèle de requête, les attestations et l'enregistrement `Deno.serve`. Conserver les cas d'autorité et le cloisonnement des transports ; adapter les assertions aux trois relectures et au RPC atomique. Un remplacement global d'un harnais peut perdre des cas ajoutés sur l'autre branche. |
| `tests/contracts-ots-authorization.test.mjs` | Le conflit textuel des globals VM est limité, mais l'ensemble combine un SDK réel et des adaptateurs différents. Il faut conserver Array/ArrayBuffer, les contrôleurs et timers, les tests de contenu binaire, les erreurs de provider, les gardes d'instantané et la nouvelle vérification du RPC humain. La validité de la réunion n'est pas déduite de la simple résolution du hunk. |

## Morceaux déjà rapprochés automatiquement

L'arbre PR36 seul ne contient pas `_shared/ots-delivery.ts`, mais l'arbre virtuel de fusion le conserve exactement depuis PR33, avec le blob `caa79293b60f133e2117ae356d0f48277bcf7f60`, ainsi que son test. Le webhook virtuel conserve l'appel `await deliverOtsStamp(..., { signal: req.signal })`, le contrôle `hasHmacSignatureFormat` avant lecture du corps et le garde d'état du contrat. Le helper conserve son délai de 15 secondes, sa propagation d'annulation, son refus des redirections, le rejet des réponses non réussies et la fermeture des corps tardifs. Choisir le fichier PR36 entier réintroduirait son fire-and-forget conditionné à une URL de métadonnées.

Le helper HMAC fusionné conserve aussi `decodeHmacSignature` et `hasHmacSignatureFormat`. Les anciens tests `contracts-ots-integrity.mjs` et `opentimestamps-content.mjs` existent dans l'arbre virtuel ; leur compatibilité avec le nouvel adaptateur devra être exécutée, pas présumée.

## Périmètres séparés et réservation

Aucun conflit KARTA/CHEF n'apparaît dans ces deux arbres. PR33 n'a aucun delta KARTA depuis l'ancêtre commun ; PR36 en a dix, dont le scheduler PR34 et ses tests. La migration 026 en qualification concurrente n'appartient pas à cette comparaison. Le workflow CHEF se rapproche automatiquement mais sa combinaison de commandes reste à vérifier lors d'une future réconciliation.

La lecture ciblée de la coordination ne constitue pas une cession de périmètre. Les mentions OTS explicites trouvées dans le registre concernaient SUTRA, autre dépôt ; un chantier IAO de rétention concerne `iaoFacade.ts` et son test, et le chantier commerce consulté était clôturé. Les réservations frontend/config actives empêchent de traiter les onze conflits comme un lot disponible. Aucun registre, claim ou fichier de suivi n'a été modifié.

**Statut : diagnostic disponible ; résolution globale NON EFFECTUÉE.** Le correctif transactionnel garde son parent PR36 exact et reste identifiable indépendamment de ce rapprochement.
