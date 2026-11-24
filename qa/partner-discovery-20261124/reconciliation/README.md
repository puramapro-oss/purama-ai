# Rapprochement de la découverte et des partenariats médias

## Périmètre et architecture

Ce dossier documente le rapprochement de **PR111 médias**, canonique à `3c6d6c3a669d481b7c9bada7800c4721c0bb94de`, et de **PR112 découverte**, à `849402e342ea3dc757b2e009ff7c08c1532b1d97` avant fusion. Les protections de PR112 sont intégrées au parcours de PR111.

L’architecture retenue conserve le handler de PR111 et sa RPC transactionnelle `partner_discovery_import`, liée au compte authentifié. L’import produit des prospects `identified`, dont les coordonnées restent à qualifier. La qualification passe par `partner_prospect_qualify` et conserve les exigences de source, rôle, pays, langue, preuve et date d’accord, ainsi que le retrait d’autorisation. Une adresse observée ne constitue pas un accord d’envoi. La réception du backend composé reste indiquée séparément ci-dessous.

## Compatibilité et protections préservées

| Domaine | Composition retenue | Preuve |
|---|---|---|
| Qualification médias | Formulaire, consentement, retrait, sauvegarde filtrée et affichage conservés à l’identique du canon | [Comparaisons des blocs](frontend-reconciliation-receipt.json), [contre-revue](independent-review.json) |
| Conditions commerciales | Profils médias à 30 %, rédactionnel indépendant et conditions historiques conservés ; aucune nouvelle règle commerciale | [Contre-revue canonique](independent-review.json) |
| Propriété des recherches | Compte, cycle, révision du brouillon, verrou synchrone et masquage avant les effets passifs | [Recette frontend](frontend-reconciliation-receipt.json) |
| Réponses incertaines | Brouillon conservé, messages locaux pour les 18 codes canoniques, vérification avant relance ; aucun diagnostic fournisseur brut ni relance automatique | [Recette finale HTTP/DOM](frontend-feedback-receipt.json) |
| Contrat d’import | Plafond canonique de 25 ; `skipped` optionnel validé et conservé ; longueur cohérente avec `inserted` et somme au plus égale à 25 | [Rouge puis vert](frontend-reconciliation-receipt.json) |
| Transport non-2xx | Lecture du corps original limitée à 16 KiB et une seconde, sans clone ni décodage JSON illimité | [Preuves client](frontend-reconciliation-receipt.json) |

## Vérifications de cette composition

Le frontend final a exécuté **101 tests, tous PASS**, en 9,33 secondes : 35 client HTTP, 21 découverte DOM, 12 contrats DOM, 18 propriété des réglages, 10 réglages médias et 5 planning. Le lint des six chemins réconciliés passe avec zéro avertissement. Le [reçu final](frontend-feedback-receipt.json) conserve les empreintes et journaux.

La [première composition](frontend-reconciliation-receipt.json) conserve exactement **98 PASS**, précédés de 4 échecs sur 32 cas. Trois témoins de catalogue ont ensuite été ajoutés ; deux échouaient avant correction. Ces étapes ne sont pas cumulées. Les **235 cas historiques** de l’état antérieur ne qualifient pas cette composition.

La fixture `tests/quality/partner-media.spec.ts` fournit maintenant un reçu canonique cohérent : `inserted: 1`, `skipped: 0`, une ligne `identified`. Ses six scénarios et assertions de succès sont conservés. **Aucun navigateur n’a été exécuté dans cette reprise locale.**

| Réception restante | Statut |
|---|---|
| Backend composé et contrat final des codes d’erreur | **PASS**, 180 cas (117 découverte + 63 politique) ; [reçu](backend/receipt.json) |
| Vérification native Deno | **PASS**, 7 fichiers identiques, exit 0 en 1,321 s ; [reçu](native-typecheck.json) |
| Typecheck final de l’application | **PASS**, exit 0 en 16,724 s, sources inchangées ; [reçu final](frontend-typecheck-catalogue-final.json) |
| Recette navigateur médias, neuf cas SQL et réception CI globale, dont compilation | **NON TESTÉ sur la composition publiée**, réception CI attendue ; deux tentatives SQL locales interrompues avant résultat |

## Traçabilité et limites

Les empreintes complètes figurent dans le [reçu frontend final](frontend-feedback-receipt.json). Repères abrégés : page `bbc13d611bfa`, client `6516bbb530a1`, décodeur `a74828e029d7`. La [contre-revue indépendante](independent-review.json) distingue les vérifications reçues de ses propres lectures.

Le [graphe préédition](index-before.json) porte sur 13 fichiers, 585 nœuds et 1 236 arêtes. Les [impacts](impact-receipts.json) React restent `UNKNOWN` et ont été complétés par la lecture de la route et du JSX ; ce graphe ne certifie ni tout le dépôt ni l’état final. Aucun contrôle existant n’est retiré, aucune nouvelle pipeline n’est créée. Ce dossier ne revendique aucun déploiement, achat publicitaire ou contact externe.

Les suites finales totalisent **281 cas ciblés distincts** : 180 serveur/politique et 101 frontend. Les journaux `.log` sont livrés sous `.log.gz` ; les empreintes des reçus portent sur leur contenu décodé. Le [graphe composé](index-composed.json) qualifie les 13 fichiers à leurs empreintes finales ; ses limites restent identiques.

Le [contrôle final des changements](changes-receipt.json) conserve un impact statique **HIGH** (118 fichiers, 142 symboles, 15 flux) sur le lot préparé et **CRITICAL** (3 138 fichiers, 242 symboles, 28 flux) sur la consolidation comparée à `main`. Les preuves et le canon médias sont inclus dans ces périmètres ; ces niveaux ne sont pas assimilés à des défauts exécutés ni minorés.

L’[avance canonique PR109](canonical-advance.json), commit `9ab7e16`, est également conservée. Ses chemins ne recouvrent ni le delta de ce lot ni les 13 sources indexées ; aucune empreinte produit reçue n’a changé. La CI publiée recevra la composition globale avec cette avance.

Après cette avance, le [détecteur final](changes-latest-receipt.json) conserve les signaux HIGH/CRITICAL. Le nouveau décompte inclut les fichiers déjà publics de PR109 ; le graphe produit et ses empreintes restent identiques.
