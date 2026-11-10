# Portée des avis de dépendances — 10 novembre 2026

Analyse en lecture seule. Les chemins ci-dessous sont relatifs à la racine du dépôt. Aucun package, fichier produit ou déploiement n'a été modifié pour cette analyse.

## Résultat et sources

`npm audit --omit=dev --audit-level=high` passe le seuil demandé, mais le [rapport conservé](app-audit.txt) contient **6 signalements : 2 faibles et 4 modérés**. Ils correspondent à deux avis propagés dans la chaîne issue de la dépendance directe `opentimestamps@0.4.9` :

- `bitcore-lib@8.25.47` → `elliptic@6.6.1` : [avis officiel elliptic](https://github.com/advisories/GHSA-848j-6mx2-7j84), génération ECDSA incorrecte pouvant exposer une clé privée sous certaines conditions.
- `request@2.88.2`, `request-promise@4.2.6` et `request-promise-core@1.1.4` : [avis officiel request](https://github.com/advisories/GHSA-p8p7-x288-28g6), contournement de protections SSRF par redirection entre protocoles.

Versions constatées dans `package-lock.json`. Les deux avis consultés ne donnent pas de version corrigée des packages `elliptic` et `request` concernés. La proposition `npm audit fix --force` rétrograde OpenTimestamps à `0.0.0` avec rupture annoncée ; elle n'a pas été appliquée.

## Usage constaté

**Navigateur.** `src/lib/opentimestamps.ts` importe le package. `src/lib/docuseal/ots-stamper.ts` l'enveloppe, puis `src/lib/docuseal/index.ts` réexporte les fonctions. Aucun consommateur de ces fonctions ou du barrel n'a été trouvé par recherche statique ciblée dans `src`, `supabase`, `tests` et `scripts`. Les pages actuelles appellent des fonctions serveur : `src/pages/AdminContracts.tsx` appelle `contracts-ots-verify`, et `src/pages/Reglement.tsx` appelle `reglement-verify`. L'absence de régression après suppression reste non testée.

**Serveur.** `supabase/functions/contracts-ots-stamp/index.ts` et `supabase/functions/contracts-ots-verify/index.ts` importent explicitement `npm:opentimestamps@0.4.9` pour créer, mettre à jour et vérifier les preuves des contrats. `supabase/functions/contracts-webhook/index.ts` déclenche l'horodatage après signature. Retirer la dépendance du package web ne retire pas ces imports serveur. Les fonctions `reglement-publish` et `reglement-verify` utilisent, elles, Web Crypto et des appels HTTP directs, sans cet import npm.

## Risque résiduel et limites

Aucune signature ECDSA applicative avec clé privée n'a été identifiée dans le chemin OTS examiné ; la pertinence du risque `elliptic` y est donc réduite, sans invalider l'avis.

Le code installé d'OpenTimestamps utilise réellement `request-promise` pour contacter les calendriers. Une liste de domaines filtre les URL d'attestations initiales ; les options HTTP examinées ne désactivent pas explicitement les redirections. Cette restriction réduit la surface, sans démontrer l'inapplicabilité de l'avis SSRF. **Aucun exploit réseau, accès interne ou fuite n'a été testé ni observé.** Le déploiement effectif et l'arbre de dépendances résolu dans l'Edge Runtime n'ont pas été inspectés.

Le retrait des wrappers web inutilisés est une piste de nettoyage à valider séparément par types, build et parcours contrats/règlements. Le remplacement serveur doit préserver le format des preuves, leur mise à jour et la vérification des attestations Bitcoin. Aucun correctif de dépendance n'entre dans ce lot.

## Point distinct non qualifié : autorisation de l'horodatage

Dans `supabase/functions/contracts-ots-stamp/index.ts`, le contrôle applicatif visible exige seulement un en-tête commençant par `Bearer `, puis charge et modifie le contrat avec un client service-role. Aucun contrôle explicite de l'identité, du propriétaire ou du rôle de l'appelant n'apparaît dans cette fonction.

La lecture de `supabase/config.toml` ne trouve aucune entrée propre à `contracts-ots-stamp` ni de réglage `verify_jwt` racine ; le dossier de la fonction ne contient pas de configuration supplémentaire. **Cela ne prouve pas que la passerelle accepte un JWT invalide ou absent.** La configuration distante, les protections de déploiement et l'exploitabilité de ce point restent non qualifiées. Ce constat est séparé des deux avis npm et n'est pas présenté comme un exploit démontré.
