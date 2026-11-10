# Contrats PURAMA : autorisation et cohérence OpenTimestamps

## Résultat et portée

Les contrôles locaux du correctif sont **PASS**. La qualification de production
reste **PARTIELLE** pour les raisons décrites plus bas. Aucun fournisseur réel,
paiement, déploiement, migration distante ou confirmation Bitcoin n'a été exécuté.

Le travail a commencé sur PR #27, commit
`8755a39a3c4a23b64f5b8f0b2909c82d11e732ad`. Pendant l'audit, une autre conversation
a intégré la compatibilité OpenTimestamps de PR #24 dans PR #27, au commit
`5f8d23d46b1aaa103eccb944406eb3e189388c1c`. Le présent lot a été dédupliqué sur ce
nouveau parent. Les quatre blobs repris de PR #24 sont identiques et l'arbre de code
testé avant/après le changement de parent est strictement le même :
`00833bbd9ccffe2493fd3ee9672ef6be970777c0`.
Les détails figurent dans [la preuve de déduplication](evidence/rebase-dedup.json).

La branche cible de la proposition est `fix/agents-budget-outreach-20261110`,
pas `main`. Le changement de workflow ajoute uniquement l'exécution de
`test:contracts-security` à la suite de contrôles déjà présente dans le parent.

## Défauts reproduits

1. Le handler `contracts-ots-stamp` acceptait n'importe quel en-tête commençant
   par `Bearer ` avant d'utiliser le client privilégié. Un jeton invalide et un
   utilisateur ordinaire avec métadonnées de rôle falsifiées recevaient chacun
   HTTP 200 : une lecture privilégiée, deux écritures, une demande DocuSeal, un
   téléchargement PDF et une demande d'horodatage simulés. Les réponses attendues
   étaient respectivement 401 et 403, sans ces effets. Le script
   [reproduce-before.mjs](reproduce-before.mjs) charge le véritable fichier du
   commit d'origine avec `git show` ; ses deux échecs sont intentionnels.
2. La véritable bibliothèque OpenTimestamps 0.4.9 absorbe l'échec de tous ses
   calendriers. Le handler répondait encore HTTP 200 et écrivait une preuve sans
   aucune attestation. Le test avant correction est conservé dans
   [contracts-softfail-before.log](evidence/contracts-softfail-before.log).
3. Le wrapper de contrat hachait la représentation Base64 du PDF binaire. Son
   hash et sa preuve étaient cohérents entre eux, mais différents des octets PDF
   bruts utilisés par l'Edge handler. Une preuve brute valide n'était donc pas
   reconnue par le wrapper. Les tests ont aussi vérifié la conservation des vues
   binaires et des anciens formats.
4. Pendant la revue, trois régressions de mutation d'`ArrayBuffer` ont été
   explicitement reproduites puis corrigées : hash/proof entre deux attentes,
   import asynchrone de `crypto` côté Node et tentative de vérification du format
   historique. Elles sont conservées dans
   [opentimestamps-arraybuffer-before.log](evidence/opentimestamps-arraybuffer-before.log).

Les traces « before » concernent des étapes différentes et ne constituent pas
une seule suite exécutée sur le même état intermédiaire. Les preuves finales
sont celles de la suite 73 et des commandes `iao-candidate-*`.

## Comportement obtenu

L'horodatage nécessite maintenant soit le credential interne exact, soit un
utilisateur vérifié par `auth.getUser` avec un rôle `admin` lu dans la table
serveur `user_roles`. Les métadonnées client et l'identité fournie dans le corps
ne donnent aucun droit. L'autorisation précède toute lecture du contrat et tout
appel fournisseur. Le format de l'identifiant, l'état signé et la configuration
requise sont contrôlés.

La récupération du PDF n'envoie le jeton DocuSeal qu'à l'origine exacte
configurée. Les redirections sont refusées, ainsi que les URL avec credentials
ou HTTP hors de l'origine DocuSeal. La persistance exige que le contrat soit
toujours signé et conserve la même soumission. Une nouvelle preuve efface les
anciennes valeurs de confirmation Bitcoin ; l'événement indique l'acteur
vérifié. Une erreur d'audit n'est plus annoncée comme un succès.

Le garde du webhook et son helper sont repris de `codex/security-integration`
(`ca155cdc412d65b78146c3cccc8b44f62e0db5b5`). Le secret est exigé, sauf dans les
environnements de développement explicitement prévus par ce correctif existant.
Les transports Bearer et HMAC sont testés, y compris l'enchaînement entre le
véritable handler webhook et le véritable handler d'horodatage.

Les deux chemins d'émission exigent au moins une attestation de calendrier.
`hashContent`, `stampHash` et `verifyProof` partagent l'entrée texte UTF-8 ou
octets bruts. Les buffers sont copiés avant les opérations asynchrones, pour
`Uint8Array` comme pour `ArrayBuffer`. Les nouvelles preuves de contrat utilisent
les octets du PDF ; les preuves historiques du texte Base64 restent vérifiables.
Un document altéré est refusé dans les deux formats.

## Vérifications exécutées

