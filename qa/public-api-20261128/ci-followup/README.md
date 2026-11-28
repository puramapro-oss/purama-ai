# Réception du harnais de déclenchement — 28 novembre 2026

**PASS — régression de harnais reproduite et corrigée.**

Base : `1a5cb5bda493bade5ff4bb13947f93c9ded20ca4`.
Seul fichier modifié : `tests/helpers/custom-trigger-harness.mjs`.
Aucun fichier produit ni aucune assertion de test n'a été modifié dans ce correctif.

## Défaut et correction

La source réelle du serveur KARTA importe désormais les routes et le runtime de l'API publique. Le harnais du déclenchement personnalisé conservait une liste d'imports autorisés antérieure ; son parcours intégré échouait donc avant l'exécution de la route testée.

Les deux nouveaux imports possèdent maintenant des ports inertes, comme les autres routes hors du périmètre de ce harnais. Leur gestionnaire et leur factory utilisent la fonction `unused`, qui lève une erreur en cas d'appel. Le démarrage fournit explicitement `publicApiRuntime: null` : cette simulation n'active pas l'API publique et n'expose pas le processus ou l'environnement hôte à la VM. La fonction `execute` et son assertion de liste d'imports fermée restent inchangées.

## Preuves

| Contrôle | Résultat | Journal |
|---|---|---|
| Reproduction avant correction, suite React ciblée | 36 PASS, 1 échec attendu : `Unexpected import ./public-api-routes.js` | `trigger-before.log` |
| Suite de distribution complète après correction | 918/918 PASS, 47 fichiers, sortie 0 | `distribution-after.log` |
| Route de déclenchement Node avec `KARTA_PUBLIC_API_ENABLED=true` dans l'environnement hôte | 56/56 PASS, sortie 0 | `trigger-node-after.log` |
| Index GitNexus rafraîchi avant édition | PASS, 15,5 s | `gitnexus-index.log` |
| Impact préalable `customTriggerHarness` et `execute` | LOW, aucun processus produit identifié | `impact-harness.log`, `impact-execute.log` |
| Détection du changement | Un fichier, trois symboles associés au diff, risque low | `detect-changes.log` |
| `git diff --check` | PASS | `receipt.json` |

L'index ne liste pas l'appelant React ; la lecture ciblée confirme les deux consommateurs `src/hooks/useCreatorAgentKarta.trigger.test.tsx` et `tests/karta-trigger-custom.test.mjs`. Le résultat d'impact de `execute` conserve les limites de résolution des appels génériques signalées par GitNexus. Le diff final ne modifie que la composition de `customTriggerHarness`.

SHA-256 du harnais corrigé : `3fadf233f518b922d2f39625bce4f63551066dd281439fd56b2196476650e810`.

`receipt.json` contient les commandes, sorties, empreintes des sources et journaux. Ces preuves couvrent le harnais local ; elles ne prétendent ni à un appel fournisseur réel, ni à un déploiement de production. La réception CI du commit suivant appartient au suivi de la PR.
