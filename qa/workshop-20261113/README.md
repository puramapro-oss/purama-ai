# Atelier IAO — réception du 13 novembre 2026

Statut produit global : **PARTIEL**. Ce lot livre les sources ZIP et l’aperçu HTML d’une mission vérifiée, renforce les contrôles Git et qualifie une mission authentifiée réelle dans un environnement privé. Il ne constitue pas une ouverture publique.

## Continuité

La PR74 initiale (`5046ed2c`) a été intégrée pendant ce travail avec les contributions modèles/capacités, à `7755d4745ed6e9561fb9743f3b2b5820878dff11`. Les correctifs présents sont conservés sur la branche distincte `codex/iao-workshop-artifacts-20261113`, puis rapprochés de cette composition. Aucun push forcé ni écrasement des travaux intégrés. Le déploiement automatique de cette branche est désactivé.

Le superviseur conserve la réconciliation des effets incertains de capacités. Les fixtures correspondantes utilisent maintenant de vrais dépôts Git propres ; les assertions de protection sont conservées.

## Parcours réel qualifié

Mission `94c0d8cb-936d-4963-8afc-b74ef975e38f`, version générée `027a291700e691209d05aea712f41446701db57b`.

- Deux comptes synthétiques se connectent réellement à Supabase Auth. Les appels passent par l’interface, le proxy Edge réel, KARTA, Redis et PostgreSQL.
- Trois exécutions réelles de Codex : réalisation, contrôle fonctionnel et contrôle sécurité. Chaque tâche atteint `verified_done` à sa première tentative, au même SHA, avec quatre éléments de preuve. Le serveur exécute effectivement le navigateur Chrome via des profils de confiance.
- La création est une page française autonome : titre, compteur, clics, activation clavier, absence de requêtes externes et d’erreurs JavaScript, largeur 320 px. Cette recette ne valide pas une application arbitraire ou mobile.
- Les accès à la mission et à son artefact sont refusés au second compte (404) et sans session (401).
- L’archive authentifiée contient `index.html`, fait 3 066 octets et passe une lecture ZIP indépendante. L’aperçu fait 2 948 octets. Mission, SHA et empreinte de l’archive concordent.
- Usage rapporté pour cette mission : 520 087 tokens. **Coût monétaire inconnu**, jamais présenté comme nul. Les tentatives antérieures sont distinctes et ne sont pas comprises dans ce nombre.

Preuves : `authenticated-mission-db.json`, `authenticated-artifact-api.json`, `authenticated-artifact.zip` et `authenticated-preview.html`. Les reçus navigateur détaillent leurs étapes individuellement.

**Réception navigateur de l’export : PASS.** Le reçu `authenticated-resume-2026-11-13T02-23-33-449Z-4ef955d8.json` confirme le téléchargement réel, son empreinte, trois clics et Entrée (0 → 4), puis un clic mobile normal (4 → 5), l’origine parent inaccessible et zéro erreur JavaScript. Les captures ordinateur et mobiles stables ont été inspectées. Le premier harnais était bloqué par le dialogue cookies ; il utilise maintenant le contrôle normal « Refuser tout ». Une première capture de bloc haut après redimensionnement présentait une zone blanche, non reproduite dans les vues iframe et viewport stabilisées. Les essais précédents restent conservés avec leur statut. La reprise ne crée aucune mission et sa passerelle refuse les mutations.

Le transport Claude historique est désactivé dans le harnais ; il n’est pas le fournisseur de ces tâches. L’adaptateur Codex, l’authentification, le stockage, le proxy, la vérification et les artefacts ci-dessus ne sont pas simulés. Le frontend testé utilise Vite local ; son build de production est contrôlé séparément.

## Correctifs confirmés

- Le préflight utilise la forme réelle `codex login status`. Le drapeau `--ignore-user-config` reste sur `exec`, où il est accepté.
- Un alias de dossier tel que `/tmp` au lieu de `/private/tmp` est refusé avant admission : API et verrous SQL doivent employer exactement la même identité canonique.
- L’exécutable Git est résolu vers un chemin absolu réel hors du dépôt ; les entrées PATH relatives/vides ne peuvent pas détourner les commandes. Sept tests avec exécutables marqueurs n’en exécutent aucun.
- Les tâches en lecture seule subissent les contrôles Git avant et après les profils. Une mutation bloque la validation. Le préflight transmet aussi la branche réelle au contrôle, qui la conserve lorsqu’aucune branche n’est assignée dans la tâche.
- Le dernier cas de branche a été reproduit en échec : changer de branche au même SHA pouvait produire un faux `verified_done`. Les régressions couvrent maintenant ce cas avant et pendant la vérification, ainsi que la priorité d’une branche explicitement assignée.
- L’export lit le commit vérifié, pas les fichiers courants. Un aperçu vide, binaire ou trop grand est omis sans rendre le ZIP inutilisable.
- Le modèle distingue travail prêt pour vérification et succès vérifié. Un navigateur interdit dans son sandbox reste explicitement non exécuté par le modèle ; les contrôles obligatoires du serveur décident ensuite. Aucun sandbox n’est désactivé.

