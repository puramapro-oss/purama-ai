# Google Play Setup - Purama AI

Temps estime : 3 minutes (apres la premiere configuration du compte Google Play).

## Prerequis

- Compte Google Play Console (25$ une seule fois) : https://play.google.com/console
- Projet Google Cloud existant (ou en creer un)
- EAS CLI installe : `npm install -g eas-cli`

---

## Etape 1 -- Creer l'application sur Google Play Console

1. Ouvrir https://play.google.com/console
2. Cliquer **Creer une application**
3. Remplir :
   - **Nom de l'application** : `Purama AI`
   - **Langue par defaut** : Francais (France)
   - **Application ou jeu** : Application
   - **Gratuite ou payante** : Gratuite
4. Accepter les declarations et cliquer **Creer l'application**

## Etape 2 -- Remplir les informations obligatoires

Dans le menu lateral gauche, remplir chaque section marquee d'un point rouge :

### Politique de confidentialite
- URL : `https://purama-ai.purama.dev/politique-confidentialite`

### Acces a l'application
- Selectionner : **Toutes les fonctionnalites sont accessibles sans droits d'acces speciaux**

### Annonces
- Selectionner : **Non, mon application ne contient pas d'annonces**

### Classification du contenu
1. Cliquer **Demarrer le questionnaire**
2. Adresse e-mail : `matiss.frasne@gmail.com`
3. Categorie : **Utilitaire, productivite, communication ou autre**
4. Repondre Non a toutes les questions (violence, sexe, substances, langage, etc.)
5. **Enregistrer** puis **Soumettre**
6. Resultat attendu : **Tout public (Everyone)**

### Public cible
1. Tranches d'age : cocher uniquement **18 ans et plus**
2. L'application n'est pas destinee aux enfants
3. Enregistrer

### Securite des donnees (Data Safety)
1. L'application collecte-t-elle des donnees ? **Oui**
2. Types de donnees collectees :
   - **Informations personnelles** : Nom, Adresse e-mail
   - **Informations financieres** : Historique d'achats
   - **Activite dans l'application** : Interactions avec l'application, historique de recherche
   - **Identifiants de l'appareil** : Identifiant de l'appareil
3. Pour chaque type :
   - Donnees partagees avec des tiers : **Non**
   - Donnees collectees : **Oui**
   - But : **Fonctionnalite de l'application**, **Analyse**, **Securite et conformite**
   - Ephemere : **Non**
4. Pratiques de securite :
   - Donnees chiffrees en transit : **Oui**
   - Les utilisateurs peuvent demander la suppression : **Oui**
5. Enregistrer et soumettre

### Fiche Play Store (Store Listing)
- Les descriptions sont deja dans `store-config/store.config.json`
- Ajouter les captures d'ecran (generees par Maestro) :
  - Telephone : min 2, format 16:9 ou 9:16
  - Tablette 7" : optionnel
  - Tablette 10" : optionnel
- Icone : 512x512 PNG (generee automatiquement par le build EAS)
- Graphic de fonctionnalite (Feature Graphic) : 1024x500 PNG

## Etape 3 -- Creer un compte de service Google Cloud

1. Ouvrir https://console.cloud.google.com
2. Selectionner ou creer un projet (ex: `purama-apps`)
3. Aller dans **IAM et administration** > **Comptes de service**
4. Cliquer **Creer un compte de service**
   - Nom : `eas-submit`
   - Description : `EAS Submit for Purama apps`
5. Cliquer **Creer et continuer**
6. Role : **Aucun role** (les permissions seront donnees via Play Console)
7. Cliquer **OK**

## Etape 4 -- Telecharger la cle JSON

1. Dans la liste des comptes de service, cliquer sur `eas-submit`
2. Onglet **Cles**
3. Cliquer **Ajouter une cle** > **Creer une cle**
4. Format : **JSON**
5. Cliquer **Creer**
6. Le fichier `.json` est telecharge automatiquement

## Etape 5 -- Placer la cle dans le projet

```bash
# Copier la cle telechargee dans le dossier mobile
cp ~/Downloads/purama-apps-xxxxx.json /Users/matissdornier/purama/purama-ai/mobile/google-service-account.json
```

**IMPORTANT** : Ce fichier est deja dans `.gitignore`. Ne jamais le committer.

## Etape 6 -- Accorder les permissions dans Google Play Console

1. Retourner sur https://play.google.com/console
2. Aller dans **Parametres** > **Acces API**
3. Si ce n'est pas fait, cliquer **Associer un projet Google Cloud** et selectionner `purama-apps`
4. Dans la section **Comptes de service**, trouver `eas-submit`
5. Cliquer **Accorder l'acces**
6. Onglet **Autorisations de l'application** :
   - Cocher **Purama AI**
7. Onglet **Autorisations du compte** :
   - Cocher **Publier en production, exclure des appareils, utiliser la signature d'appli Play**
   - Cocher **Gerer les versions de production et de test**
   - Cocher **Gerer les fiches Play Store, les tarifs et la distribution**
8. Cliquer **Inviter l'utilisateur**
9. Confirmer

## Etape 7 -- Activer les APIs necessaires

1. Dans Google Cloud Console, aller dans **APIs et services** > **Bibliotheque**
2. Rechercher et activer :
   - **Google Play Android Developer API**
   - **Google Play Developer Reporting API** (optionnel)

## Etape 8 -- Soumettre avec EAS

```bash
# Depuis le dossier mobile
cd /Users/matissdornier/purama/purama-ai/mobile

# Build de production
eas build --platform android --profile prod

# Soumettre sur Google Play (internal testing)
eas submit --platform android --latest
```

EAS va automatiquement :
- Detecter `google-service-account.json` (configure dans `eas.json`)
- Uploader l'AAB sur Google Play Console
- Creer une release en test interne

## Etape 9 -- Promouvoir en production

1. Retourner sur Google Play Console
2. Aller dans **Publication** > **Production**
3. Cliquer **Promouvoir la release** depuis le test interne
4. Verifier les informations
5. Cliquer **Deployer en production**
6. Attendre la review Google (generalement 1-3 jours pour la premiere soumission)

---

## Resume des fichiers

| Fichier | Emplacement | Git |
|---------|-------------|-----|
| `google-service-account.json` | `mobile/` | Ignore (.gitignore) |
| `store.config.json` | `mobile/store-config/` | Commite |
| `eas.json` | `mobile/` | Commite |

## En cas de probleme

- **"Permission denied"** : Verifier que le compte de service a bien les permissions dans Play Console (Etape 6)
- **"API not enabled"** : Activer Google Play Android Developer API (Etape 7)
- **"App not found"** : La premiere soumission doit etre faite manuellement via Play Console, ou creer l'app d'abord (Etape 1)
- **"Invalid package name"** : Verifier que `dev.purama.purama_ai` correspond dans `app.json` et Play Console
