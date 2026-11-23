# Réglages partenaires — durée de vie et concurrence des écritures

## Résultat

La page existante réutilise useRequestScope, useScopedState et createRequestScope pour rattacher les réponses au compte et à la durée de vie effectivement affichés. Les réponses tardives ne remplacent plus les réglages d’un autre compte et ne libèrent pas une opération plus récente. Les saisies effectuées pendant une requête sont conservées.

Sauvegarde et envoi de signature écrivent tous deux signature_image_url. Une réservation synchrone commune settings-write les sérialise dans cette instance du composant ; les deux contrôles reflètent l’opération en cours. Un chargement pour un propriétaire différent affiche une erreur récupérable.

## Composition et absence de doublon

Les contributions 00586c2f puis 6145767e ont été préservées. La seconde est arrivée pendant une publication protégée : la mise à jour de branche a refusé de remplacer sa tête. Son fichier PartnerAgentSettings.ownership.test.tsx reste canonique. Les 13 cas sont conservés, le cas A→B→A est renforcé et l’erreur de signature est vérifiée aussi après déconnexion. Quatre cas distincts ont été ajoutés. Le fichier lifecycle non publié a été supprimé après cette consolidation.

La contre-revue sur la tête exacte 6145767 confirme la préservation des champs et règles métier. Elle confirme aussi les défauts supplémentaires : deux verrous indépendants laissaient courir sauvegarde/signature ; un propriétaire étranger laissait un chargement infini.

## Preuves

- Les 18 cas React/JSDOM réunifiés ont réussi, sortie 0, sans exclusion.
- Sur le produit concurrent exact, les quatre cas complémentaires donnent trois échecs reproduits et un succès StrictMode. Les 14 autres cas ne sont pas sélectionnés.
- Les cinq contrôles horaires existants ont réussi séparément sur le même produit : 23 cas ciblés finaux, sans addition des reproductions ou des anciens résultats.
- ESLint composé : sortie 0. Typage avant consolidation des tests : sortie 0 ; produit inchangé. Le typage des tests réunifiés est interrompu 137 sans diagnostic de code et reste à recevoir en CI.
- Cinq scénarios Playwright sont ajoutés à la suite ui-state existante. Leur résultat navigateur reste à recevoir en CI.

L’exécuteur s’est déconnecté après ces contrôles, puis son répertoire temporaire a disparu. Le code a été reconstruit depuis les contenus conservés et ses SHA-256 correspondent exactement aux sources exécutées. Le journal JSON brut des 18 cas n’a pas survécu ; le reçu compact conserve les résultats effectivement observés. Il ne prétend pas être ce journal brut. Les reçus antérieurs et ceux du transport local sont conservés intégralement.

## Limites

GitNexus impact a été exécuté sur le graphe antérieur et complété par les références courantes. L’indexation fraîche est interrompue 137 et detect_changes échoue explicitement faute d’index. Les tests, la revue du diff et la contre-revue ne sont pas présentés comme un succès de ce contrôle.

Les gardes client ne retirent pas une écriture distante déjà acceptée et ne constituent pas un verrou entre appareils. Aucun service réel, envoi, paiement, migration ou déploiement n’est qualifié ici. La réception de la composition complète reste suivie dans la PR93.
