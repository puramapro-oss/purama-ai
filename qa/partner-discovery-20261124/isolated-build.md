# Compilation isolée — préparation, pas exécution reçue

Le relais d’exécution distant n’a pas répondu à la lecture préalable. Aucun
clone, installation, conteneur ou build distant n’a été lancé par ce lot.
Les anciennes tentatives locales restent conservées avec leur propre statut.

Le script isolated-build.py prépare une réception dans un nouveau dossier
exclusif : base Git publique exacte, overlay figé vérifié par SHA-256, image
officielle Node 24 déjà présente, installation avec le verrou puis commande
officielle npm run build, incluant le contrôle des ressources hors ligne.
La commande ne modifie ni minification, ni configuration Vite, ni scripts du produit.

L’installation dispose du réseau ; le build utilise un conteneur distinct sans
réseau. Chaque conteneur est limité à 1 CPU, 3 Gio, 256 processus, sans privilège,
sans capacités Linux, sans port publié, sans socket Docker monté et avec son
système de fichiers en lecture seule hors espace de travail et /tmp. Aucune
variable, clé ou configuration personnelle de l’hôte n’est injectée. Le build
est borné à huit minutes ; l’installation à cinq minutes. Les journaux sont
drainés mais limités à 8 Mio par phase, avec indication explicite d’une coupure.

Le script refuse un dossier existant, une image à télécharger, un fichier
d’environnement opérationnel, un overlay mal identifié ou un manque de
ressources. Il conserve les empreintes avant/après, les artefacts de dist et
un reçu distinct. Le nettoyage ne vise que les conteneurs portant sa propre
claim. Aucun service existant n’est arrêté ou redémarré.

## Entrées requises

Le parent doit fournir la base finale de consolidation et l’overlay figé ; le
commit original des premiers tests ne doit pas être substitué silencieusement
à une consolidation ultérieure.

Format du manifeste :

    {
      "base_commit": "<SHA Git exact de 40 caractères>",
      "files": {
        "src/chemin-du-fichier.ts": {"sha256": "<SHA-256 exact>"}
      }
    }

Exécution uniquement sur l’exécuteur déjà autorisé, après gel du candidat :

    python3 isolated-build.py \
      --task-dir /srv/purama-qa/<dossier-neuf> \
      --overlay-dir <overlay-fige> \
      --manifest <manifeste-fige.json> \
      --node-image <image-Node-24-deja-presente>

**Vérification reçue :** compilation syntaxique Python seulement. L’absence
d’exécution distante est conservée ; ce script n’est pas une preuve de build.
