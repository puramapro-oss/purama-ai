# Distribution publique des modèles Creator Agent

Ce lot ajoute un parcours public de découverte, de partage et de copie privée à
l'application existante. Il ne crée pas une seconde application publique.

## Parcours livré

1. Un lien `/modeles/:id` ouvre directement la fiche publique, sans introduction
   bloquante et sans demander une connexion pour lire sa description.
2. Le partage produit un lien public nettoyé. Les jetons, paramètres privés et
   destinations externes ne deviennent pas des liens de retour de connexion.
3. La connexion, l'inscription et Google conservent une destination interne
   validée. Une inscription nécessitant une confirmation email est présentée
   comme telle ; aucune session n'est inventée.
4. La personne connectée choisit explicitement **Créer ma copie privée**. Le
   retour de connexion ne crée rien automatiquement.
5. Le serveur crée une copie appartenant à cette personne. La planification,
   KARTA, la publication et le statut de modèle officiel sont désactivés sur la
   copie. La copie ne déclenche aucun outil ou envoi.

Le catalogue officiel et le catalogue communautaire se chargent indépendamment.
Une section disponible reste utilisable si l'autre répond lentement ou échoue.
Une source retirée pendant une copie disparaît du catalogue courant ; une
réponse de lecture plus ancienne ne peut pas la réintroduire. Un nouveau
rechargement permet de découvrir une republication.

## Limites de données et d'autorisation

La RPC `public_creator_models` expose uniquement l'identifiant, le nom, la
description, l'emoji, la couleur, la catégorie et les indicateurs publics du
modèle. Elle n'expose ni propriétaire, ni prompt système, ni planification, ni
exécution, ni conversation.

La configuration d'un modèle publié devient réutilisable **après une copie
explicite et authentifiée**. Publier un modèle implique donc de rendre sa
configuration copiable. Cette distinction entre aperçu et copie est volontaire.

La RPC `clone_public_creator_model` :

- déduit le propriétaire depuis `auth.uid()` et vérifie l'identité attendue du
  clic ; l'identité fournie par le client n'accorde aucun droit ;
- contrôle la publication et l'activité de la source dans la transaction ;
- utilise un UUID de tentative fourni par le client pour une reprise idempotente ;
- ne restitue un résultat existant que pour le même propriétaire et la même
  source ;
- conserve la copie et sa provenance lorsque la source disparaît.

L'accès direct à l'agent et le chat restent réservés à son propriétaire. Un agent
public appartenant à quelqu'un d'autre doit d'abord être copié. L'historique est
filtré par utilisateur, agent et session. Les protections de la consolidation
sur les 20 derniers messages, l'annulation, la politique IA et la complétude des
réponses sont conservées.

## Délais, changements de compte et reprise

Les lectures publiques et la copie ont une attente totale limitée à 20 secondes,
y compris si le transport ignore son signal d'annulation. Le transport reçoit
également une annulation à la fin de l'attente. Un délai expiré ne prouve pas
qu'une transaction distante a été annulée : une reprise conserve donc le même
UUID de copie.

Les composants réutilisent les helpers de contexte de la consolidation. Une
ancienne réponse ne peut plus naviguer, retirer un modèle ou libérer le verrou
d'une nouvelle demande après un changement de compte, un cycle A → B → A ou un
démontage. Le verrou est pris avant la première attente asynchrone.

## Partage, introduction et PWA

Le partage natif, la copie dans le presse-papiers et le secours manuel utilisent
le même lien public validé. Un refus de partage ne devient pas un succès affiché.
Un code de recommandation explicite et valide peut être conservé ; ce lot ne
calcule ni commission ni droit financier.

Le worker ne met en cache que les ressources publiques de secours prévues. Il
ne stocke pas l'accueil avec des identifiants ni les réponses privées de l'API.
Une navigation hors ligne reçoit la page de secours et une action pour réessayer.

Un clic de notification ouvre une destination interne de consultation validée.
Aucune approbation, déclaration ou émission d'email n'est exécutée depuis les
données du payload de notification. Les caches d'autres applications du même
domaine sont préservés.

## Intégration avec la consolidation

