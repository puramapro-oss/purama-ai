# Vérification du pack local IAO — 26 novembre 2026

## Problème corrigé

Le contrôleur pouvait calculer une empreinte SHA-256 correcte, laisser le test de chargement ou une promotion asynchrone modifier un fichier, puis mémoriser ses **nouvelles** métadonnées comme référence déjà vérifiée. Sept scénarios ciblés reproduisent ce défaut sur la source distante `271f40b666c11d90fe4a350a41432513a08fc72f` (arbre `ae5d147a47012799caa1822be4d327767a215b82`).

Chaque vérification conserve désormais les métadonnées associées au calcul réussi. Le contrôleur rapproche les deux fichiers avant le chargement, après celui-ci et après la promotion. Le reçu est contrôlé pendant sa lecture. Une date de modification absente ou non finie refuse la vérification avec une erreur de stockage ; elle ne déclenche pas un téléchargement automatique de réparation. La destruction du digest et la fermeture du fichier sont toutes deux tentées ; une erreur secondaire de nettoyage ne remplace pas l’erreur initiale.

Cette correction repose sur le répertoire privé de l’application et sur les métadonnées exposées par Expo. Elle ne prétend pas détecter une substitution délibérée conservant simultanément taille et date de modification. Le contrat actuel n’expose pas l’identité d’inode ou une ouverture NOFOLLOW.

## Calcul SHA-256 incrémental

Le module Expo local `PuramaLocalDigest` réutilise les primitives de la plateforme : `MessageDigest` en Java et CommonCrypto en Swift. Un contexte consomme des vues Uint8Array synchrones, bornées à 256 Kio. Aucun fichier complet, chemin de fichier, travail asynchrone natif ou nouvelle dépendance n’est ajouté. Le contrôleur conserve ses lectures bornées, ses pauses pour l’interface et ses contrôles d’annulation.

La résolution native est différée jusqu’à la vérification effective. Un module absent d’un registre JSI valide autorise le secours Noble avant le calcul. Une erreur du registre, de création, de mise à jour ou de finalisation n’autorise pas un repli silencieux. Le getter n’utilise pas `requireOptionalNativeModule`, car le helper SDK54 transforme certaines erreurs de résolution en `null`.

La qualification Android demande le chemin natif et vérifie un vecteur SHA-256 connu via une vue avec décalage non nul. Un test Java ou Swift seul ne prouve ni l’autolinking Expo, ni la compilation de l’application, ni l’exécution du bridge. Les jobs natifs existants portent ces contrôles supplémentaires.

## Preuves et réception

- `scope.json` : autorisation existante, responsabilités, périmètres voisins préservés et critères.
- `verification-local.json` : résultats locaux et limites, associés aux empreintes des sources.
- `impact-before.json` : résultats GitNexus disponibles. Le recalcul complet a été arrêté avec le code 137 ; FTS est indisponible. UNKNOWN ne signifie pas absence de risque. Les appelants du contrôleur ont été relus directement.
- `android-data-settings/` : lot séparé de qualification du réglage DATA sur l’émulateur jetable. Son essai ne transforme jamais l’échec initial du précontrôle en succès.

Les journaux conservés distinguent les échecs de reproduction attendus, les défauts de prérequis de test, les validations locales et les contrôles natifs. Le test UI historique de la route de qualification demande `react-test-renderer 19.1.0`, absent de l’environnement local ; il reste inclus dans la CI installée depuis le lockfile mobile.

## Limites de réception

Le succès natif historique sur `40e97b0` reste attaché à cette version. Sur `271f40b`, sept workflows ont réussi ; le job réseau Android a refusé une souscription DATA restée à `-1`, avant les mutations de radio et avant le build Android complet. Ce constat est séparé du correctif d’intégrité.

Le temps ancien observé de 464 642 ms pour l’inspection du pack de 639 446 688 octets contient toute l’étape de vérification/chargement. Ce n’est pas une mesure isolée du coût CPU de SHA-256. Aucun gain de vitesse de l’application n’est déclaré sans un nouveau reçu de l’application compilée.

Aucun déploiement, fusion dans main, changement de facturation, migration de production ou modification de données utilisateur n’est réalisé dans ce lot.
