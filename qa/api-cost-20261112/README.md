# KARTA — qualification du correctif de consommation API

**Date : 12 novembre 2026. Statut global de cette réception : PARTIEL.**

Le correctif du client Claude réel a passé ses **84 tests ciblés**, dont 13 nouveaux tests utilisant le véritable SDK avec un transport intercepté. La suite KARTA complète n'est pas qualifiée dans cet environnement : 26 processus de test ont reçu `SIGKILL`. Les économies facturées, l'équivalence de qualité des modèles locaux et la production ne sont pas validées par cette réception.

## Périmètre et identité

- Dépôt : `puramapro-oss/purama-ai`.
- Base examinée : `8259b84e65ca89b01bd1b1fc46576cb60bb8a1ec`.
- Branche de travail : `audit/api-cost-20261112-4eb2`.
- Source corrigée : `karta/src/claude/real.ts`.
- Nouvelle recette : `karta/test/claudeTransportCost.test.ts`.
- SDK réellement chargé : `@anthropic-ai/sdk@0.65.0`, issu du verrou existant.

Les empreintes des fichiers et des journaux lus figurent dans [evidence.json](./evidence.json). Elles identifient le contenu contrôlé ; la base Git indiquée n'est pas présentée comme un commit contenant le correctif. Les résultats additionnels et l'identité du candidat publié sont à ajouter dans la section finale.

## Changement effectué

Le client déclare maintenant `maxRetries: 0`. Dans la configuration antérieure, le SDK ajoutait deux reprises à certaines requêtes HTTP. La recette a observé **trois tentatives avant le correctif et une après** pour les erreurs 408, 409, 429, 500 et de connexion. Il s'agit d'erreurs synthétiques sur un transport intercepté : ces nombres ne sont pas une mesure de facturation réelle.

Le contexte utilise désormais `JSON.stringify(input.context)` sans indentation. Les valeurs, l'ordre des tableaux, les espaces et retours à la ligne dans les chaînes, l'Unicode, les nombres, les valeurs nulles et les dates représentées en chaînes sont conservés. La recette compare le contexte reparsé à l'original et vérifie que l'entrée n'a pas été modifiée. Elle constate aussi une diminution de taille en octets sur sa fixture. **Une diminution d'octets ne chiffre pas à elle seule une diminution de tokens ni un gain financier.**

Le choix des modèles et ses seuils, l'allocation `max_tokens: 1024`, le texte de la politique système et les contrats d'outils restent les mêmes. La validation des réponses complètes et le rejet des réponses tronquées continuent de fonctionner dans les cas couverts.

## Contrepartie des reprises désactivées

Le client effectue une seule tentative HTTP par décision. Une erreur transitoire remonte immédiatement au moteur. Sur le chemin actuel de la file KARTA, la livraison porte une identité d'exécution ; une erreur après son admission n'autorise pas une reprise automatique par BullMQ. Une redistribution consulte le journal de cette même identité avant toute nouvelle inférence.

Cette politique évite les reprises HTTP implicites, mais peut réduire la récupération automatique après une indisponibilité brève. Une exécution incertaine doit être réconciliée avant reprise. **Une réponse perdue peut correspondre à une requête déjà facturée : l'erreur ne prouve ni coût nul ni absence d'exécution chez le fournisseur.**

La fonction interne `runAgentCycle` accepte encore une identité optionnelle pour ses autres usages ; aucun appelant de production sans identité n'a été trouvé dans le périmètre lu. Une nouvelle livraison indépendante, ou la politique de reprise d'un proxy, reste distincte du contrôle effectué ici.

## Registre de vérification

| Contrôle | Statut | Résultat et portée |
|---|---|---|
| Reproduction avant correction | PASS | 8 échecs attendus et 5 réussites sur 13 tests ; sortie 1. Cinq échecs montrent trois tentatives HTTP ; trois montrent le contexte encore indenté. |
| Client corrigé et régressions ciblées | PASS | 84 tests réussis dans 4 fichiers, dont les 13 nouveaux tests du transport. |
| TypeScript et compilation KARTA | PASS, reçu de l'agent principal | Sortie 0 signalée pour la session d'exécution 30992. Aucun journal complet de ces commandes n'a été archivé lors de cette réception. |
| `git diff --check` | PASS | Exécuté et relu avec sortie 0. |
| Suite complète KARTA | PARTIEL | 1 496 tests réussis sur 2 066 recensés, 93 fichiers réussis sur 119 ; 26 erreurs de processus `SIGKILL`. Les autres cas ne sont pas crédités comme réussis. |
| Nouvelle tentative isolée de migration CHEF | PARTIEL | 1 test réussi sur 3 recensés ; le processus reçoit encore `SIGKILL` avec un seul worker. |
| Premier essai réel KARTA vers Ollama | PARTIEL, résultat rapporté par l'agent principal | `devstral:24b` répond au calcul, mais produit une explication au lieu de la sortie exacte `42` exigée. Ce critère échoue ; le deuxième scénario n'est pas atteint. |
| Facture, qualité comparative et production | NON TESTÉ | Aucun montant économisé, aucune équivalence globale et aucun déploiement validé par ces preuves. |