Base : `90d8f30322e864ccfd186e97cbfe7edf3afec9a9`, branche
`audit/iao-integrated-20261110-14d16` (PR33).

Source du parcours initial : PR25,
`d5bd08c47fedd12e6eab1b74cd8ef5a6aed60a40`, complétée par les corrections
reproduites pendant cette reprise.

Le rapprochement est ciblé. Le merge global qui produisait 72 conflits n'a pas
été appliqué. Sont conservés :

- le provider d'authentification scindé, son abonnement avant la lecture initiale
  et la priorité donnée aux événements plus récents ;
- les contrôles de contexte du détail Creator Agent et le générateur actuel
  d'identifiants de session ;
- la pause facultative à consentement explicite de la consolidation ;
- les sources KARTA, les contrats commerciaux, les quotas et les migrations
  préexistantes ;
- les contrôles CI existants et leurs configurations navigateur.

La CI reçoit des contrôles supplémentaires de distribution. Sa configuration
navigateur propre exécute l'application compilée, avec services synthétiques,
sur Chromium et deux formats WebKit. Les suites publiques existantes restent
séparées. Playwright 1.64.1 est verrouillé pour inclure le correctif WebKit requis
par le contrôle du secours hors ligne.

Les dépendances directes de production et les overrides sont inchangés. Le lock
ajoute les outils de test et fait évoluer un transitif partagé,
`@jridgewell/sourcemap-codec` de 1.5.0 à 1.6.0, pour satisfaire `magic-string`
apporté par les tests. Cette résolution satisfait aussi les parents existants ;
le lock exact est utilisé pour la compilation et les qualifications.

Les six migrations héritées de l'ancienne base de sécurité de PR25 ne sont pas
absorbées dans ce port ciblé. Leur travail et leur historique restent dans leur
branche/PR d'origine. Ce lot ne vaut pas admission globale de toutes les branches
de PURAMA dans `main`.

## Reproduire les contrôles

Utiliser Node 22 et le lockfile versionné :

```sh
npm ci --no-audit
npm run test:distribution:unit
npm run test:distribution:sql
npm run test:distribution:worker
npm run test:distribution:chat
npm run typecheck
npm run typecheck:distribution
npm run lint
npm run build
npx playwright install --with-deps chromium webkit
npm run test:distribution:browser
```

Le navigateur de distribution compile sa propre sortie avec une URL Supabase
locale et une clé synthétique. Il ne lit pas de `.env` local. Aucune clé de
production n'est nécessaire. Les doublures réseau appartiennent aux tests et ne
remplacent aucun module produit dans le build.

Les résultats précis, empreintes et limites de qualification figurent dans
`integration-verification.json` et `FOLLOWUP.md`. Les contrôles unitaires, SQL et
VM ne prouvent pas une livraison push réelle, un OAuth distant, une migration
Supabase de production ou une réponse réelle d'un fournisseur IA.

Les suites publiques existantes conservent leurs contrôles de contenu et leur
seuil LCP de quatre secondes. Leur collecteur mesure le dernier candidat natif
d'une fenêtre de cinq secondes, joint ses diagnostics et échoue en l'absence
de mesure. Un échec local intermittent et son rejeu isolé réussi restent tous
deux consignés ; seule l'exécution complète du SHA publié peut qualifier la CI
de cet assemblage.

## Admission d'une version déployée

La migration `20261110001000_creator_public_distribution.sql`, la fonction
`creator-agent-chat` et le frontend doivent être admis comme un ensemble
cohérent. Avant ouverture du parcours en production, vérifier sur l'environnement
de déploiement autorisé :

1. l'application des politiques et des deux RPC dans le schéma `purama_ai` ;
2. les droits de lecture publique limités à la projection et le refus d'accès
   direct aux données d'un autre utilisateur ;
3. les destinations de retour acceptées par le service d'authentification ;
4. le parcours réel de connexion → copie → utilisation de sa propre copie ;
5. le secours hors ligne, la mise à jour du worker et le lien profond sur le
   domaine final.

Ces vérifications de déploiement ne sont pas présentées comme exécutées par les
tests locaux. L'hébergement et les règles financières ne sont pas modifiés.