| Contrôle | Résultat | Preuve |
|---|---|---|
| Handlers, helpers et bibliothèques de contrats | PASS 73/73, exit 0 | [contracts-security-final-73.log](evidence/contracts-security-final-73.log) |
| Compatibilité réelle des dépendances PR #24 | PASS 5/5, exit 0 | [dependency-compat-after.log](evidence/dependency-compat-after.log) |
| Suite KARTA complète, un worker, heap 512 Mo | PASS 930/930, 64 fichiers, exit 0 | [karta-global-after.log](evidence/karta-global-after.log) |
| Découverte Playwright sans exécution navigateur | PASS : 198 tests dans 9 fichiers, sans importer les tests Node | [playwright-discovery-final.log](evidence/playwright-discovery-final.log) |
| Types frontend, heap 768 Mo | PASS, exit 0 | [iao-candidate-typecheck.log](evidence/iao-candidate-typecheck.log) |
| Build frontend, heap 768 Mo | PASS, exit 0 | [iao-candidate-build.log](evidence/iao-candidate-build.log) |
| Contrats de schéma générés | PASS, exit 0 | [database-contracts-final.log](evidence/database-contracts-final.log) |
| Types/build KARTA sur le code KARTA inchangé | PASS, exit 0 | [typecheck](evidence/karta-baseline-typecheck.log), [build](evidence/karta-baseline-build.log) |
| Audit des dépendances de production | PARTIEL :3 low, exit 1 | [iao-audit-production.json](evidence/iao-audit-production.json) |

Les deux fichiers du harnais Node sont explicitement exclus de la collecte Playwright : la découverte initiale les importait hors de leur runtime et affichait des échecs malgré un exit 0. La découverte finale est propre ; les 198 tests navigateur n’ont pas été exécutés dans ce lot.

Les 73 tests incluent58 contrôles handlers/helpers et15 contrôles de bibliothèque.
Ils exécutent les véritables sources TypeScript dans un environnement Node
isolé. Les accès Supabase, DocuSeal et calendriers sont simulés ; la bibliothèque
OpenTimestamps réelle construit, sérialise, désérialise et compare les digests.
La vérification d'un bloc Bitcoin n'est pas effectuée.

L'installation de départ puis l'installation avec la compatibilité PR #24 ont
réussi. Une tentative de typecheck à 512 Mo a atteint la limite du heap V8
(exit 134) ; elle n'est pas comptée comme succès. Le passage à 768 Mo a permis de
terminer. La première tentative KARTA interrompue pendant la pression mémoire
n'est pas comptée non plus ; la suite 930 a ensuite terminé avec les limites
ci-dessus. Ces incidents ne sont pas masqués par les résultats finaux.

## Audit des dépendances

L'audit de production ne signale aucune alerte critique, haute ou modérée. Les
trois entrées faibles correspondent au même avis transitif :
`elliptic` → `bitcore-lib` → `opentimestamps`.
[GHSA-848j-6mx2-7j84 / CVE-2025-14505](https://github.com/advisories/GHSA-848j-6mx2-7j84)
concerne la génération de signatures ECDSA dans `elliptic<=6.6.1` et n'annonce
aucune version corrigée. Le chemin d'horodatage contrôlé calcule un SHA-256 et
soumet un engagement aux calendriers ; l'exploitabilité de cet avis dans le
produit n'a pas été démontrée. Cela ne supprime pas l'alerte de la dépendance
installée. La proposition automatique de npm vers `opentimestamps 0.0.0` n'a pas
été appliquée. Aucun upgrade majeur n'a été effectué.

## Analyse d'impact et limites de qualification

Les analyses GitNexus préalables sont conservées avec les preuves. Les fonctions
de bibliothèque présentent un impact LOW sur les appelants résolus. Les handlers
HTTP présentent un impact UNKNOWN : le graphe n'infère pas leurs liens HTTP.
La recherche des appelants a donc aussi contrôlé le déclenchement depuis le
webhook. Les restrictions d'accès sont une frontière de sécurité critique,
indépendamment du faible nombre d'arêtes du graphe.

L’indexation finale isolée a réussi en 47,2 s (9 892 nœuds, 23 278 arêtes, 531 flux). `detect-changes` sur le lot staged indique LOW, 25 fichiers reconnus et 140 symboles ; la comparaison cumulative à `main` indique CRITICAL, 422 fichiers, 2 750 symboles et 377 processus. Le CLI limite la liste affichée à 15 symboles, tout en annonçant des cardinalités complètes. Les sorties [staged](evidence/gitnexus-contracts-staged.log) et [main](evidence/gitnexus-contracts-main-before-commit.log) sont conservées ; ces limites ne sont pas traitées comme une preuve d’absence d’impact. Le différentiel cumulé contre `main` comprend le travail antérieur de
nombreuses branches ; ce lot ne qualifie pas sa fusion globale. Les verrous
d'index rencontrés ont été conservés et seules nos commandes ont été arrêtées.

Les limites suivantes restent ouvertes :

- **NON TESTÉ** : runtime Deno et résolution de ses dépendances, passerelle JWT,
  configuration/roles/RLS Supabase réellement déployés, parcours navigateur
  complet, DocuSeal réel et confirmation Bitcoin. Le typecheck frontend porte
  sur `src` ; il ne remplace pas une vérification Deno des Edge Functions.
- **BLOQUÉ pour une garantie de traitement durable** : le webhook existant
  déclenche l'horodatage en `fire-and-forget`. Une file durable, les retries et
  l'idempotence ne sont pas qualifiés par ce lot.
- **PARTIEL** : l'écriture de la preuve et l'événement d'audit sont deux
  opérations. Si la seconde échoue, le handler renvoie une erreur mais la preuve
  peut déjà être enregistrée ; l'atomicité n'est pas garantie.
- **PARTIEL** : l'avis transitif `elliptic` reste présent. La CI distante et les
  éventuelles intégrations de preview doivent être constatées sur le commit
  publié. Le seul workflow versionné fait des contrôles, sans déploiement.

Références d'autorisation : documentation officielle
[Supabase auth.getUser](https://supabase.com/docs/reference/javascript/auth-getuser)
et [authentification des Edge Functions](https://supabase.com/docs/guides/functions/auth).
