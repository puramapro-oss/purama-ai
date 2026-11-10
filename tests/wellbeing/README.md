# Consentement et parcours bien-être

## Périmètre

Les tests montent les vrais composants `SpiritualLayer`, `Breathe`, `Gratitude`
et le vrai hook `useAwakening`. Seule l'identité d'authentification est simulée
avec deux comptes et un invité. Le navigateur exécute réellement les contrôles,
le minuteur, le stockage local et les changements de langue. Aucune connexion
à un fournisseur IA, aucun compte de production et aucune donnée personnelle
réelle ne sont utilisés.

Les parcours restent dans les composants et routes existants. Il n'y a ni
nouvelle application ni second moteur de mémoire.

## Corrections vérifiables

- Une connexion n'ouvre plus automatiquement une affirmation. Le bouton
  « Pause facultative » ouvre un choix explicite ; le contenu spirituel n'est
  montré qu'après sélection. Fermer, arrêter et Échap fonctionnent, avec retour
  du focus au déclencheur.
- Une transition de compte réinitialise les composants : pratique ouverte,
  ressenti et brouillon ne passent pas au compte suivant.
- La respiration reste naturelle, sans rétention ni rythme obligé. Le minuteur
  peut être suspendu, réellement repris et arrêté. Le masquage d'un onglet le
  suspend ; il ne repart qu'à la demande. La fin du minuteur est distincte de
  la confirmation par la personne qu'elle a terminé une pause.
- Les anciennes valeurs XP, niveau et série restent inertes pour conserver
  l'interface du hook. Les compteurs d'actions sont éphémères et ne mesurent
  pas la valeur morale, la spiritualité ou la santé. Ils ne donnent aucun
  crédit financier et ne modifient aucun quota commercial.
- Le journal est en mémoire par défaut. La conservation doit être choisie,
  est indexée par compte, et utilise une enveloppe versionnée indiquant
  explicitement la conservation sur l'appareil. Le retrait confirme une
  suppression seulement après succès de l'opération navigateur.
- Une écriture refusée conserve le brouillon ; une suppression refusée laisse
  visibles la note et l'option de conservation. Un document malformé ou
  appartenant à un autre compte n'est pas affiché ni écrasé automatiquement.
- Toutes les mutations persistantes utilisent un verrou Web Locks exclusif par
  compte. Ajouts et suppressions se recalculent sur le document courant sous
  ce verrou ; une liste périmée d'un autre onglet ne remplace jamais l'ensemble.
  L'activation de conservation vérifie sa version sous le même verrou et
  signale un conflit en conservant notes de séance et brouillon. La révocation
  est revérifiée avant écriture ; l'attente du verrou est annulée au démontage
  et bornée à cinq secondes.
- Les événements de stockage mettent à jour la lecture depuis la valeur la plus
  récente, sans effacer un brouillon. Une suppression de conservation retire la
  copie affichée dans les autres onglets ; un effacement général du stockage
  n'efface pas les notes qui étaient seulement en mémoire.
- Sans Web Locks, les mutations persistantes sont refusées explicitement. Un
  simple contrôle de version suivi d'une écriture n'est pas annoncé comme une
  transaction atomique. Le verrou coordonne les onglets qui utilisent ce même
  protocole ; il ne protège pas contre un script externe qui écrit directement
  dans le stockage.
- L'ancienne clé globale `purama_gratitude` n'est ni lue, ni migrée, ni effacée :
  elle ne permet pas d'identifier le propriétaire de ses notes. Sa récupération
  éventuelle demande une attribution explicite, hors de cette correction.

## Exécution

Depuis la racine du dépôt, avec les dépendances du projet et un Chromium
opérationnel :

```sh
PLAYWRIGHT_EXECUTABLE_PATH=/chemin/vers/chromium \
  ./node_modules/.bin/playwright test --config tests/wellbeing/playwright.config.ts
./node_modules/.bin/tsc --noEmit -p tsconfig.app.json
./node_modules/.bin/eslint src/components/shared/SpiritualLayer.tsx \
  src/hooks/useAwakening.ts src/pages/Breathe.tsx src/pages/Gratitude.tsx \
  src/lib/wellbeing-copy.ts src/lib/gratitude-journal.ts tests/wellbeing
```

Le serveur de vérification utilise le port local 4396 et ferme à la fin des
tests. Les composants ne sont pas remplacés par des copies dans le harnais.

## Résultat observé le 10 novembre 2026

- **PASS** : 21 scénarios distincts couverts avec Chromium 153.0.8010.0 : huit
  scénarios de pause, respiration, API et affichage passent sur leurs fichiers
  inchangés ; les treize scénarios journal sont rejoués après la dernière
  correction, 13/13 PASS en 23,4 secondes, exit 0.
- **PASS** : contrôle TypeScript après ajout du protocole de verrou, exit 0.
  La consolidation complète fait l'objet du contrôle final du dépôt.
- **PASS** : lint ciblé, aucune erreur ; trois avertissements Fast Refresh dans
  les fichiers de harnais uniquement.
- **PASS** : révision React ciblée — effets nettoyés, absence d'effets dans les
  fonctions de mise à jour d'état, données dérivées séparées, clés d'identité,
  labels et contrôle clavier, pas de dépendance supplémentaire.
- **PARTIEL** : textes et interactions français/anglais vérifiés. Les autres
  langues utilisent un contenu anglais explicitement marqué `lang="en"` ;
  aucune validation culturelle mondiale n'est annoncée.
- **NON TESTÉ** : authentification de production, déploiement et intégration
  complète dans toutes les surfaces PURAMA ONE.
- **NON TESTÉ** : efficacité sur le bien-être ou la santé. Une vérification
  logicielle ne démontre aucun bénéfice clinique ou spirituel.

### Régressions reproduites et reprises

Deux défauts ont été reproduits dans le navigateur avant leur correction :
une note ajoutée dans un onglet était écrasée par la liste ancienne d'un second
onglet ; un `localStorage.clear()` externe effaçait des notes uniquement en
séance. Les deux scénarios passent après correction.

Le premier run de vingt scénarios après ajout des verrous a donné seize PASS,
trois échecs de harnais et un timeout d'infrastructure pendant la création du
contexte navigateur, avant toute action produit. Les actions de harnais
`check()` qui supposaient une écriture synchrone ont été remplacées par un clic
suivi d'une assertion de l'état confirmé. Aucune assertion de résultat n'a été
supprimée. La reprise des treize scénarios journal utilise un timeout global de
soixante secondes pour la création du contexte sous charge ; les délais et
garanties du produit restent identiques.

Commande exacte de cette dernière reprise :

```sh
PLAYWRIGHT_EXECUTABLE_PATH=/tmp/purama-pub22-browser-8ivxs2a1/chromium \
  ./node_modules/.bin/playwright test \
  --config tests/wellbeing/playwright.config.ts --timeout=60000 \
  --grep 'journal is|device retention|denied storage|failed note|unowned legacy|deleting a saved|two tabs|stale tab|storage changes|queued append|conflicting retention|without Web Locks|clearing storage'
```

Référence du contrat Web Locks vérifié pour cette implémentation :
<https://developer.mozilla.org/en-US/docs/Web/API/LockManager/request>.

La conservation locale protège contre l'affichage entre comptes dans
l'interface ; elle ne chiffre pas les notes et ne protège pas contre une
personne ayant accès au profil du navigateur. Le choix de conservation le
précise et reste déconseillé sur un appareil partagé. Aucun contenu du journal
n'est envoyé à une IA par ces composants.
