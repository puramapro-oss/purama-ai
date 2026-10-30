# PURAMA robots — parcours de connexion et aperçu

État au 30 octobre 2026. Ce lot complète le catalogue et les outils KARTA de la PR nº 5
avec une page utilisable à `/dashboard/robots`, accessible depuis le menu **Robots**.
La route utilise la protection de session existante. Ce code n'est pas encore déployé.

## Comportement livré

1. Choisir l'une des 11 cibles matérielles ou le simulateur.
2. Lire la méthode d'accès, les étapes nécessaires, les capacités disponibles dans
   PURAMA et les sources constructeur.
3. Ouvrir le simulateur, écrire un texte, choisir un geste nommé et régler les durées.
4. Lancer l'aperçu visuel, le mettre en pause, reprendre ou l'arrêter. Un changement
   de modèle ou une sortie de page détruit la séance locale et libère les minuteurs.

Le catalogue matériel est une liste de cibles étudiées. Aucun scan réseau, appairage,
compte constructeur, connecteur matériel, émission audio ou commande de moteur n'est
implémenté par cet écran. Les six catégories (parole, gestes, pauses, déplacements,
caméra, microphone) affichent leur disponibilité réelle dans cette version. Une
interface documentée par un fabricant n'est jamais présentée comme un robot connecté.

L'aperçu réutilise le validateur et le planificateur KARTA. Il refuse les robots
physiques, les séances invalides, les lancements concurrents et les durées hors
contrat. La pause fige l'avancement ; la reprise ne rattrape pas le temps suspendu.
L'expiration ou une horloge invalide arrête l'aperçu. Le passage de l'onglet en arrière-plan
déclenche une pause ; le retour ne reprend pas automatiquement. Les données restent
en mémoire dans le composant : aucun enregistrement permanent de séance n'est fourni.

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
| `karta/` : suite Vitest complète | PASS : 222 tests / 28 fichiers, dont les 2 000 requêtes générées de l'audit précédent |
| `karta/` : `npm run typecheck` et `npm run build` | PASS |
| Racine : build Vite avec les paramètres de test locaux | PASS |
| ESLint sur les fichiers de ce lot | PASS |
| Playwright : 4 parcours sur 3 tailles d'écran | PASS : 12 tests sous Chromium 153, sans relance automatique |
| Contrôle visuel | Captures du catalogue et de l'aperçu ordinateur/mobile examinées ; absence de débordement horizontal contrôlée |
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
comportements sur écran étroit. Le validateur partagé a reçu une expression booléenne
équivalente, compatible avec les réglages TypeScript différents du serveur et du site.

## Analyse d'impact et dépendances restantes

L'analyse initiale de `DashboardLayout` signale LOW (un appelant direct, deux symboles).
Les références d'`App` et de la liste de navigation ne sont pas toutes résolues ; elles
ont été contrôlées dans les sources. Après réindexation, plusieurs requêtes sur le
validateur, le guide et la fixture de test ont retourné le même ensemble très large,
CRITICAL (81 références directes, 104 éléments, 11 parcours), avec un type de cible
non résolu. L'interrogation par identifiant exact a échoué. Ce signal a été annoncé ;
il n'est pas traité comme une preuve précise de dépendances ni comme un feu vert.
La comparaison de code et les tests fournissent les vérifications complémentaires.
Une reconstruction complète de l'index a ensuite rétabli le ciblage du validateur :
son contrôle final retourne LOW, trois appelants directs et six symboles concernés.
Les parcours incomplets du graphe restent une limite de l'outil.
La détection finale retourne HIGH : 16 fichiers / 73 symboles / 7 parcours pour ce lot,
38 fichiers / 318 symboles / 11 parcours pour toute la branche par rapport à `main`.
Le diff correspond aux fichiers prévus ; la branche reste en revue avant toute fusion.

L'audit des dépendances relancé après ce lot conserve 14 alertes dans le site ; ses 141 erreurs
TypeScript globales demandent aussi un chantier distinct. Les dépendances KARTA
restent sans alerte déclarée, développement compris. Aucun fichier de dépendances du produit
n'est changé par ce lot.

Pour réaliser une première connexion matérielle, il reste à choisir le modèle et
le firmware exacts, obtenir les accès du propriétaire, développer le connecteur et
qualifier chaque commande sur le robot. L'autorisation et les limites du contrôleur
constructeur restent applicables. Le téléphone seul ne garantit pas cette compatibilité.
