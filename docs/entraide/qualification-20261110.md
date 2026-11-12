# Entraide — qualification du 10 novembre 2026

## Résultat et périmètre

**PASS sur les scénarios exécutés ; PARTIEL pour la qualification du produit complet.**
La branche `fix/entraide-missions-20261110`, issue de
`d116dc8a6429ea76c67167a195eb3f723f2251fb`, corrige les missions collectives de
l'application Entraide existante. Elle améliore aussi les contrats HTTP du profil,
des contacts et de la mise en relation, sans créer une autre application.
La [PR #17](https://github.com/puramapro-oss/purama-ai/pull/17) conserve ces travaux
en brouillon. Aucune migration ni fonction n'a été déployée en production.

**71 tests automatisés ont réussi : 23 PostgreSQL, 36 HTTP et 12 interface.** Un
contrôle supplémentaire du parcours sur une largeur de 375 pixels a aussi réussi.
Ces ensembles vérifient des couches différentes. Les tests d'interface simulent
le backend ; les tests PostgreSQL exécutent les vraies migrations et les RPC avec
une identité de test. Ils ne constituent pas un essai intégré de Supabase hébergé.

## Changements et effets observables

### Missions cohérentes même en cas de concurrence ou de reprise

- Création, inscription initiale de l'organisateur et réservation de la clé de
  requête appartiennent à la même transaction PostgreSQL. Une erreur tardive
  annule l'ensemble.
- L'identité vient de `auth.uid()`. Les commandes réservées à l'organisateur
  vérifient `organizer_id`, même après son départ de la liste des participants.
- Chaque mutation verrouille la mission avant de lire les effectifs et de
  modifier son état. Deux personnes demandant la dernière place produisent une
  seule inscription acceptée. Les autres participants et leurs dates sont conservés.
- Une version attendue protège démarrage, clôture et annulation contre une
  décision fondée sur un ancien écran. Les états terminaux ne sont pas réouverts.
- Un registre privé associe chaque intention à son acteur et à un UUID. Rejouer
  la même intention renvoie son résultat enregistré ; changer son contenu avec
  la même clé est refusé. Les droits directs d'écriture restent fermés.
- Quitter une mission en cours demeure possible. L'interface propose les actions
  correspondant aux rôles, à la capacité et à l'état reçu du serveur.

### Interface et traitement des interruptions

L'écran bloque immédiatement un double clic sur la même intention, tout en
laissant les autres missions utilisables. Après une interruption ou un résultat
incertain, la reprise volontaire conserve l'UUID et le contenu initiaux. Un
conflit recharge les données sans relancer automatiquement une décision.
Après une réponse rejouée, un GET récupère l'état actuel au lieu d'afficher un
ancien instantané comme s'il était à jour.

La personne peut abandonner la reprise. Le texte précise que cela n'annule pas
une demande déjà reçue par le serveur. L'intention en attente est conservée
uniquement pendant la vie de la page : la persistance après rechargement n'est
pas fournie par ce changement.

### Profil, contacts et dépendances existantes

Une RPC sans paramètre d'identité rend au seul appelant son profil complet, y
compris ses propres coordonnées précises. Les politiques publiques et les droits
directs sur les colonnes de coordonnées restent inchangés.

Les trois fonctions annexes contrôlent les méthodes, les chemins, le corps, les
erreurs et le quota HTTP par le même adaptateur Entraide. Les erreurs internes
ne sont pas exposées au client. Les mises en relation filtrent les blocages dans
les deux sens et ne renvoient pas les coordonnées précises. La réponse à un
contact vérifie le destinataire et l'état `pending` avant sa modification.

La dépendance distante privée introuvable a été remplacée par la résolution du
paquet privé canonique `@purama/entraide` 0.1.0, déjà attendu par `package.json`.
Le paquet reste à l'emplacement frère `../packages/purama-entraide` ; son code
n'est pas recopié dans ce dépôt public. Les configurations Deno par fonction
résolvent ses imports locaux avec les extensions appropriées. Supabase JS et
Zod utilisent les versions déjà verrouillées dans l'application.

L'adaptateur frontend réutilise le même client Supabase et sa session, avec une
extension locale des types conforme aux migrations Entraide. Deux anciennes
fonctions de mutation sans appelant, dont une remplaçait toute la liste des
participants, ont été retirées.

## Registre de vérification

| Porte | Statut | Observation et limite |
| --- | --- | --- |
| PostgreSQL natif | **PASS** | 23/23, zéro échec et zéro scénario ignoré ; PostgreSQL 18.4, Node 26.0.0, environ 6,1 s. |
| Concurrence et annulation de transaction | **PASS** | Connexions indépendantes et attente de verrou observée ; dernière place, arrivée/départ, clés identiques ou contradictoires, clôture/annulation et erreurs tardives. |
| Contrats HTTP | **PASS** | 22 tests du gestionnaire de missions + 14 tests du helper = 36/36 ; Deno 2.9.6. Backend simulé pour cette couche. |
| Interface construite | **PASS** | 12/12, Firefox 1511 / 148.0.2, Playwright 1.59.1, un worker, zéro retry ; 82,7 s. Toutes les requêtes backend sont interceptées. |
| Largeur 375 × 812 | **PASS** | Un parcours complémentaire vérifie boutons, reprise, abandon et absence de débordement horizontal ; 16,6 s. Ce n'est pas une couverture de tous les appareils. |
| Build frontend | **PASS** | Vite 5.4.21, sortie 0, 20,72 s, URL Supabase et clé synthétiques. |
| Types des fonctions serveur | **PASS** | Les quatre points d'entrée Entraide passent `deno check` ; les trois graphes annexes résolvent leurs dépendances locales. |
| Types frontend Entraide | **PASS** | 37 diagnostics au point de départ, aucun après correction ; même TypeScript 5.8.3 et même commande. |
| Types du dépôt complet | **PARTIEL** | 103 diagnostics hors Entraide restent présents, identiques à ceux du point de départ ; `tsc` global sort avec le code 2. Un build Vite réussi n'efface pas ces erreurs. |
| GitHub Actions | **BLOQUÉ** | Le run initial 42740684878 s'est terminé sans étapes ni journal de job exploitables. Aucune réussite CI n'est revendiquée ; la cause n'a pas été établie par les réponses disponibles. |
| Supabase hébergé, ONE ID, déploiement | **NON TESTÉ** | Pas de validation de bout en bout avec le fournisseur d'identité, PostgREST, les fonctions déployées ou des comptes réels. |
| Effet humain et déploiement mondial | **NON TESTÉ** | Aucun pilote utilisateur lancé ; les tests logiciels ne démontrent pas une amélioration universelle des relations humaines. |

Les empreintes des sources testées figurent dans les preuves JSON. Les serveurs
PostgreSQL et Vite créés pour ces essais ont été arrêtés. Aucune identité réelle,
clé de production, donnée utilisateur ni interaction avec un compte externe
n'était nécessaire.

L'analyse GitNexus avant commit a signalé **HIGH**, notamment des liens vers six
flux hors Entraide attribués à la propriété de type locale `Table.Row`. La revue
des imports et des appels ne confirme pas ces liens : ce type n'est ni exporté
ni global, et le seul importeur du nouveau client est l'adaptateur Entraide.
Les fichiers KARTA et de publication sociale concernés restent inchangés.
L'[alerte brute](evidence/gitnexus-before-commit-20261110.txt) et son
[triage documenté](evidence/gitnexus-triage-20261110.json) sont conservés. Cette
analyse statique bornée ne fournit aucune garantie globale d'absence de régression.

## Preuves

- [Tests PostgreSQL](evidence/postgres-tests-20261110.txt) et
  [environnement / empreintes](evidence/postgres-result-20261110.json).
- [36 tests HTTP](evidence/http-tests-20261110.txt).
- [Commandes et sorties des quatre contrôles Deno](evidence/deno-checks-20261110.json).
- [12 tests UI](evidence/ui-tests-20261110.txt),
  [contrôle mobile](evidence/ui-responsive-20261110.txt) et
  [résultats structurés](evidence/ui-result-20261110.json).
- [Fin du journal de build](evidence/ui-build-tail-20261110.txt).
- [Comparaison TypeScript](evidence/typescript-comparison-20261110.json),
  [diagnostics initiaux](evidence/typescript-baseline-20261110.txt) et
  [diagnostics restants](evidence/typescript-candidate-20261110.txt).
- [Empreintes des sources de cette livraison](evidence/source-manifest-20261110.json).

## Reproduction

Les tests PostgreSQL sont décrits dans [leur README](../../tests/entraide/README.md).
Le workflow versionné vise Node 22.23.4 et PostgreSQL 15. L'exécution native
obtenue ici utilise PostgreSQL 18.4 ; la matrice PostgreSQL 15 / CI reste à exécuter.

Depuis la racine, avec Deno 2.9.6 :

```sh
deno test supabase/functions/entraide-missions/handler.test.ts supabase/functions/_shared/entraide-http.test.ts
deno check --node-modules-dir=manual --no-lock supabase/functions/entraide-missions/index.ts
deno check --node-modules-dir=manual --no-lock --config supabase/functions/entraide-profil/deno.json supabase/functions/entraide-profil/index.ts
deno check --node-modules-dir=manual --no-lock --config supabase/functions/entraide-contact/deno.json supabase/functions/entraide-contact/index.ts
deno check --node-modules-dir=manual --no-lock --config supabase/functions/entraide-matches/deno.json supabase/functions/entraide-matches/index.ts
node --max-old-space-size=3072 node_modules/typescript/bin/tsc --noEmit -p tsconfig.app.json --pretty false
```

Les commandes qui importent le paquet privé nécessitent son checkout canonique
autorisé dans le répertoire frère. Aucun substitut public ni faux paquet n'est
fourni. Le dernier contrôle TypeScript doit actuellement retrouver les 103
diagnostics hors périmètre indiqués ci-dessus.

Pour reproduire l'interface, installer le lockfile de l'application et Firefox
correspondant à sa version Playwright, dans un cache de test dédié. Construire
avec `VITE_SUPABASE_URL=http://supabase.example.invalid` et
`VITE_SUPABASE_PUBLISHABLE_KEY=test-only-anon-key`. La
[configuration exacte de la suite](evidence/ui-playwright-config-20261110.txt)
est conservée sous forme documentaire : remplacer `<candidate>` par le dossier
isolé choisi et le chemin de Node par celui de l'environnement, puis l'enregistrer
en `.mjs`. Choisir un port loopback libre de façon cohérente dans `baseURL` et
`webServer`. Le serveur de prévisualisation utilise `--strictPort` et
`reuseExistingServer: false`. Exécuter `playwright test --config` avec ce fichier.
Le backend de test intercepte toutes les requêtes non frontend ; aucun compte
réel n'est utilisé. Le
[contrôle mobile ponctuel](evidence/ui-mobile-spec-20261110.txt) et sa
[configuration](evidence/ui-mobile-config-20261110.txt) sont également conservés.

## Limites et prochaines responsabilités

1. **Propriétaire Entraide / base de données :** le quota quotidien de contacts
   fait encore une lecture puis une insertion séparées. Il n'est pas atomique
   entre plusieurs instances. Le blocage et la mise à jour du statut du contact
   sont aussi deux écritures ; le blocage protecteur est appliqué en premier.
   Ces parcours nécessitent une transaction dédiée avant toute garantie forte
   de concurrence. Un blocage concurrent peut également intervenir entre sa
   vérification et l'envoi ou l'acceptation d'un contact. La comparaison de
   l'état `pending` protège les réponses concurrentes, sans supprimer cette
   autre course. Le throttling HTTP actuel reste en mémoire par instance.
2. **Propriétaire Entraide :** qualifier l'expiration des contacts, les gros
   volumes et la pagination complète. Un ancien helper exporté mais sans
   appelant, `getContactRequestsSentToday`, garde une borne de fin de journée
   imprécise et un repli à zéro ; le handler actif utilise déjà le jour suivant
   à minuit et refuse un comptage inconnu. Ce helper ne doit pas être réintroduit
   dans un contrôle d'admission sans correction.
3. **Propriétaires identité et exploitation :** exécuter la matrice PostgreSQL
   15 prévue, puis l'essai intégré Supabase/ONE ID dans un environnement dédié.
   Vérifier que le paquet privé frère est inclus par le véritable processus de
   bundle. La résolution Deno locale ne prouve pas à elle seule ce déploiement.
4. **Propriétaire Together T20 :** conserver son travail actif. L'audit en lecture
   seule distingue ses missions à un exécutant et revue de preuve du modèle
   collectif à quorum corrigé ici. Le portage exige une correspondance explicite
   des contrats et de l'identité. L'absence observée de registre durable de
   requêtes dans les fichiers audités est une piste à traiter avec le propriétaire,
   pas un défaut reproduit ni une raison de remplacer son code.
5. **Responsables produit et participants volontaires :** reprendre les critères
   AM/AME déjà définis dans le canon, relier leur réception aux preuves réelles,
   puis réaliser un pilote borné. L'aide souhaitée, la liberté de refuser ou de
   partir, la confidentialité et la capacité réelle restent les critères d'usage.

Les 50 scénarios de conception AM/AME ne sont pas tous couverts par les 71 tests
de cette branche. Les essais historiques de Together ne sont pas ajoutés au
compteur de cette livraison. Aucun paiement, automatisme de sollicitation,
nouveau score de valeur humaine ou engagement financier n'est introduit.