La cause des `SIGKILL` n'est pas établie par ces journaux. Ils ne prouvent ni une régression applicative ni la réussite des tests interrompus. Réduire à un worker n'a pas suffi à achever l'essai isolé. Les résultats des suites ciblées et complètes se recouvrent : **ne pas additionner leurs nombres de tests**.

Pour le premier essai local, l'agent principal rapporte 831 tokens d'entrée, 23 de sortie et 28,56 secondes pour le processus entier. Ce temps n'est ni une mesure isolée du délai du premier token ni un benchmark de débit. Cette mesure ponctuelle ne démontre pas une économie globale ou une qualité équivalente au service distant. Les critères de sortie restent identiques pour les essais suivants.

## Isolation de la recette du transport

Le test charge le SDK réel et intercepte `fetch` ; il ne simule pas `messages.create`. Il utilise des clés fictives et des domaines de fixture, neutralise `ANTHROPIC_AUTH_TOKEN` et les paramètres ambiants de proxy et de log, puis restaure les variables et le transport après chaque cas. Aucune requête de ce banc n'atteint un fournisseur réel.

Les deux tests d'URL prouvent que le SDK utilise déjà `ANTHROPIC_BASE_URL`, conserve l'endpoint par défaut quand cette variable est absente et n'introduit pas de repli vers une autre origine. Ils ne prouvent pas qu'un service OmniRoute réel est démarré ou compatible. Le contrôle d'absence de bearer valide l'isolation de la fixture ; il n'est pas présenté comme un nouveau durcissement de la configuration de production.

La recette couvre les erreurs HTTP et de connexion, les deux choix de modèle existants, le contrat de sortie, les outils valides, les réponses partielles et la conservation des données. Le délai réel d'expiration du SDK n'a pas été attendu. La source verrouillée utilise le même contrôle du compteur de reprises pour les erreurs de connexion et de timeout.

## Reproduire les contrôles

Depuis `karta/`, sur des dépendances installées à partir de son verrou :

```bash
npm test -- test/claudeTransportCost.test.ts --maxWorkers=1 --reporter=verbose
npm test -- test/claudeTransportCost.test.ts test/real-claude.test.ts test/claudeDecisionCompleteness.test.ts test/loopModelAdmission.test.ts --maxWorkers=1 --reporter=verbose
npm run typecheck
npm run build
```

Les tentatives plus larges consignées sont `npm test -- --reporter=default` et `npm test -- test/chefBudgetMigration.test.ts --maxWorkers=1 --reporter=verbose`. Elles restent partielles tant qu'une réception complète sur le candidat exact ne les remplace pas explicitement.

Les sept journaux de recette et d'impact sont inclus dans ce dossier ; seuls les éventuels sauts de ligne vides supplémentaires en fin de fichier ont été retirés. Les empreintes originales et celles des copies sont distinguées dans le JSON. Le JSON conserve leurs empreintes, commandes et extraits de résultat ; les réponses des essais locaux sont également jointes. La recherche documentaire générale est conservée dans [la note sur les coûts API](../../docs/api-cost-research-20261112.md) ; elle ne remplace pas la recette logicielle.

## Preuves complémentaires ajoutées par root

Cette section est réservée aux réceptions ultérieures, avec leur date, le commit exact, l'environnement et les résultats observés. Elle doit distinguer : essais locaux suivants, état effectif d'OmniRoute, analyse d'impact, publication du candidat, CI et éventuelle mise en production. Un nouveau succès ne réécrit pas le premier échec de format local ni les exécutions interrompues ci-dessus.

### Compléments reçus de l’agent principal

