# Procédure d'intégration réversible — protocole Compute Fabric v2

Cette procédure n'autorise ni déploiement, ni migration, ni appel fournisseur. Elle décrit l'ordre requis pour intégrer le commit T03 dans la lignée canonique choisie par ses propriétaires. Tant qu'une étape reste inconnue, le runtime IAO doit rester non injecté et les routes conservent leur échec fermé `503`.

## Contrat requis du daemon existant

Le daemon Compute Fabric existant reste l'unique moteur local. Son endpoint Unix `POST /v1/complete` doit :

1. refuser toute requête dont `protocol_version` n'est pas `2` ;
2. appliquer `execution_policy.locality = local_only` et `paid_fallback = forbidden`, sans fournisseur distant de secours ;
3. plafonner le travail à `max_tokens = 1024` et `concurrency = 1` ;
4. dédupliquer durablement par `idempotency_key` et `payload_digest`, rejouer le même résultat pour la même paire et refuser une clé associée à un autre digest ;
5. interrompre le calcul associé lorsque le client Unix se déconnecte, puis libérer ses ressources bornées ;
6. répondre avec le reçu strict suivant : version, clé et digest identiques, `execution.locality = local_only`, `paid_fallback_used = false`, et les deux plafonds acceptés.

KARTA rejette toute réponse ancienne, incomplète, divergente ou surdéclarée par `memory-unavailable:compute-fabric`. Cette incompatibilité volontaire empêche qu'un daemon non qualifié soit présenté comme local, plafonné ou sans repli payant.

## Qualification isolée avant câblage

Le propriétaire du daemon doit exécuter sur un socket Unix jetable, sans réseau externe ni secret, une qualification qui démontre séparément :

- annulation avant dispatch, pendant calcul et pendant flux ; le processus ou job de calcul est réellement terminé, pas seulement la socket ;
- reprise après reconstruction du client avec la même clé et le même digest, sans second calcul ;
- conflit même clé/digest différent rejeté avant calcul ;
- plafonds tokens et concurrence appliqués par le daemon ;
- absence de route vers un fournisseur payant, y compris en erreur, timeout ou saturation ;
- refus d'une identité non autorisée avant SMARANA et avant dispatch ;
- reçu v2 exact sur succès, et aucun reçu de succès lorsque l'effet reste inconnu.

Les tests T03 avec daemon fixture démontrent le contrat client et l'arrêt d'un calcul fixture explicitement annulable. Ils ne qualifient pas le daemon réel. Le raccord SMARANA réel, VAJRA et le runtime serveur complet restent eux aussi à qualifier par leurs propriétaires sur la lignée retenue.

## Intégration

1. Créer un worktree propre depuis la tête canonique choisie et vérifier les verrous des propriétaires IAO, KARTA, SMARANA, AKASHA, VAJRA et Local OSS.
2. Intégrer les deux commits fonctionnels dans l'ordre avec `git cherry-pick a5cbbcf80b058798f93b2e4ce4a1f9dcfd716e82 0b7d08707611479f444fc860e89828c953180eda`, sans recopier ni réimplémenter les composants SMARANA/AKASHA/VAJRA. Le premier transmet l'annulation au transport ; le second impose le reçu local v2.
3. Intégrer ensuite le commit du daemon v2 qualifié. Ne jamais inverser cet ordre en production : le client T03 doit échouer fermé face au protocole ancien.
4. Injecter les adaptateurs SMARANA et Compute Fabric dans le `KartaRuntime` existant. Ne créer aucun moteur, store, scheduler, broker de permissions ou daemon parallèle.
5. Rejouer les tests affectés, puis une gate KARTA complète. Conserver daemon réel, intégration serveur et environnement déployé dans des statuts distincts.
6. N'activer le runtime IAO qu'après les preuves daemon et intégration réelles. L'absence d'une preuve donne `UNKNOWN`, jamais `PASS`.

## Retour arrière

Le retour arrière est sans migration de données : désinjecter le runtime IAO pour revenir au `503`, puis exécuter `git revert 0b7d08707611479f444fc860e89828c953180eda a5cbbcf80b058798f93b2e4ce4a1f9dcfd716e82` dans un worktree appartenant à l'intégrateur. Cet ordre inverse retire d'abord le protocole v2, puis l'annulation du transport. Ne pas supprimer ni modifier les mémoires SMARANA/AKASHA et ne pas réactiver un protocole ancien par fallback. Les requêtes restées en état incertain sont réconciliées avec leur clé existante ; elles ne sont pas rejouées à l'aveugle.

Le commit de clôture documentaire se retrouve par `git log -1 --format=%H -- docs/iao/t03-local-transport-20261014/RAPPORT.md`. Il peut être intégré ou omis indépendamment des deux commits fonctionnels ; il ne modifie aucun runtime.
