# Contrats OpenTimestamps : contrôles locaux

Depuis la racine du dépôt, avec Node.js, Deno 2 et les dépendances npm du projet déjà installées :

```sh
node tests/contracts-ots/run.mjs
```

Le runner séquence les tests des handlers Deno avec contrôle TypeScript, les tests Node, puis le contrôle du véritable import de production dans Deno. Il s’arrête au premier échec. Il n’installe rien et ne lance aucun audit npm.

Les tests des handlers Deno importent les trois handlers réels, avec ports Supabase, DocuSeal et primitives de preuve simulés. Les permissions réseau Deno ne sont pas accordées, les imports distants et npm sont interdits pour ces tests sur ports. Les tests Node chargent les **vrais modules de preuve OpenTimestamps 0.4.9 installés** ; `fetch` est remplacé par un port inerte, les transports HTTP/HTTPS historiques lèvent une erreur s’ils sont invoqués.

`runtime-deno.test.ts` importe directement le pont de production `_shared/ots-library.ts`, sans le mapping des fixtures. Il vérifie la même preuve amont avec les vrais imports npm dans Deno, puis rejette une racine Merkle erronée et un hash de document modifié. Il utilise exclusivement l’installation locale (`--node-modules-dir=manual`), les dépendances déjà disponibles (`--cached-only`), aucun import distant (`--no-remote`) et aucun réseau (`--deny-net`). `fetch` est remplacé par les deux réponses historiques figées. Une dépendance manquante fait échouer la porte ; le runner ne la télécharge pas.

La preuve `examples/hello-world.txt.ots` et le document proviennent des exemples amont du paquet 0.4.9. Leurs SHA-256 sont conservés dans `upstream-fixtures.json`. Le bloc 358391 a été recoupé avec le README amont et les métadonnées publiques historiques de Blockstream, figées dans le test. Le SHA-256 du JSON historique consulté est `d144579b3d9ba2a887d9f6e5bfb44bfa14be8a1b9cf686853b57b54c075f24d7`. Aucun test ne lit un explorateur, un calendrier ou une instance Supabase en ligne.

Les sept tests du client exécutent le vrai corps de `AdminContracts.handleVerifyOts`, obtenu par l’AST TypeScript, avec sessions, réseau, état et notifications inertes. Ils vérifient les erreurs HTTP, succès, attente explicite et réponses devenues obsolètes. **Ils ne sont pas des tests navigateur.** Le hook `useRequestScope` est repris, octet pour octet, du lot d’isolation des comptes. Le parcours monté `ProtectedRoute → AdminContracts` doit être vérifié dans le navigateur d’assemblage.

## Décisions et limites

- Le stamping exige le secret de service exact ou une identité obtenue via `auth.getUser` avec un rôle administrateur lu dans `purama_ai.user_roles`. Une clé anon n’est pas une identité utilisateur. Les plateformes peuvent rejeter un JWT invalide avant le handler ; la reproduction locale ne démontre pas une admission anonyme dans une plateforme déployée.
- L’utilisateur ordinaire consulte uniquement le contrat visible par son client RLS. Les relectures après attente et les conditions sur le snapshot empêchent la réutilisation d’un contrat dont le propriétaire ou la preuve a changé. La lecture d’autorité et l’écriture privilégiée ne sont pas une transaction de révocation atomique.
- Le webhook exige son secret avant de lire le corps, borne le JSON à 64 Kio puis valide l’enveloppe et les identifiants entiers strictement positifs avant de créer le client privilégié. Le lecteur commun conserve 4 Kio par défaut pour le stamping, limite l’attente totale du corps à 10 s et respecte l’abandon de la requête. Il nettoie son délai et son écouteur, libère le verrou du flux et n’attend pas une annulation qui pourrait rester bloquée ; un rejet de cette annulation est absorbé. Le webhook ne journalise pas le contenu brut du payload. Un ensemble vide de signataires ne vaut pas signature totale. `verify_jwt=false` concerne uniquement ce webhook à secret dédié ; les deux routes OTS conservent `verify_jwt=true` et leurs propres contrôles. Le cycle métier complet du webhook, sa déduplication, ses effets concurrents et son déclenchement asynchrone ne sont pas qualifiés comme idempotents par ce correctif d’admission.
- Les modules `request`, `Calendar`, `Esplora` et l’entrée principale OTS ne sont plus chargés par les chemins modifiés. Les dépendances et le lockfile ne sont pas modifiés ; les avis de sécurité du paquet ne sont pas déclarés corrigés par cette adaptation.
- La cryptographie du wrapper `src/lib/opentimestamps.ts` n’est pas qualifiée dans un navigateur. La compilation du site ne démontre pas l’exécution des primitives Node `crypto`/`Buffer` par Vite. Aucun polyfill ni nouvelle dépendance n’est ajouté ; les exports sans consommateur produit doivent être qualifiés avant un nouvel usage navigateur.
- Le transport reprend les bornes et la politique d’origines de SUTRA au commit `9f876cbcc5fe667209a369a8ee64c109ab043173`, en utilisant les parsers, opérations et vérificateurs d’attestation amont. Il n’effectue pas de cryptographie artisanale. Chaque appel dure au plus 10 s, les réponses de calendrier sont bornées à 10 ko, celles du bloc à 64 ko, la preuve à 64 ko, et les requêtes de vérification à 12. La panne d’un calendrier n’empêche pas l’essai des suivants dans ce budget. Un simple hash ou une attestation inconnue n’est pas présenté comme une confirmation en attente.
- Les origines OTS sont des autorités HTTPS admises ; les redirections, identifiants et cookies sont refusés. Cette variante Deno/navigateur **ne fixe pas la résolution DNS à une IP publique**, contrairement au transport Node de SUTRA. Elle ne neutralise donc pas toutes les formes de DNS rebinding ; un filtre egress de la plateforme reste un prérequis de production.
- Les PDF sont téléchargés uniquement depuis l’origine DocuSeal configurée, sans redirection ni comparaison de préfixe. Les réponses sont limitées à 20 Mo et 15 s ; l’identifiant de soumission est contrôlé lorsqu’il est fourni, et une liste de documents ambiguë est refusée. Un stockage externe exige une politique d’origine explicitement examinée ; aucun hôte arbitraire renvoyé par l’API n’est admis.
- Le calendrier, la persistance et l’événement d’audit ne forment pas une transaction unique. Les échecs d’écriture sont retournés comme des erreurs, mais un échec d’événement après une écriture peut laisser une preuve persistée. Il faut qualifier ce chemin et les rôles/RLS natifs avant production.
- Ni migration, déploiement, fournisseur réel, réception réelle DocuSeal, confirmation Bitcoin en ligne, ni métadonnées privées envoyées à npm ne sont qualifiés par cette suite.

## Références

- https://supabase.com/docs/reference/javascript/auth-getuser
- https://supabase.com/docs/guides/functions/auth-headers
- https://www.docuseal.com/docs/api
- https://github.com/opentimestamps/javascript-opentimestamps
- https://blockstream.info/api/block/000000000000000003e892881a8cdcdc117c06d444057c98b6f04a9ee75a2319
- https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