- **GitNexus : PARTIEL pour la qualification du graphe.** Le journal d’impact relu indique `LOW`, trois symboles dans la chaîne amont et un appelant direct. Il signale aussi `staleness: diverged` et l’indisponibilité de FTS. Root rapporte un graphe copié indépendamment, enregistré sur `c81d316` le 12 novembre à 00:54:39 UTC, ainsi que quatre blobs pertinents identiques à la base. Ce n’est pas une réindexation complète et fraîche du candidat.
- **Détection du contenu staged : commande exécutée, portée limitée.** Le journal indique cinq fichiers, deux symboles (`createRealClaudeClient` et `decide`), risque `LOW`. Root rapporte la sortie 0. Ce comptage précède l’ajout du présent registre ; une réception finale doit identifier son périmètre exact.
- **Comparaison historique avec `main` : risque `CRITICAL`.** Le journal relu compte 1 345 fichiers, 12 251 symboles et 584 flux ; sa liste est plafonnée. Root rapporte la sortie 0 et l’avertissement présenté à l’utilisateur. La comparaison comprend l’ascendance de consolidation, pas seulement le correctif de ce lot. Une exécution de commande réussie ne transforme pas ce résultat en validation globale.
- **Deuxième banc local Devstral : PARTIEL.** Root rapporte deux appels : le format exact `42` échoue encore (33,289 s ; 831 tokens d’entrée et 17 de sortie), tandis que l’appel de l’outil `record_fixture` réussit (1,718 s ; 179 tokens d’entrée, 760 tokens de cache rapportés et 31 de sortie). La durée totale du processus est 38,87 s. Ces métriques sont rapportées par root ; les réponses brutes n’ont pas été relues par l’auteur du présent registre. Le critère de format reste inchangé, et cette réussite d’un outil n’établit pas l’équivalence du modèle.

Les journaux GitNexus relus et leurs empreintes figurent dans `source_logs` ; les détails reçus sont conservés dans `supplementary_evidence`. Le résultat Qwen est détaillé ci-dessous. L’état final d’OmniRoute, la publication, la CI et la production restent à compléter après observation. Le statut global du registre reste **PARTIEL**.

### Essai direct Qwen réellement exécuté

Le client KARTA candidat, avec le SDK verrouillé 0.65.0, a exécuté les deux mêmes cas synthétiques via Ollama sur le Mac : **2/2 PASS** pour `qwen3-coder:30b`. La réponse arithmétique exacte `42` a pris 48,140 s ; la décision d'outil avec `Zoé`, `12.5` et `EUR` a pris 0,783 s. Le processus entier a duré 53,48 s. Les deux requêtes rapportent respectivement 941 tokens d'entrée et 3 de sortie, puis 417 d'entrée, 859 de cache et 47 de sortie. Ces compteurs locaux ne constituent pas une facture.

Les données sont synthétiques, l'outil n'est jamais exécuté, et aucun agent métier n'est lancé. Le banc vérifie par `/api/show` un modèle GGUF doté des outils et sans hôte/modèle cloud. Le résultat brut figure dans [local-qwen-output.log](./local-qwen-output.log), et le résultat Devstral dans [local-devstral-output.log](./local-devstral-output.log). Le premier essai Devstral interrompu reste décrit dans le registre.

Cette réception vérifie deux décisions, pas une capacité générale, une latence à chaud représentative ou un débit multi-utilisateur. Aucune bascule des utilisateurs réels vers ces modèles n'est décidée sur deux exemples.

### Exécution volontaire du banc local

`local-smoke.ts` est un banc manuel opt-in, en dehors de la suite CI. Il utilise seulement les modèles locaux inspectés `devstral:24b` et `qwen3-coder:30b`. La route directe est `127.0.0.1:11434`. L'option `PURAMA_LOCAL_SMOKE_ROUTE=omniroute` n'accepte que `127.0.0.1:50128`, avec une clé propre à l'installation éphémère transmise dans `PURAMA_LOCAL_SMOKE_API_KEY`. Aucune clé n'est imprimée. Le banc refuse les autres destinations et les redirections et borne chaque requête à 60 secondes.

Le bundle peut être construit avec l'esbuild déjà installé dans KARTA, en laissant `@anthropic-ai/sdk` externe pour charger la version verrouillée. Le lancer requiert `PURAMA_LOCAL_SMOKE=1` ; aucune installation ou récupération de modèle n'est effectuée par le banc.

### Synchronisation de la consolidation

La cible a avancé de `8259b84` à `cbd6000` pendant la recette. Les quatre commits ajoutent le correctif IME et stabilisent un test de délai, sans changer le client KARTA ni ses dépendances. La garde Vercel de cette branche et celle du correctif IME doivent toutes deux être conservées. La CI de la proposition identifiera le merge effectivement testé ; une preuve historique sur l'ancienne base ne la remplace pas.
