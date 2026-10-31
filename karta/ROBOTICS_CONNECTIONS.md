# PURAMA robots — parcours de connexion et aperçu

État au 31 octobre 2026. Ce lot complète le catalogue et les outils KARTA de la PR nº 5
avec une page utilisable à `/dashboard/robots`, accessible depuis le menu **Robots**.
La route utilise la protection de session existante. Ce code n'est pas encore déployé.

## Comportement livré

1. Choisir l'une des 11 cibles matérielles ou le simulateur.
2. Lire la méthode d'accès, les étapes nécessaires, les capacités disponibles dans
   PURAMA et les sources constructeur.
3. Ouvrir le simulateur et composer une routine : nom, textes, gestes nommés et pauses.
   Ajouter, réordonner ou supprimer les étapes ; régler leurs durées.
4. Exporter un fichier de routine PURAMA et le réimporter pour le réutiliser.
5. Lancer l'aperçu visuel, le mettre en pause, reprendre ou l'arrêter. Un changement
   de modèle ou une sortie de page détruit la séance locale et libère les minuteurs.

Le catalogue matériel est une liste de cibles étudiées. Aucun scan réseau, appairage,
compte constructeur, connecteur matériel, émission audio ou commande de moteur n'est
implémenté par cet écran. Les six catégories (parole, gestes, pauses, déplacements,
caméra, microphone) affichent leur disponibilité réelle dans cette version. Une
interface documentée par un fabricant n'est jamais présentée comme un robot connecté.

L'aperçu réutilise le validateur et le planificateur KARTA. Il refuse les robots
physiques, les séances invalides, les lancements concurrents et les durées hors
contrat. La pause fige l'avancement ; la reprise ne rattrape pas le temps suspendu.
L'expiration ou une horloge invalide arrête l'aperçu. Une fin normale atteinte avant
ou exactement à l'expiration reste une fin, même si le tick d'affichage arrive tard.
Cette correction permet de terminer une routine de cinq minutes. Une pause qui
repousse sa fin après l'expiration provoque toujours un arrêt.
Le passage de l'onglet en arrière-plan
déclenche une pause ; le retour ne reprend pas automatiquement. Les données restent
en mémoire dans le composant : seul l'export explicite permet de conserver une routine.
Une modification après un arrêt ou une fin remet l'aperçu à zéro ; elle ne reprend
jamais l'ancienne séance. L'édition et les fichiers sont verrouillés pendant la lecture
de l'aperçu, y compris en pause.

## Routines réutilisables

Le format JSON `purama.robot.routine`, version 1, est propre à PURAMA. Il contient
uniquement `format`, `version`, `name` et `steps`. Ce n'est pas un programme moteur
ni un standard de connexion universel. Exemple minimal :

```json
{
  "format": "purama.robot.routine",
  "version": 1,
  "name": "Accueil",
  "steps": [
    { "id": "welcome", "kind": "speech", "text": "Bienvenue.", "durationMs": 3000, "required": true },
    { "id": "pause", "kind": "pause", "durationMs": 2000, "required": true }
  ]
}
```

Le nom est limité à 120 caractères, le fichier à 512 000 octets. Le contrat commun
limite la routine à 24 étapes et cinq minutes, avec 1 à 60 000 ms par étape et
2 000 caractères par texte. L'éditeur conserve les durées à la milliseconde et
les identifiants des étapes importées. Le champ `required` est conservé ; aucune
dégradation matérielle n'est implémentée.

`src/robotics/routines.ts` valide les fichiers avec le même contrat que les séances.
Chaque lancement crée une requête avec une expiration nouvelle et une cible choisie
explicitement ; le fichier ne transporte ni cible, ni identité, ni droit d'accès.
Dans l'interface, la cible reste le simulateur. Toutes les cibles physiques restent
bloquées par le planificateur et refusées par l'aperçu.

Un import invalide préserve le brouillon. Une lecture de fichier en cours verrouille
l'édition et le lancement ; son résultat est ignoré si l'utilisateur quitte l'écran.
L'import ne lance rien. Les fichiers sont lus et préparés dans le navigateur, sans
envoi par ce composant. Les URL de téléchargement et minuteurs sont libérés.

## Points d'accès vérifiés dans les sources