La correction finale de branche a été ajoutée après la génération réelle ci-dessus. Ses régressions réelles Git et le typecheck/build final la qualifient ; la reprise de l’artefact utilise le build final sans nouvelle inférence.

## Vérifications exécutées

| Contrôle | Résultat | Portée |
| --- | --- | --- |
| KARTA complet après rapprochement | PASS, 3 221 tests / 154 fichiers | Avant le dernier correctif de branche |
| Interface complète après rapprochement | PASS, 446 tests / 20 fichiers | Version réunie |
| Régressions finales branche et contrôle | PASS, 98 tests / 5 fichiers | Quatre nouveaux cas, Git réel ; RPC de fixture simulée |
| Courses d’admission PostgreSQL natives | PASS, 5 scénarios | Deux connexions/processus, verrous observés, nettoyage confirmé |
| Types et builds frontend/KARTA | PASS | Dont KARTA final après la correction de branche |
| Lint final | PASS, zéro erreur | 21 avertissements préexistants conservés |

Ces nombres ne s’additionnent pas : plusieurs suites se recouvrent. Les reçus `integrated-*`, `final-*`, `native-admission-evidence.json` et `trusted-git-checks.json` contiennent les commandes et limites. Les preuves antérieures `full-*` et `preflight-*` restent historiques. Les délais des tests locaux sont adaptés au Mac chargé ; les délais de production ne sont pas augmentés.

## Qualification de l’hébergement et limites publiques

La qualification utilise un clone privé sur Hostinger, sans ports publics, avec clés de test distinctes, deux comptes synthétiques et les anciens cron neutralisés. La source PostgreSQL historique reste arrêtée et son contrôle disque inchangé. La migration atelier renommée de 030 à 031 est identique : elle n’est pas rejouée. Seule la migration capacités manquante a été ajoutée au clone après rapprochement.

L’authentification publique renvoie encore 502 et pointe vers OVH. Les sources OVH et Hostinger diffèrent ; la comparaison existante n’a sélectionné aucune source canonique. Notre clone Hostinger ne doit pas remplacer ces données. Les preuves publiées ne contiennent ni comptes clients ni secrets.

L’ouverture à n’importe quel utilisateur reste **BLOQUÉE** par la restauration cohérente de cette infrastructure, l’intégration puis le déploiement du lot, et les environnements réellement isolés par client, y compris pour leurs vérificateurs. Le catalogue actuel est préenregistré. Un exécutable de confiance lançant du code du projet ne remplace pas cette isolation.

Les choix de capacités dans l’atelier, l’édition visuelle Origin/N04, les aperçus multifichiers progressifs, les builds mobiles et la publication sont **NON QUALIFIÉS par ce lot**. Une revue en lecture seule qui découvre un défaut ne dispose pas encore d’un cycle de réparation par une nouvelle mission liée.

## Analyse de portée

L’index a été actualisé avant le contrôle final, puis ses modifications automatiques de fichiers d’instructions ont été retirées. GitNexus classe le rapprochement courant **CRITICAL** (84 fichiers, 772 symboles, 457 flux). La comparaison avec `main` inclut l’ensemble des travaux antérieurs (1 655 fichiers, 10 603 symboles, 610 flux). Le graphe est explicitement partiel ; l’absence d’un flux n’est pas une preuve d’absence d’impact. Les analyses et leurs limites sont conservées dans les reçus `gitnexus-final-*`.

## Nettoyage

**PASS.** Les navigateurs et les processus privés du Mac sont arrêtés ; quatre fichiers temporaires contenant les comptes de test sont supprimés. Sur Hostinger, les cinq conteneurs, leur réseau, leur volume Redis et le montage OverlayFS sont supprimés ; neuf fichiers secrets QA sont effacés. La couche privée inactive et les preuves restent conservées. La source historique, ses hashes et son instant d’arrêt sont inchangés, comme les configurations des autres services après comparaison normalisée. Voir `mac-private-cleanup.json` et `host-private-cleanup.json`. Aucune automatisation permanente n’est créée.
