# Analyse d’impact avant correction des notifications

Révision produit examinée : `6c8c1b8d37f97b33e02b9181d1083420279631a9`.
Checkout réservé : `/workspace/scratch/b643db4cccea/iao-notifications`.
Analyse exécutée le 27 novembre 2026 à 04:04 UTC, avant édition des symboles concernés.

## Provenance et réutilisation de l’index

Deux constructions complètes locales ont été tentées. La première s’est interrompue avec le code 1 après que GitNexus eut automatiquement relevé la limite mémoire ; la seconde, avec une limite explicite de 1 Gio et un buffer LadybugDB de 256 Mio, a été arrêtée avec le code 137. Ces interruptions ne constituent pas des échecs produit. Les journaux `analyze-before.log` et `analyze-before-bounded.log` sont conservés. Les fichiers intermédiaires sont préservés séparément dans le chemin indiqué par le reçu de réutilisation.

L’index complet déjà construit sur **la même révision 6c8c1b8** a ensuite été réutilisé par copie indépendante. Le fichier de base, les métadonnées et le lanceur source ont conservé exactement leurs empreintes SHA-256, tailles et dates de modification avant et après copie ; aucun verrou d’écriture source n’était présent. Seuls les chemins de notre copie et son nom de branche ont été réassignés. La date originale d’indexation reste le 27 novembre à 03:44:30.789 UTC. Le registre a été mis à jour par `registerRepo`, l’API GitNexus munie de son verrou, uniquement pour notre chemin et l’alias `iao-notifications-b643`.

`index-reuse-receipt.json` et `source-index-metadata.json` conservent cette provenance. Il ne s’agit pas d’une prétendue nouvelle indexation réussie. Le graphe couvre 3 231 fichiers, 37 972 nœuds, 109 308 relations, 963 communautés et 757 flux rapportés. Les requêtes effectuées depuis notre checkout ne signalent aucun retard de révision. Les empreintes produit antérieures aux éditions figurent dans `impact-before-command-receipt.json`.

## Résultats et portée réelle

| Cible | Résultat GitNexus | Appelants et portée confirmée |
| --- | --- | --- |
| `generateEmailHtml` | LOW ; un appelant direct | L’appel se trouve dans le callback HTTP du même fichier, représenté au niveau `File` dans le graphe. |
| `NotificationPayload` | LOW ; une dépendance directe | Interface interne au handler et au générateur HTML. |
| Callback anonyme `Deno.serve` | UNKNOWN ; nom non résolu | Le callback n’existe pas comme symbole nommé `Deno.serve`. L’impact sur l’UID du fichier est aussi exécuté ; il reste UNKNOWN. |
| `useNotifications` | **CRITICAL** ; 8 symboles, 2 appelants directs, 6 entrées de flux | Appelé par `NotificationCenter` et `Notifications`, puis diffusé par `DashboardHeader` à plusieurs pages. |
| `useNotificationPreferences` | LOW ; un appelant direct, une entrée de flux | Appelé par `NotificationSettings`. |

L’analyse CRITICAL du hook et le risque manuel HIGH du handler ont été signalés à l’agent principal avant toute édition. LOW sur un helper ne réduit pas le risque de confidentialité ou de contrôle des destinataires de l’ensemble de la route.

Le graphe rattache aussi certaines méthodes usuelles telles que `from`, `select` ou `query` à des helpers de tests homonymes non importés par le handler. Ces associations ne sont pas retenues comme des appels réels : les imports et les chaînes Supabase ont été lus directement.

## Vérification manuelle des limites du graphe

Le module est enregistré par `Deno.serve`. `supabase/config.toml` conserve `verify_jwt = false` pour cette fonction, qui vérifie son secret webhook dans le handler. Le callback reçoit une charge utile HTTP, résout le destinataire dans `profiles`, lit `notification_preferences`, écrit dans `notifications`, puis peut transmettre un email via Resend. Ces opérations utilisent le client configuré avec le rôle de service ; la validation de l’identité et le refus des erreurs de préférences doivent donc être couverts par les régressions.

La recherche de `send-notification` et `generateEmailHtml` dans les sources locales n’a retrouvé aucun appel HTTP direct supplémentaire. Cela ne démontre pas l’absence de clients externes ou de workflows distants. `karta/src/engine/notify.ts` utilise `agent-push-send`, un chemin distinct ; il n’est pas modifié ni assimilé à cette fonction.

Les consommateurs de la table sont `src/hooks/useNotifications.ts`, `src/components/notifications/NotificationCenter.tsx` et `src/pages/Notifications.tsx`. Le hook utilise aussi `window.location.href` pour l’action du toast ; l’URL touche donc le parcours applicatif en plus du HTML de l’email. Le hook de préférences est consommé par `src/pages/NotificationSettings.tsx`. D’autres producteurs (`daily-report`, `process-tier-queue`) écrivent dans les mêmes tables sans appeler ce handler ; leurs sources doivent être préservées. Le delta ne peut, à lui seul, qualifier toutes les notifications produites ailleurs.

Le client applicatif et le handler sélectionnent le schéma `purama_ai`, tandis que l’abonnement temps réel historique du hook mentionne `public`. Les migrations historiques déclarent les tables initiales dans `public`. La correction du hook doit être rapprochée des contrats actuels ; cette inspection n’atteste pas la configuration effective d’une base distante ni la publication Realtime de production.

