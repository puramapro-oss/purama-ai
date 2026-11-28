# API développeur IAO — accès par projet

## État et continuité

Cette tranche prolonge PURAMA API PLATFORM et le Conseil IAO existant. Elle ajoute une frontière d'accès pour les développeurs ; elle réutilise `ConsultationHost`, le catalogue qualifié, les adaptateurs fournisseurs, les réservations et les reçus CHEF. Elle n'ajoute ni moteur d'intelligence concurrent, ni portefeuille, ni accès administratif pour les clients.

Base de reprise : `272074017383c9a8f8c817d3bdea945cf692b3bc`, branche `feat/iao-provider-capabilities-20261127` (PR 126). Branche de cette tranche : `feat/iao-public-api-access-20261128`. La conception API historique, son complément du 27 novembre et la demande de poursuite du 28 novembre constituent le périmètre repris.

**Implémentation qualifiée localement ; activation commerciale et déploiement non effectués.** Le registre fonctionne pour des projets appartenant à un compte. Il ne représente pas encore des organisations d'entreprise, des délégations OAuth ou tous les modules de ONE.

## Contrat HTTP

Le contrat machine est [iao-public-api.openapi.json](iao-public-api.openapi.json). Les quatre routes utilisent un seul en-tête `Authorization: Bearer <clé IAO>`. Les clés des fournisseurs et `KARTA_ADMIN_TOKEN` restent réservés au serveur.

| Route | Droit | Résultat |
|---|---|---|
| `GET /v1/iao/models` | `catalog` | Modèles réellement qualifiés et autorisés pour le projet. |
| `POST /v1/iao/consultations` | `create` | Résultat ou état de la consultation existante. |
| `GET /v1/iao/consultations/{operationId}` | `read` | État et résultat privé de cette opération dans ce projet. |
| `POST /v1/iao/consultations/{operationId}/cancel` | `cancel` | Identifiant, état réel et `cancelRequested` uniquement. |

Exemple de corps pour la création, avec un modèle issu du catalogue du projet :

```json
{
  "operationId": "6cebbd58-9409-4c9a-a583-e6fb12f6aff2",
  "question": "Explique les choix possibles à partir des informations fournies.",
  "preferences": {
    "model": "modele-renvoye-par-le-catalogue",
    "reflection": "standard",
    "speed": "standard"
  }
}
```

`operationId` est un UUID choisi par le client et conservé lors d'une reprise. La même demande dans le même projet retrouve son opération durable ; un contenu différent sous cet identifiant est refusé avec `409`. Deux projets peuvent utiliser le même UUID sans partager leur opération. Aucun en-tête d'idempotence supplémentaire n'est interprété. Le propriétaire, le projet, le budget et les credentials ne font pas partie du corps accepté.

Les demandes JSON sont limitées à 65 536 octets. L'admission — authentification, lecture du corps et disponibilité — dispose de 10 secondes ; l'exécution du Conseil est bornée à 135 secondes. Un délai dépassé demande de lire l'état avant toute reprise. Les réponses sont privées et non stockables dans les caches HTTP. La lecture et l'annulation restent accessibles pendant une dégradation de dépendances ; la création exige une disponibilité confirmée et un arrêt global inactif.

Cette version ne fournit pas de streaming SSE, de compatibilité OpenAI complète, de SDK publié ou de webhooks sortants. Elle ne prétend pas assembler les ports SMARANA/Fabric absents de la façade IAO complète.

## Autorité des clés et des projets

La migration `karta/migrations/039_iao_public_api.sql` ajoute trois tables privées : projets, empreintes des clés et rattachements des opérations. Les rôles navigateur `anon` et `authenticated` n'y accèdent pas. La gestion initiale est réservée à l'opérateur disposant du rôle serveur ; aucun portail de création de clés n'est revendiqué.

