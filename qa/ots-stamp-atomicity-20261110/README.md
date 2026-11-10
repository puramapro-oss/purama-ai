# Enregistrement atomique du stamp OTS — 10 novembre 2026

## Résultat et périmètre

**PASS local** pour le lot fondé exactement sur `cb5accbeac30bf43872c0a7a19233a619faed4ca` (PR36). Le handler `contracts-ots-stamp` enregistre désormais la preuve et son événement `ots_stamped` dans une seule transaction SQL. Une panne d'insertion de l'audit annule la preuve et les modifications de confirmation Bitcoin. Le défaut initial, où la preuve restait enregistrée après l'échec de l'audit indépendant, a été reproduit sur PostgreSQL natif avant application de la nouvelle migration.

Le lot produit ne change que le handler de stamp et ajoute `20261110180000_contract_ots_audit_atomicity.sql`. Il ne fusionne pas les branches PR33/36 et ne modifie aucun fichier UI, scheduler, transport OTS, vérification ou webhook. Les divergences sont documentées dans `MERGE_REVIEW.md`.

## Garanties conservées

La RPC `purama_ai.persist_contract_ots_stamp` est `SECURITY INVOKER`. Le client humain conserve son JWT, ses droits de table et la politique RLS existante. L'UPDATE vérifie les six éléments de l'instantané original : identifiant, propriétaire, état signé, soumission DocuSeal, ancien hash et ancienne preuve. Les valeurs NULL gardent leur sémantique. Une ligne absente, inaccessible ou modifiée renvoie NULL, sans audit, et le handler retourne 409.

Le trigger `contract_ots_stamp_atomic_audit` appelle `purama_ai.audit_atomic_contract_ots_stamp`, une fonction `SECURITY DEFINER` limitée à l'insertion de l'audit. Le hash et la taille proviennent de la ligne réellement écrite ; l'acteur provient de `auth.uid()` et `auth.role()`, sans paramètre d'identité fourni par le client. Les deux fonctions fixent `search_path = ''`. L'exécution directe du trigger est révoquée pour PUBLIC, anon, authenticated et service_role. La RPC est accessible seulement aux rôles authenticated et service_role, sous leurs droits existants.

Le marqueur de configuration `purama_ai.atomic_ots_stamp` est défini par le SET de la RPC. PostgreSQL restaure sa valeur précédente au retour, y compris après une exception interceptée. Ce marqueur sélectionne le chemin de transition ; il ne confère aucun droit. Les anciens handlers ne le posent pas et conservent leur unique insertion d'audit séparée pendant le déploiement.

La validation SQL borne la preuve à 64 000 octets et contrôle son encodage et le hash. La construction et la vérification cryptographiques restent assurées par l'implémentation OTS existante ; les preuves synthétiques du test SQL n'en constituent pas une qualification cryptographique.

## Vérifications effectivement exécutées

| Gate | Résultat | Preuve |
|---|---|---|
| Suite Node contrats, sécurité, contenu, crypto et client | 229 PASS, 0 échec, sortie 0 | `node-atomic.log.gz` |
| Vrais handlers Deno, transports synthétiques | 43 PASS, 0 échec, sortie 0 | `deno-atomic.log.gz` |
| PostgreSQL natif 18.4, cluster privé sans TCP | 29 contrôles PASS, sortie 0 | `native-final.json` |
| TypeScript application | PASS, sortie 0 | `typecheck.log.gz` |
| Check Deno du handler, vrais imports npm en cache | PASS, sortie 0 | `deno-production-check.log.gz` |
| ESLint des cinq fichiers TS/JS modifiés | PASS, sortie 0 | `lint-targeted.log.gz` |
| Build Vite, heap borné à 768 MiB | PASS, sortie 0 | `build-bounded.log.gz` |
| Clôture native indépendante | Cluster, socket et quatre clients absents | `native-independent-closure.json` |

Les 29 contrôles SQL comprennent les acteurs humain/service, les refus propriétaire non administrateur et utilisateur tiers, la révocation d'administration, les six conflits d'instantané, les erreurs d'audit avec rollback, les droits des fonctions, les limites de preuve, la restauration du marqueur après succès/échec/conflit, l'ancien handler, le premier stamp sans preuve et les retentatives de même preuve. Quatre backends simultanés ont été observés avec trois attentes de verrou : un gagnant, trois résultats NULL et un seul audit dont le hash correspond à la preuve stockée.

