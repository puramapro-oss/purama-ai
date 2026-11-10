# Sécurisation des emails de partenariat

## Périmètre et état

Correctif préparé dans le checkout isolé, sans migration distante, déploiement, envoi réel, modification n8n ou accès au travail en cours sur le Mac. Aucun secret fournisseur n'est utilisé par les tests. Les fichiers modifiés concernent uniquement l'endpoint de prospection, son client, la page des prospects, une migration dédiée et les tests associés.

Migration : `supabase/migrations/20261110030000_partner_outreach_reservations.sql`.

**PASS local : 47 tests sur 47.** Le journal complet est `final-test.log`. Les commandes, codes de sortie et empreintes de sources sont consignés dans `final-validation.json`. `initial-test-run.json` décrit uniquement la validation historique à 25 tests, antérieure au raccord d'approbation.

**Compléments d'intégration vérifiés sur le Mac isolé :** les quatre parcours navigateur passent (24,9 s, sortie 0). Ils couvrent l'approbation avec preuve reçue, le résultat incertain, la version refusée et la preuve manquante. Le brouillon hostile reste visible dans un document `about:srcdoc`, chargé complètement avec une origine opaque ; aucun script, requête de sonde, auto-navigation ou échappement vers le parent n'est observé. Preuves : [browser-outreach-verified.json](../integration/browser-outreach-verified.json) et [browser-outreach-verified.txt](../integration/browser-outreach-verified.txt).

La réservation et l'opposition persistante passent également sur **PostgreSQL natif 18.4 avec 12 connexions concurrentes**, dans un cluster jetable sur socket privé : une seule action, une seule génération et une seule admission à l'envoi. Aucun appel fournisseur n'est effectué. Preuves : [native-postgres-results.json](../integration/native-postgres-results.json), contrôle `outreach_admission_and_persistent_opposition`, et [native-postgres.txt](../integration/native-postgres.txt). Ces preuves complètent la validation locale historique décrite dans `final-validation.json`.

## Garanties couvertes

- L'identité provient exclusivement de l'utilisateur authentifié. Les identités, drapeaux d'approbation et clés d'idempotence fournis dans le corps de la requête ne délèguent aucun droit.
- Une réservation persistante protège chaque compte, prospect et étape. Un verrou de configuration sérialise aussi le quota et la recherche d'antécédents par email normalisé. La suppression d'un prospect conserve la réservation ; un réimport avec un nouvel UUID mais le même destinataire et la même étape exige une revue.
- Les rôles client ne peuvent pas modifier les réservations, les preuves fournisseur ou la liste d'opposition. Le statut `rejected` existant, utilisé par le gestionnaire de réponses pour le désabonnement et le refus, alimente une exclusion persistante par compte et email.
- L'activité de l'agent, la propriété, l'opposition, la réponse reçue, l'échéance de relance et la configuration d'approbation sont revérifiées après génération et juste avant le passage à l'envoi.
- L'enveloppe exacte et la clé fournisseur sont figées avant l'appel Resend. Un succès exige un identifiant fournisseur non vide et la persistance de ce résultat.
- Un timeout, une réponse fournisseur sans identifiant, une erreur serveur ou une confirmation de base perdue produit un résultat incertain, sans nouvel envoi automatique, y compris après 25 heures ou après suppression/réimport.
- Une tentative historique dépourvue de réservation durable exige une revue : l'ancien code pouvait avoir envoyé sans persister le résultat. Aucune donnée historique n'est supprimée par la migration.
- Une acceptation fournisseur tardive conserve le refus/la réponse reçu en cours d'appel et ne programme pas de nouvelle relance.

## Approbation réellement raccordée

L'ancien code enregistrait `pending_approval` sans circuit permettant de valider le brouillon. Le nouveau résultat inclut l'email et un aperçu provenant de la réservation protégée, avec expéditeur, destinataire, objet, corps HTML et version.

