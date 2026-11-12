# KARTA — reçus de consommation du modèle

## Objectif et base

Rendre les compteurs fournis par le modèle attribuables au journal et à son
utilisateur, afin de préparer des optimisations mesurables. Ce lot prolonge la
PR64 ; il ne recrée ni routeur, ni budget, ni journal financier CHEF.

Base immuable : `5ca6add91f1c94ce0e0baf42a1934521270ebd47`.
Branche : `audit/api-usage-20261112-4eb2`.

## Comportement livré

- `normalizeModelUsage` conserve douze champs de métadonnées autorisés. Les
  compteurs absents ou invalides restent `null`, les zéros explicitement reçus
  restent zéro. Aucun prix n'est inventé à partir du nom du modèle.
- Le client réel appelle `onUsage` après le retour du SDK, avant la validation
  de décision. Une réponse tronquée, refusée ou invalide peut donc conserver ses
  compteurs malgré l'absence d'action exécutable.
- Le reçu reste dans une closure serveur de `runAgentCycle`. Contexte et
  déclencheur ne peuvent lui fournir ni identité utilisateur ni faux compteur.
  La minimisation des traces privées conserve son fonctionnement ; le reçu ne
  fait pas partie du résultat métier public ou des notifications.
- `startRun.finish` écrit `model_usage` dans la clôture existante de `karta_runs`.
  La première valeur est copiée et figée avec le résultat. Après une confirmation
  perdue, la réconciliation compare aussi exactement ce reçu. Aucun aller-retour
  SQL ni appel de modèle supplémentaire n'est ajouté au parcours nominal.
- Une décision rejetée après réception d'un reçu ne propose pas de reprise
  automatique, même pour un appel direct sans clé d'exécution durable.
- Le probe de démarrage vérifie la nouvelle colonne dans sa requête existante
  à zéro ligne, avant admission des travaux. Une base non migrée est refusée.

Les modèles, prompts, plafonds, schémas d'outils, règles d'approbation et quotas
ne sont pas modifiés par ce lot. Une simulation métier peut appeler le vrai
modèle : ses compteurs sont donc conservés. Le mock et l'absence de réponse
fournisseur ne produisent pas un faux reçu à zéro.

## Migration et réception

Appliquer `karta/migrations/028_model_usage_receipts.sql` avant le code.
La migration ajoute une colonne nullable, conserve l'historique à `NULL`,
valide la forme fermée, les identifiants et les entiers sûrs. Elle ne crée
aucune table et ne modifie ni RLS ni privilèges. Le code précédent peut encore
clôturer une ligne avec ce schéma ; les reçus manquants restent inconnus.

| Gate local | Résultat constaté |
| --- | --- |
| Contre-tests client et boucle, avant raccord | 14 FAIL attendus / 5 PASS |
| Contre-tests du probe, avant garde de colonne | 2 FAIL attendus |
| Contre-test reprise sans clé, avant garde | 1 FAIL attendu, 13 ignorés par filtre |
| Régressions ciblées finales hors SQL | **212/212 PASS**, 14 fichiers |
| Première campagne ciblée avec PostgreSQL embarqué | 104/115 PASS ; worker du logger interrompu par SIGKILL |
| Compilation/types après toutes les modifications | Interrompus localement, code 137 ; pas de diagnostic causal établi |
| Migration et journal PostgreSQL finaux | **À qualifier dans la CI** |
| CI du candidat publié | **À qualifier** ; réception à conserver dans la PR |

Les journaux sont conservés avec leurs limites dans ce dossier. Les suites se
recouvrent : aucun total de tests uniques n'est obtenu en les additionnant.
Les tests transport utilisent les vrais SDK Anthropic et Supabase avec un
transport intercepté ; aucun fournisseur payant n'est appelé.

## Analyse d'impact et revue indépendante

Les impacts ont été exécutés avant les éditions de production. Le graphe
disponible date du commit `c81d316` ; une reconstruction complète a échoué avec
le code 1, sans cause établie. Cinq blobs du chemin d'appel ont été vérifiés
identiques à la base. `real.ts` diffère seulement par le correctif PR64 déjà
relu. Les frontières dynamiques de `decide`, `finish` et `probeRuntime` ont été
vérifiées par lecture du code ; un résultat UNKNOWN n'est pas un impact nul.

La revue indépendante a identifié le probe incomplet, reproduit puis corrigé.
Elle a ajouté les cas d'annulation après réception et d'échec du journal sans
nouvelle inférence. Elle ne remplace pas la qualification PostgreSQL.

La PR63 modifie aussi `real.ts` et `types.ts` pour les délais et le routage.
Lors de leur composition, conserver `signal` et `onUsage`, le modèle sélectionné
commun et placer le callback après le résultat borné, avant la validation.
Aucun travail de délai ou de routage de cette PR n'est reproduit ici.

## Limites financières et de durabilité

- Le reçu décrit des compteurs rapportés, pas une facture réconciliée. La route
  compatible peut être OmniRoute/Ollama ou un autre service ; aucune gratuité
  n'est déduite de son nom. L'URL complète et les en-têtes ne sont pas conservés.
- Les écritures du cache et leurs ventilations de durée sont des observations
  distinctes. Les ventilations ne doivent pas être ajoutées une seconde fois
  au total des créations. Des compteurs incohérents ne sont pas réparés.
- Une erreur réseau, une réponse tardive abandonnée ou un crash avant la clôture
  peuvent laisser un usage inconnu. La couverture de cette collecte doit être
  mesurée ; `NULL` ne signifie jamais gratuit ou zéro.
- Aucun rapprochement fournisseur, tarif actualisé par requête, plafond de
  dépenses strict ou économie en euros par utilisateur n'est revendiqué.
- Aucun déploiement ni migration de la base de production n'est effectué par
  les tests. La branche possède une exclusion Vercel explicite.

## Source du contrat

SDK installé et verrouillé : `@anthropic-ai/sdk 0.65.0`, définitions
`resources/messages/messages.d.ts` (usage et cache).
Documentation officielle consultée le 12 novembre 2026 :
<https://platform.claude.com/docs/en/api/messages/create>.
La documentation courante et la version SDK sont distinguées ; aucun changement
de version d'API ou de dépendance n'est effectué.