- [Reachy 2 — connexion réseau](https://docs.pollen-robotics.com/developing-with-reachy-2/getting-started-sdk/connect-reachy2/) :
  Wi-Fi ou Ethernet sur le même réseau ; adresse IP et SDK Python. Une interface web
  PURAMA requiert un logiciel de liaison compatible, qui reste à développer.
- [Unitree G1](https://shop.unitree.com/products/unitree-g1) et
  [template UniStore officiel](https://github.com/unitreerobotics/unitree-app-templates/blob/main/g1_mimic_demo/README.md) :
  vérifier l'édition, le firmware, les droits de développement et les permissions de
  l'application ; le transfert de contrôle n'est pas une autorisation universelle.
- [Tesla Developer](https://developer.tesla.com/) : aucune interface publique Optimus
  exploitable identifiée dans la recherche documentée. Le guide ne remplace pas cet accès.

Les autres fabricants et leurs sources figurent dans le catalogue partagé
`src/robotics/catalog.ts` et le [rapport précédent](./ROBOTICS_AUDIT_2026-10-30.md).
PURAMA fournit le logiciel envisagé pour des robots tiers ; ce lot ne vend aucun robot.

## Vérifications et reproduction

| Contrôle | Résultat |
| --- | --- |
| `karta/` : suite Vitest complète | PASS : 273 tests / 29 fichiers, dont 51 tests ajoutés pour les routines et les 2 000 requêtes générées de l'audit précédent |
| `karta/` : `npm run typecheck` et `npm run build` | PASS |
| Racine : build Vite normal et avec les paramètres de test locaux | PASS |
| ESLint sur les fichiers de ce lot | PASS |
| Playwright : 8 parcours sur 3 tailles d'écran | PASS : 24 tests sous Chromium 153, sans relance automatique |
| Contrôle visuel | Captures du catalogue, de l'aperçu et de l'éditeur ordinateur/mobile examinées ; absence de débordement horizontal contrôlée |
| TypeScript global du site | PARTIEL : 141 diagnostics préexistants, aucun nouveau après comparaison au commit `c20b234` |
| Vrais téléphones, Safari, comptes constructeur et robots | NON TESTÉ |

Commande portable : `npx playwright test --config playwright.robotics.config.ts`
après installation d'un Chromium Playwright compatible. Cette configuration compile
avec un domaine Supabase fictif, intercepte les services externes et emploie une
session de test. Elle valide la route protégée et l'interface locale, pas un serveur
d'authentification réel. La configuration Playwright générale exclut ces tests pour
éviter de les exécuter avec un build ou un backend différent.

Dans l'environnement de cet audit, le téléchargement Playwright restait inutilisable.
Chromium 153.0.8010.0 a été obtenu via `@sparticuz/chromium@153.0.0`, installé dans un
répertoire de test extérieur au dépôt. Les archives ont été extraites sans changement
de propriétaire. Le lancement a nécessité un rendu sans GPU et plusieurs processus ;
le mode à processus unique interrompait le navigateur entre deux contextes. Les
services externes restent interceptés. Ce runtime n'est pas une dépendance du produit.

La revue React couvre le chargement différé de la page, l'état isolé par composant,
les étiquettes des champs, les messages de statut, le nettoyage des effets et les
comportements sur écran étroit. Les contrôles de texte et de geste utilisent des
étiquettes explicites à identifiants stables. Les tests vérifient aussi le vrai fichier
téléchargé, son réimport, l'ordre, les fractions de seconde, le refus d'un fichier
invalide ou trop volumineux, les 24 identifiants uniques et une lecture terminée après
la sortie de page. Le rendu des emojis n'est pas validé par ce Chromium sans polices
emoji ; leur contenu est conservé dans les champs et les fichiers testés.

## Analyse d'impact et dépendances restantes

Avant modification, l'analyse de `RobotRehearsal` indique LOW : un appelant direct,
la page `Robots`. `RobotSessionPreview` indique LOW, deux appelants directs et
quatre symboles concernés, dans le même parcours. La méthode `tick` indique LOW,
deux appelants directs, sans parcours résolu. Les références du gestionnaire `start`
et de la fixture `prepare` ne sont pas résolues par le graphe ; leur utilisation dans
le bouton et les tests a été contrôlée dans les sources. Une absence d'arête ne prouve
pas l'absence d'utilisation.

La détection des changements indique HIGH : 9 fichiers / 86 symboles / 8 parcours
pour les routines ; CRITICAL : 42 fichiers / 395 symboles / 16 parcours pour toute la
branche par rapport à `main`. Ces résultats ont été signalés. Le diff correspond aux
fichiers prévus. L'index annonce des parcours tronqués ; son résultat ne constitue
pas une certification. La branche reste en revue, sans fusion ni déploiement.

L'audit des dépendances du 31 octobre remonte **26 alertes dans le site** : aucune
critique, deux élevées, 23 modérées et une faible. Le précédent résultat de 14 alertes
n'est donc plus le résultat actuel. Les fichiers de dépendances sont inchangés par
ce lot. Le nouvel avis [minimatch GHSA-g3hv-75wg-m249](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249)
annonce un correctif en 11.0.1 ; `npm audit` signale le verrou actuel en 10.2.5 et
plusieurs dépendants, notamment ESLint. La version corrigée sort de l'override majeur
actuel ; sa migration et les autres mises à niveau restent à qualifier.
Les 141 diagnostics TypeScript préexistants sont identiques après normalisation des
numéros de ligne. Les dépendances KARTA restent sans alerte déclarée, développement
compris. Ce lot ne résout donc pas l'audit global du site.

Pour réaliser une première connexion matérielle, il reste à choisir le modèle et
le firmware exacts, obtenir les accès du propriétaire, développer le connecteur et
qualifier chaque commande sur le robot. L'autorisation et les limites du contrôleur
constructeur restent applicables. Le téléphone seul ne garantit pas cette compatibilité.