La page affiche cet aperçu dans une iframe de même page mais isolée par `sandbox=""` et une politique CSP interdisant les scripts, ressources externes et formulaires. Aucun HTML du brouillon n'est injecté dans le document principal. Le bouton explicite **Approuver et envoyer** appelle :

```json
{"action":"approve","email_id":"UUID de l'email","approval_version":"UUID de la version affichée"}
```

Le serveur exige le même utilisateur, le même email et la même version. Une modification de la ligne historique éditable `partner_emails` ne change pas l'enveloppe figée. La modification du destinataire, de l'expéditeur, de l'activité ou de l'opposition après l'aperçu bloque l'envoi. Changer la configuration d'approbation ne valide pas implicitement un email déjà en attente. Les clics simultanés ne déclenchent qu'un appel fournisseur.

`sendOutreach(prospectId)` reste compatible ; son second paramètre optionnel sélectionne l'étape. La page propose l'étape suivante du statut courant, ce qui permet aussi de rouvrir et approuver les trois relances. Une relance non échue reste refusée par le serveur avant génération. L'interface n'annonce une prise en charge qu'après preuve fournisseur ; une approbation seule ne vaut jamais envoi.

## Configuration du modèle et n8n

L'endpoint accepte `ANTHROPIC_MODEL_MAIN` et le handler accepte le même choix par injection. Une chaîne vide échoue avant appel API. Le fallback reste celui de la branche source : `claude-sonnet-4-20250514`. Ce patch ne choisit aucune nouvelle gamme ni politique de prix et ne remplace pas le fallback différent déjà observé sur le Mac (`claude-sonnet-4-6`). La disponibilité réelle du modèle configuré n'a pas été testée auprès du fournisseur.

Les formats n8n existants `prospect_id` et `type` restent acceptés. En revanche, les workflows du dépôt utilisent un jeton service-role et un en-tête d'identité que cet endpoint ne transforme pas en utilisateur : le raccord serveur à serveur autorisé reste à réaliser séparément. Aucun contournement de `auth.getUser`, aucune approbation automatique n8n et aucun changement de workflow actif ne sont inclus.

## Validation et limites

Les tests importent le vrai handler et les vrais utilitaires client. PGlite exécute le schéma historique et la migration réelle. Les fournisseurs sont simulés explicitement et tout appel réseau global inattendu échoue. Les cas couvrent notamment 20 requêtes simultanées, 20 approbations simultanées, l'isolation entre comptes, les versions erronées, les modifications de configuration, les preuves manquantes, les permissions SQL, la reprise de préparation expirée et la réapplication sans perte de données.

La réimportation sous nouvel UUID a d'abord échoué dans les deux cas envoyé/incertain (`reimport-before.log`, sortie 1), puis les deux cas passent dans la suite finale. Ce journal constitue une preuve avant/après du contrôle supplémentaire par destinataire normalisé.

Commandes depuis `karta` :

```bash
./node_modules/.bin/vitest run test/partnerOutreach.test.ts --maxWorkers 1 --pool threads --reporter verbose
./node_modules/.bin/tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck --types node ../supabase/functions/partner-send-outreach/handler.ts ../src/lib/partner-outreach-result.ts test/partnerOutreach.test.ts
```

Appliquer la migration avant l'endpoint, puis publier le client correspondant ; l'absence des RPC bloque l'envoi. Les parcours navigateur et la concurrence SQL ont été validés dans les environnements isolés décrits ci-dessus ; cela ne constitue pas une mesure de charge ou de performance de production. **Les appels fournisseurs réels, le déploiement et la livraison effective dans une boîte mail restent NON TESTÉS.** Un message déjà remis au fournisseur ne peut pas être rappelé par un refus ultérieur. Les issues inconnues nécessitent une vérification fournisseur ; aucun processus de renvoi automatique ou de réconciliation distante n'est installé.

La clé Resend reste une protection complémentaire à la réservation persistante. Source officielle consultée : https://resend.com/blog/engineering-idempotency-keys (en-tête `Idempotency-Key`, même charge utile, fenêtre de 24 heures).