Les tests SDK utilisent réellement `@supabase/supabase-js` et un transport HTTP fermé : une seule RPC au schéma `purama_ai`, conservation du JWT humain, trois relectures d'identité et d'instantané, absence de requête d'audit séparée, et échec fermé lorsque la RPC manque.

GitNexus a été réindexé puis exécuté sur le diff staged et contre `main` (`d116dc8a6429ea76c67167a195eb3f723f2251fb`). Le petit lot est classé LOW. La comparaison globale héritée est CRITICAL, sur plusieurs centaines de fichiers ; elle n'autorise ni fusion globale ni généralisation de ces tests. Les résultats structurés sont conservés. Le graphe reste partiel : imports dynamiques, plafonds de flux et exclusion du gros reçu JSON. Une absence de flux ne prouve pas l'absence d'appel.

Deux premières tentatives natives ont échoué dans le harnais : parsing multiligne de `json_agg`, puis nom de champ attendu par le collecteur partagé (`backend_pid`). Leurs reçus complets restent dans `native-first-attempt.json.gz` et `native-second-attempt.json.gz`. Le dernier passage réexécute les 29 contrôles ; les contrôles antérieurs ne sont pas additionnés. Chaque cluster a été arrêté et supprimé. Le premier build a été interrompu avec code 137 (`Killed`) ; `build-first-attempt.log.gz` le conserve. La reprise bornée utilise exactement les mêmes sources produit.

## Exécution et provenance

`commands.json` conserve les commandes, sorties et limites ; `source-hashes.json` relie les fichiers du lot aux preuves. Les cinq empreintes du reçu PostgreSQL distant ont été comparées aux fichiers locaux, toutes identiques. Le harnais réutilise le cycle de vie privé et le collecteur de concurrence de `qa/agents-hardening-20261110/integration/native-postgres.py`.

```sh
python3 tests/contracts-ots/native-postgres.py . \
  --pg-bin /opt/homebrew/opt/postgresql@18/bin \
  --output /private/tmp/ots-stamp-result.json
```

Il faut un utilisateur système non root. Le harnais crée son propre répertoire `mkdtemp`, n'hérite pas des variables PG, contrôle le répertoire et l'identité du serveur, utilise un socket Unix privé et arrête seulement son `pg_ctl -D` exact. Sur un autre POSIX, `--private-parent /tmp` est disponible.

Le générateur `check:database-contracts` a été inspecté : il ne charge que `p3_schema.sql` et la migration `20260422180000_v4_1_stripe_connect_opentimestamps.sql`, puis génère les tables. Il ne couvre ni cette migration ni les RPC. Il n'a pas été relancé ni régénéré pour ce lot ; le contrat de la nouvelle RPC est vérifié par les tests SQL natifs et SDK.

## Ordre de livraison et limites

Appliquer la nouvelle migration avant de déployer le handler. La migration seule laisse les anciens handlers fonctionner sans audit en double, mais leur écriture demeure séparée. Le nouveau handler sans migration renvoie une erreur 500 et ne tente aucun repli vers deux écritures. Un retour à l'ancien handler peut laisser la migration en place. Aucune migration ni aucun endpoint réel n'a été déployé pendant cette qualification.

**PARTIEL** : `contracts-ots-verify` et les écritures métier du webhook conservent leurs transactions séparées. Les retentatives réussies peuvent encore créer une nouvelle preuve et un nouvel événement ; ce lot ne promet pas de livraison exactement une fois et ne rend pas l'appel au calendrier externe transactionnel.

**NON TESTÉ** : schéma Supabase de production, JWT réels, fournisseurs réels, CI hébergée et parcours navigateur de ce delta. Les assertions RLS SQL utilisent de petites fonctions Auth de fixture, identifiées dans le harnais. Aucun compteur historique de PR36 n'est repris comme une nouvelle exécution.

Sources primaires consultées : [SET de CREATE FUNCTION](https://www.postgresql.org/docs/18/sql-createfunction.html), [transaction des triggers](https://www.postgresql.org/docs/18/trigger-definition.html), [sécurité des fonctions Supabase](https://supabase.com/docs/guides/database/functions).
