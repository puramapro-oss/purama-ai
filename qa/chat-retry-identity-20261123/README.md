# Reprise d’un tour utilisateur confirmé

## Périmètre

Base examinée : `164dfad98c820e54758a35ba388035fcc008cb6f`.
Correction locale du chat : après sauvegarde utilisateur confirmée puis échec de génération, une relance identique réutilise le dernier tour de la même conversation et du même propriétaire. La demande n’est plus insérée deux fois, affichée deux fois ou envoyée deux fois dans le même contexte.

Une demande modifiée et une répétition volontaire après succès restent de nouveaux tours. Le changement de compte, la nouvelle conversation et le chargement d’un historique retirent la référence locale de reprise. Une réponse complète termine la reprise avant son écriture en base.

## Réception locale avant CI

| Vérification | Résultat |
| --- | --- |
| Reproduction avant correction sur le composant React réel | RED : une insertion utilisateur attendue, deux reçues |
| Fichier React final | PASS : 11 tests, dont 7 nouveaux et 4 existants ; aucun skip |
| TypeScript | PASS |
| ESLint ciblé sur les trois fichiers | PASS |
| Diff et configuration de branche | PASS ; déploiement automatique de cette branche désactivé |
| Collecte navigateur | 21 scénarios, dont 7 nouveaux et 14 existants |
| Exécution navigateur locale | NON TESTÉ : Chromium ne démarre pas, socket Unix refusé avant assertion produit |

Les journaux `red-react.log` et `green-react-full.log` permettent de relier le défaut au correctif. Le test ciblé est inclus dans les 11 tests finaux et ne doit pas être compté deux fois. `browser-collection.log` est une collecte, pas une preuve d’exécution. Le workflow existant `purama-chef-hardening.yml` exécute les tests React et navigateur ; sa réception sera inscrite dans la PR.

Commandes locales :

```bash
npm run test:distribution:unit -- src/components/ChatbotWidget.consultation.test.tsx
npm run typecheck
node node_modules/eslint/bin/eslint.js src/components/ChatbotWidget.tsx src/components/ChatbotWidget.consultation.test.tsx tests/chat/lifecycle.spec.ts
npm run test:chat -- --list
git diff --check
```

## Limites

Ce correctif suppose l’écriture utilisateur confirmée, ou un parcours invité sans persistance. Il ne résout pas une écriture dont l’accusé a été perdu, ni la reprise après rechargement. La relance explicite effectue une nouvelle inférence, potentiellement facturée. Les transports des tests sont simulés ; aucune API réelle, clé ou donnée privée n’a été utilisée.

L’audit APInex est distinct : cette correction n’active aucun nouveau fournisseur et ne démontre aucune économie APInex.