## Limites conservées

- La recherche FTS est désactivée dans l’index disponible. `query` a été exécuté et sa réponse conservée, sans interpréter son résultat vide comme une absence de code. Les requêtes exactes `context` et `impact` fonctionnent par UID ou par nom et chemin.
- Les limites de parcours de GitNexus restent présentes : des points d’entrée et des branches de flux sont exclus par ses plafonds. Le nombre de flux n’est pas une couverture exhaustive.
- La frontière HTTP, l’enregistrement d’un callback anonyme et les consommateurs liés par une table ne constituent pas tous des arêtes d’appel dans ce graphe. La lecture manuelle ci-dessus les complète.
- Aucun PDG de dépendances au niveau instruction n’est présent. Aucun résultat de ce dossier ne prouve une absence d’injection, une isolation SQL de production ou une livraison effective d’email.
- Les fichiers `existing-base-*` documentent la consultation initiale de l’index source. Les fichiers sans ce préfixe sont les requêtes finalement exécutées sur notre copie isolée de la même révision.

## Détection avant commit

Depuis la racine du checkout réservé, utiliser le CLI déjà installé et l’alias propre à ce checkout :

```bash
GITNEXUS_MEMORY=off GITNEXUS_LBUG_BUFFER_POOL_SIZE=268435456 node --max-old-space-size=768 /home/agent/.npm/_npx/5e786f48223a616c/node_modules/gitnexus/dist/cli/index.js detect-changes --repo iao-notifications-b643 --scope staged --limit 200
```

Puis effectuer la comparaison historique demandée par les instructions locales. La référence `origin/main`, absente du clone initial, a été importée depuis le dépôt local existant après confirmation GitHub en lecture seule de sa tête `ae84415be0b9516422805910be999a2c1e6350c0` par l’agent d’inventaire distant. `main-reference-receipt.json` conserve cette provenance ; aucune branche distante n’a été modifiée.

```bash
GITNEXUS_MEMORY=off GITNEXUS_LBUG_BUFFER_POOL_SIZE=268435456 node --max-old-space-size=768 /home/agent/.npm/_npx/5e786f48223a616c/node_modules/gitnexus/dist/cli/index.js detect-changes --repo iao-notifications-b643 --scope compare --base-ref origin/main --limit 200
```

La détection utilise le graphe antérieur pour rapprocher les modifications des symboles existants ; les nouveaux helpers et les chemins non résolus doivent aussi être relus dans le diff et couverts par leurs tests. Ne pas remplacer la comparaison avec `main` par celle du seul lot sans le signaler : l’écart de consolidation contient bien davantage de changements que la correction des notifications.

### Réception structurée avant commit

Les commandes ont été exécutées et conservées. Le CLI imprime toujours un résumé
de 15 symboles et 10 flux ; ses premières sorties textuelles, initialement nommées
`.json`, sont préservées sans modification dans les fichiers
`detect-*-cli-limit200.log` et `detect-*-original-text.json.log`.
Les fichiers `detect-staged.json` et `detect-main.json` contiennent désormais les
vrais objets structurés obtenus par `LocalBackend.callTool('detect_changes', ...)`,
le même backend installé que celui de `dist/cli/tool.js`. La recette
`detect-structured.mjs` et son reçu conservent les paramètres, dates, empreinte du
backend, HEAD, référence main et empreintes du diff staged avant/après.

**PASS pour le périmètre indexé du lot ; risque HIGH conservé.** Le résultat staged
énumère intégralement les **45 symboles et 9 flux** observés dans **145 fichiers
staged** : 26 symboles du hook, 15 du handler, 2 de NotificationSettings, 1 de
Notifications et 1 de NotificationCenter. Aucun symbole listé n’appartient à un
autre fichier produit. Les nouveaux helpers, le nouveau module URL partagé et le
callback anonyme Deno ne sont pas présents dans l’index initial : leur revue
manuelle et les appelants actuels sont explicités dans
`detect-manual-scope-review.json`, `manual-current-callers.log` et
`manual-current-helpers.log`. Les qualifications fonctionnelles sont conservées
séparément ; ce graphe ne les remplace pas.

**PARTIEL pour la comparaison historique avec main ; risque CRITICAL conservé.**
Le backend rapporte **3 712 fichiers, 28 057 symboles et 740 flux**, dont tous les
740 flux sont disponibles dans le JSON. La liste des symboles reste plafonnée à
1 000 (`truncated: true`). La relance CLI `--limit 30000`, archivée dans
`detect-main-cli-limit30000.log`, ne lève pas le plafond fixe
`DETECT_CHANGES_MAX_LISTED_SYMBOLS = 1000` du backend. Aucune bibliothèque ni aucun
index n’a été modifié pour contourner cette limite. Ces métriques agrégées ne
constituent pas une revue exhaustive des 28 057 symboles.

L’index demeure celui de **6c8c1b8**, daté du 27 novembre à 03:44:30 UTC. Le passage
de la base du checkout à **2720740** ne change que
`.github/workflows/purama-chef-hardening.yml` ; les sources produit de cette base
sont identiques. Aucune nouvelle analyse du code modifié n’est revendiquée.
L’ajout ultérieur de cette réception et de documents change le nombre de fichiers
staged ; le reçu garde le snapshot exact utilisé pour les 45 symboles du lot.