`generateIaoApiKey()` produit un identifiant UUID, un secret aléatoire de 32 octets et l'empreinte SHA-256 de la clé complète. Seuls l'identifiant et l'empreinte sont persistés. La clé brute doit être remise une fois par le canal de secrets de l'opérateur, sans journalisation. La rotation consiste à émettre une nouvelle clé du même projet puis à révoquer l'ancienne ; les opérations restent rattachées au projet.

Chaque projet porte une liste de modèles, une expiration, un plafond estimatif par opération et une limite de requêtes par minute. Chaque clé porte ses propres droits, son expiration et sa révocation. Les identités et rattachements sont immuables ; une révocation ne peut pas être annulée par une modification de ligne. Le compteur de débit est partagé entre les clés du projet et verrouillé en base. Il s'agit d'une fenêtre d'une minute, pas d'un lissage de trafic.

Les RPC publiques internes utilisent une liste fermée de méthodes du Conseil. Elles revérifient les autorisations dans la transaction avant les créations, démarrages et réservations. La révocation validée bloque les réservations suivantes ; elle ne rappelle pas un appel déjà réservé ou envoyé. L'annulation interrompt immédiatement les appels suivis dans la même instance et empêche les réservations suivantes via l'état durable. L'interruption instantanée entre toutes les instances n'est pas garantie.

## Budget, reçus et revenu

Le budget reste celui du propriétaire dans CHEF, partagé avec ses autres projets et consultations. Le plafond par projet est un maximum estimatif pour une opération, calculé sur l'ensemble des appels autorisés, y compris les critiques, la synthèse et la recherche. Il ne constitue ni un solde indépendant, ni un prix client, ni une garantie de montant final chez le fournisseur.

Une demande sans grant CHEF reste refusée. Le passage public ne peut pas créer ce grant, augmenter le budget ou activer un fournisseur. Les opérations et leurs reçus utilisent les tables comptables existantes.

Les coûts inconnus restent `NULL` après un appel envoyé. La révocation de la clé n'empêche pas le serveur d'enregistrer le reçu et de finaliser une opération déjà engagée. Le drain du serveur attend ces traitements même si la réponse HTTP a pris fin. Le rapprochement financier existant reste nécessaire avant d'affirmer un coût réel.

Aucun tarif API, débit Stripe, abonnement API, coupon ou commission nouvelle n'est activé. La commission historique de 30 % n'est pas appliquée à une assiette API inventée. L'ouverture commerciale demande encore une autorité de prix, une devise, le traitement des remises et remboursements, l'assiette contractuelle d'affiliation et le raccordement à la facturation existante. Ces décisions doivent permettre de mesurer la contribution réelle après coûts et frais.

## Activation et exploitation

L'entrée HTTP est fermée par défaut. `KARTA_PUBLIC_API_ENABLED=true` compose le runtime public dans le serveur standard. L'activation demande d'abord la migration, un projet actif, une clé valide, une politique fournisseur qualifiée et non expirée, des credentials serveur et un grant CHEF valide. Le mode simulé ne fournit pas de consultation publique réelle.

Le serveur doit être placé derrière le transport TLS et les protections d'exploitation habituelles de l'hébergement retenu. Aucun domaine public, certificat, migration de production ou déploiement n'a été créé par cette tranche. Le déploiement Vercel automatique de sa branche est désactivé.

## Preuves et limites

Les preuves de l'état final sont conservées dans `qa/public-api-20261128/`. Les 88 tests propres à cette API comprennent 53 tests HTTP, 24 tests SQL et 11 intégrations HTTP → autorité de projet → Conseil → migrations réelles → SDK installé avec un fournisseur de test. Sept scénarios supplémentaires utilisent PostgreSQL 18.7 natif avec plusieurs connexions et observation effective des verrous. Le reçu natif rattache ces scénarios aux empreintes de la migration et du test.

La qualification finale de la suite KARTA, du typage, de la compilation et du périmètre GitNexus est consignée dans le reçu de validation. Les essais locaux ne prouvent pas un appel fournisseur payé, une exploitation distribuée complète, des paiements réels ou un fonctionnement de production. Ces vérifications restent explicitement distinctes.
