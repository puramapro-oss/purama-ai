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

Appliquer `karta/migrations/029_model_usage_receipts.sql` avant le code.
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
Sa composition effective est documentée ci-dessous ; `signal` et `onUsage` sont
conservés ensemble, avec sélection après admission et callback après le résultat
borné, avant la validation. Aucun second mécanisme de délai ou de routage n'est créé.

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

## Première réception distante et correction des bancs

Candidat `65ff9fc` : CI [43167231086](https://github.com/puramapro-oss/purama-ai/actions/runs/43167231086),
**2 288 PASS / 39 FAIL**, 128 fichiers. Les 19 cas de migration et les nouveaux
cas de normalisation/transport/boucle/probe passent. Les échecs identifient quatre
bancs d'intégration sans la migration028, puis un adaptateur de test qui supprimait
SQLSTATE23505 lors du nouveau scénario de livraison répétée du logger.

Les fixtures du moteur actuel sont mises à jour ; leurs variantes historiques
restent inchangées. L'adaptateur transmet le code PostgreSQL comme PostgREST.
Les assertions, le code de production et les protections ne sont pas affaiblis.
Une nouvelle CI du candidat corrigé reste obligatoire. Le reçu de cette première
campagne est conservé dans `ci-first.json`.

## Deuxième CI et composition avec la PR63 intégrée

Le candidat `820e34d` a passé **2 327 tests KARTA / 128 fichiers**, les types,
la compilation, les contrôles SQL complémentaires et les **7 tests de concurrence
des abonnements** dans la CI [43168416008](https://github.com/puramapro-oss/purama-ai/actions/runs/43168416008).
Son checkout `099fd8a` possède le même arbre `1cdae593` que le candidat publié.
Le job site poursuivait ses suites navigateur lorsque la consolidation a intégré
la PR63 (`58baecb`). Cette réception ne qualifie donc pas encore la combinaison.

Les deux conflits de `real.ts` et `types.ts` sont résolus en conservant les deux
contrats. La sélection du modèle reste à l'intérieur de `bounded` : aucune lecture
de contexte avant admission d'un appel préannulé et erreurs synchrones toujours
assainies. Le résultat borné contient le modèle choisi et la réponse complète ;
le callback de consommation reste après ce résultat et avant validation de la
décision. Les signaux, délais, tentatives uniques, logs SDK désactivés et règles
de routage sensible de la PR63 sont conservés.

Le mock de configuration du test de consommation doit maintenant définir le
délai : les **9 échecs attendus** sont reproduits avant ajout de cette valeur.
Les assertions sur les réponses tardives, annulations et demandes simultanées
sont renforcées pour vérifier aussi l'absence de reçu attribué au mauvais appel.
La campagne locale combinée passe **331/331 tests dans 18 fichiers**, dont les
contrôles de coût, qualité de routage, contexte, délais, confidentialité et reçus.
La sortie complète est dans `composition-targeted.txt`. Une nouvelle CI complète
sur le candidat combiné reste obligatoire.

`evidence.json` distingue désormais explicitement le snapshot local d'avant
publication et les réceptions distantes suivantes. Les anciens états
`NON TESTÉ` ne décrivent pas l'état courant de la qualification distante.

## Coexistence avec les résultats privés intégrés

La CI [43170366699](https://github.com/puramapro-oss/purama-ai/actions/runs/43170366699)
a ensuite terminé en **PASS complet** : **2 391 tests KARTA / 131 fichiers**, types,
compilation, contrôles SQL, site et concurrence des abonnements. Son reçu daté est
conservé dans `ci-third-before-private-results.json`.

Pendant cette réception, la consolidation a intégré les résultats privés
(`42410d7`), qui utilisent `028_private_tool_results.sql` et enrichissent la boucle.
La fusion de la boucle est propre. Pour conserver une séquence sans doublon, notre
migration non déployée est renommée **`029_model_usage_receipts.sql`**, avec contenu
SQL strictement identique. Les références actives changent ; les historiques de
tests gardent les noms réellement exécutés à leur date. Les 29 numéros sont uniques.

Les fixtures SQL et PostgreSQL natif dédiées aux résultats privés appliquent aussi
029 pour vérifier leur coexistence. Le manifeste de fixtures du journal n'ajoute
pas la migration privée, car elle requiert les tables de créateurs propres à son
périmètre. Les scénarios de refus de remise privée vérifient que le reçu reste
attaché à la clôture et qu'aucune nouvelle inférence automatique n'est déclenchée.
La campagne ciblée combinée passe **436/436 tests dans 21 fichiers** ; les cas
de refus du stockage privé gardent le reçu et ne répètent pas l’inférence.
Les contrôles PostgreSQL natif et la CI complète de cette nouvelle composition
restent à recevoir. Le journal est `private-results-composition-targeted.txt`.
