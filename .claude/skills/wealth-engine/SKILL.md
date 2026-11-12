---
name: wealth-engine
description: "Faire évoluer les revenus, économies, missions financées et récompenses de PURAMA avec IAO. Utiliser pour concevoir, intégrer ou vérifier ces parcours et leurs règles économiques, en réutilisant ONE, Commerce/PAY et les agents existants."
---

# IAO — revenus et argent disponible

Conserver ce skill comme guide de travail du dépôt IAO. Viser une amélioration mesurable de l’argent disponible et du temps utile de chaque utilisateur. Une instruction ne crée ni compte, ni mandat, ni fonds, ni capacité d’exécution. Ne garantir ni enrichissement, montant, délai de gain, rendement, adoption universelle ou supériorité mondiale.

## Retrouver les sources canoniques

Avant de proposer une nouvelle fonction, relever le dépôt, la branche et le commit actifs, les décisions récentes, les contrats acceptés et les services effectivement raccordés. Réutiliser les propriétaires suivants ; les chemins ONE appartiennent à `puramapro-oss/purama-one`, pas au présent dépôt.

| Besoin | Source à réutiliser |
| --- | --- |
| Explorer et préparer un revenu | ONE `/revenus`, `src/lib/income/catalogue.ts`, `workflows.ts`, `planner.ts` et `IncomeWorkspace` |
| Chiffrer coûts et temps | ONE `src/lib/income/economics.ts` et `IncomeCalculator` |
| Conserver le travail ouvert | ONE `IncomePlan`, `IncomeSessionProvider` et les imports/exports existants |
| Économiser | Parcours Économiser/SANCHAYA existant ; préserver économies, récupérations et ventes de biens comme natures distinctes |
| Missions et récompenses | ONE `/recompenses`, préparateurs de campagnes et de partenaires existants |
| Commissions et fonds | ONE `src/server/commerce/purama-commission-policy.ts`, `ledger.ts`, `reward-campaign-funding.ts` et `src/server/pay/ledger-community-allocation.ts` |
| Agir et mémoriser avec IAO | KARTA/KRIYA pour les actions autorisées ; SMARANA pour la mémoire autorisée ; preuves et reçus des services propriétaires |
| Cadre de réponse IAO | `karta/src/claude/assistant-policy.ts`, réexporté par `supabase/functions/_shared/assistant-policy.ts` |

Garder les identifiants canoniques d’un parcours, d’une commande et d’une transaction. Ne créer aucun catalogue, portefeuille, solde, moteur d’affiliation ou registre parallèle. Un parcours préparé, un lien fournisseur ou une hypothèse ne prouvent pas une mission disponible. Vérifier son état courant ; respecter `not_connected` lorsqu’il est encore présent.

## Appliquer les décisions consolidées

Prendre les décisions des 11–12 novembre 2026 comme base de continuité, puis vérifier toute décision ultérieure avant modification.

- **ONE : 199 € et 499 € par mois.** Préserver le catalogue d’abonnement et le pont de droits canoniques. La présence d’anciens plans propres à IAO ne démontre pas leur convergence avec ONE : relever l’écart et raccorder les contrats existants, sans inventer un identifiant Stripe ni migrer un contrat accepté. Délivrer le quota de la période au paiement/renouvellement selon la règle existante ; les quotas inutilisés expirent en fin de période et ne se cumulent pas. Ne promettre aucun usage illimité non couvert.
- **Commission PURAMA : 9 %** sur les nouvelles opérations admissibles où PURAMA fixe et prélève déjà sa commission. Remplacer le taux antérieur dans ce périmètre, sans cumul ni extension aux tarifs imposés par un tiers. Les anciennes opérations et leurs remboursements gardent la politique acceptée à l’origine.
- **Fonds commun : 30 % de la commission PURAMA HT admissible encaissée**, après les corrections applicables et avant les coûts propres de PURAMA. Cette part est comprise dans la commission, pas ajoutée au prix. Utiliser les calculs, arrondis, reprises, réserves et preuves du registre existant.
- Pour expliquer seulement, sur une base de 100 € sans taxe ni autre frais dans l’illustration : 9 € de commission, dont 2,70 € au fonds et 6,30 € à PURAMA avant coûts ; 91 € restent sur la base du prestataire avant ses coûts. Aucun de ces restes n’est un bénéfice net ni une récompense individuelle garantie.
- **Affiliation distincte :** conserver les règles et contrats existants, dont le barème 30 % et les bonus pouvant atteindre 40 % lorsqu’ils sont admissibles. Ne jamais additionner ce taux, les 9 % et les 30 % du fonds sur une même assiette implicite. Les primes, promotions et avantages nécessitent leur propre éligibilité et leur financement.
- Séparer euros acquis, estimations, points, quotas, avantages, crypto et NFT. Conserver la crypto PURAMA existante ; aucune conversion ou émission automatique. Un NFT offert ou un bien possédé ne devient pas un revenu encaissé par estimation de sa valeur.

Ne réintroduire ni ancien partage du chiffre d’affaires, ni tarifs abandonnés, ni barème fixe de récompenses sans couverture. Les multiplicateurs éventuels ne portent que sur une prime admissible, plafonnée et financée ; ils ne multiplient pas un solde, un salaire ou l’argent placé.

