---
description: Teste purama-ai comme un vrai user — suite complète 22 points humains + Playwright
---

Parcours complet de tests humains simulés sur `purama-ai`.

## PHASE 1 — TESTS STATIQUES (5 min)
```bash
npx tsc --noEmit
npm run build
grep -rn "TODO\|FIXME\|placeholder\|coming soon\|Lorem\|console\.log\|: any" src/ | grep -v ".spec.ts" | head -20
grep -rn "sk_live\|POSTGRES_PASSWORD\|SERVICE_ROLE" src/ | head -5
grep -rn "originstamp\|terra\.api\|STRIPE_CONNECT_CLIENT_ID" src/ | head -5
```
Attendu : 0 résultat partout, build 0 erreur.

## PHASE 2 — PLAYWRIGHT E2E (15 min)
```bash
npx playwright test --project=chromium
```
Couverture obligatoire : `public-pages`, `navigation`, `responsive` (375/768/1440), `console-errors`, `forms-validation`, `accessibility`, `pwa`, `performance`.

## PHASE 3 — 22 POINTS HUMAINS

1. Ouvrir nav privée https://purama-ai.purama.dev → charge <3s ?
2. Hero : h1 lisible, 1 CTA clair, pas de texte FR résiduel si EN choisi
3. Cliquer CHAQUE lien nav + sidebar + footer → 0 bouton mort
4. /signup → email test@test.dev → email confirmation reçu (Resend) → lien fonctionne
5. /login Google OAuth → redirect → retour dashboard OK (pas "provider not enabled")
6. Dashboard : widgets chargent, wallet + points visibles, liens sidebar tous actifs
7. /financer wizard 4 étapes : profil + situation → aides matchées → PDF généré vraiment (pas fake)
8. /pricing : 4 plans visibles, prix cohérents, bouton "Essai 14j" → Stripe Checkout (test mode OK)
9. /aide : chatbot répond, formulaire escalade → email reçu
10. /parrainage : lien copiable, QR code rendu, compteur filleuls
11. /wallet : solde, historique, bouton retrait (grisé si <20€ ou feature flag phase1)
12. /ecosystem : autres apps affichées, code CROSS50 copiable
13. Thème : dark → light → dark, change VISUELLEMENT, persiste après refresh
14. Langue : FR → EN → ES → toutes les pages visitées changent (pas juste settings)
15. Responsive 375px : aucun overflow, bottom tab OK, sidebar masquée
16. Responsive 768px : layout tablet correct
17. Responsive 1440px : sidebar + contenu, pas de zone vide
18. Console DevTools : 0 erreur JS, 0 warning React critique
19. Network : 0 requête 404/500, Supabase auth OK
20. Déconnexion : bouton signOut → redirect /login, localStorage nettoyé
21. /reglement (V4.1) : hash OpenTimestamps affiché, bouton "Vérifier" fonctionne
22. /fiscal (V4.1) : 4 profils sélectionnables, flow adapté selon choix

## RAPPORT

```
TEST FULL — purama-ai — [DATE]
PHASE 1 : ✅/❌
PHASE 2 : X/Y specs pass
PHASE 3 : X/22 points
ÉCHECS : [liste]
VERDICT : OK DEPLOY / FIX REQUIS
```