## Choisir puis accomplir une prochaine action utile

1. **Définir le résultat et les contraintes.** Relever le temps réellement disponible, les compétences, les équipements déjà possédés, le pays, les besoins d’accessibilité et les coûts acceptés. Respecter le refus d’avance personnelle. Distinguer objectif exprimé, capacité observée et information manquante.
2. **Partir d’une demande réelle.** Chercher dans les parcours existants une économie justifiable, une somme récupérable, une mission financée ou une commande avec un payeur identifié. Relever le livrable, les critères de réception, les droits d’utilisation, les frais et le délai contractuel de paiement. Une création réutilisable ou une offre récurrente vient avec une demande et des droits confirmés, pas avec des ventes supposées certaines.
3. **Chiffrer chaque action séparément.** Réutiliser le calculateur ; inclure réalisation, IA, sous-traitance, paiement, acquisition, déplacement, corrections et support, puis les charges personnelles pertinentes lorsqu’elles sont connues. Inclure candidatures et présélections dans le temps total. Une valeur inconnue reste inconnue ; ne pas la remplacer par zéro. Étiqueter précisément un résultat avant cotisations/impôts. Ne pas appliquer le scénario d’un parcours à tous les autres.
4. **Classer avec des raisons explicites.** Comparer les actions faisables et admissibles selon financement, reste après coûts, temps humain, délai jusqu’au versement et récurrence établie. Expliquer les données manquantes et l’objectif du classement. Exclure les actions incompatibles avec l’absence d’avance. Ne pas inventer de probabilité, de taux de conversion ou de revenu horaire ; garder les hypothèses visibles et distinctes des paiements constatés.
5. **Préparer dans le projet existant.** Aider à produire un devis, une candidature honnête, un livrable, un plan de livraison ou une demande de remboursement. Respecter les conditions du commanditaire et son autorisation d’usage de l’IA. Ne pas fabriquer avis, participation humaine, qualifications ou preuve de travail.
6. **Exécuter dans le mandat effectif.** Utiliser les outils et approbations KARTA/KRIYA déjà prévus. Les décisions réversibles et déjà autorisées peuvent avancer ; les messages à des tiers, dépenses, engagements, virements et investissements requièrent l’autorisation applicable au moment de l’action. Une sélection de parcours ou un fichier importé ne l’accorde pas.
7. **Vérifier et ajuster.** Rapprocher le résultat et l’encaissement de leur reçu, leur propriétaire, leur montant et leur source. Conserver la preuve et les préférences dans SMARANA seulement via le service autorisé. Mesurer paiements reçus, coûts, temps total, remboursements, délai au premier paiement, récurrence et part des utilisateurs sans gain. Proposer ensuite l’action utile suivante sans masquer les échecs.

## Financement, intégrité et mesure

- Avant d’ouvrir une mission rémunérée ou d’annoncer un cadeau, exiger payeur/commanditaire, budget disponible, réservation commune, conditions de réception, recours et canal de règlement qualifiés. Une projection comptable en lecture seule n’est pas une réservation de fonds.
- Réutiliser les transactions et clés d’idempotence du service propriétaire. Un paiement, un remboursement ou une contribution rejoués ne créent pas un deuxième droit. Ne pas compter une même vente dans plusieurs parcours comme plusieurs gains.
- Préserver les créances et retraits acquis. Ne pas les conditionner à un abonnement, un achat, un réinvestissement ou un recrutement nouveau. Présenter séparément les frais réellement prévus au contrat.
- Mesurer une économie sur une dépense de référence comparable ; ne pas traiter un achat supplémentaire comme un gain, une vente de bien comme une hausse automatique du patrimoine, ni un transfert entre comptes comme un revenu. Ne pas additionner euros, points et valorisations spéculatives.
- Les revenus d’activité, cotisations, impôts, prestations et statuts varient selon la personne et le pays. Vérifier les sources applicables et orienter vers le professionnel compétent lorsque nécessaire ; changer le nom d’une opération ne change pas sa nature juridique ou fiscale.
- Garder toute allocation, prise de crédit ou transaction financière dans le parcours autorisé du service concerné. Ne pas transformer l’objectif de revenu rapide en trading, levier ou investissement automatique. MIDAS conserve son périmètre propre et ne constitue pas une source de revenus garantie.
- Minimiser les données utilisées, garder la séparation des comptes et permettre la suppression selon les capacités réelles du service. Ne pas vendre de données de santé ou de confidences pour financer des récompenses, ni exploiter des signaux de fragilité pour pousser à dépenser.

## Rapporter le résultat vérifiable

Pour une modification, contrôler le périmètre, les contrats, la conservation des anciennes données et les cas financiers affectés ; exécuter les tests pertinents sur le candidat exact. Appliquer les consignes AGENTS du dépôt. Ne pas déduire un raccordement financier d’un test synthétique ou la sûreté d’un système d’une seule instruction.

Restituer **PASS**, **PARTIEL**, **BLOQUÉ** et **NON TESTÉ**, avec les preuves disponibles et la prochaine action dont le propriétaire est connu. Distinguer code préparé, code intégré, service déployé, action réelle et argent effectivement reçu. Une correction de ce skill ne prouve pas son chargement en production ni l’efficacité économique du modèle.
