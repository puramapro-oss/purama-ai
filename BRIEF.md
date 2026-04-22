palette_seed: 'tech-cyber-purama-ai'

# BRIEF — Purama AI

## Positionnement
**Purama AI** est la vitrine de l'écosystème Purama. App-type ChatGPT multi-agents :
5 agents IA autonomes (Email, Compta, Juridique, Partenariat, Créateur d'agents)
travaillent pour l'utilisateur.

Premier screenshot affiché au jury Afnic (ordre de traitement PART 4 du
PURAMA_MASTER_UPGRADE — prio 1).

## Domaine
Multi-IA / SaaS B2B. UX proche de ChatGPT / Linear / Arc :
chat plein écran, sidebar clean, 0 distraction, futuriste sans tape-à-l'œil.

## Features principales (existantes)
- 6 agents IA (Email, Compta, Juridique, Partenariat, Créateur, Social)
- Dashboard + sidebar + bottom tab mobile
- Pricing 4 plans (Free, Starter, Pro, Ultime) · bandeau /financer (45 aides)
- /financer wizard 4 étapes avec PDF jsPDF réel
- /ecosystem cross-promo + CROSS50
- Parrainage 3 niveaux · Wallet · Points · Daily Gift · Boutique · Concours · Tirage
- i18n 16 langues (FR, EN, ES, DE, IT, PT, AR, ZH, JA, KO, HI, RU, TR, NL, PL, SV)
- Dark/Light via next-themes
- PWA manifest + service worker
- Auth Supabase email + Google OAuth
- CGU / CGV / Mentions légales / Politique confidentialité / Cookies
- Playwright 52 tests

## V7.1 + V4.1 (avril 2026)
- `.claude/agents/` qa + security
- Stripe Connect Express + Embedded Components (endpoint `connect-account-session`)
- Primes Phase 1 / Phase 2 alignées sur paiements abo (table `primes` + CRON)
- Fiscal Assistant 4 profils + INSEE SIRET (clé universelle Purama)
- OpenTimestamps (Bitcoin) pour règlements jeux-concours → page `/reglement`
- Palette seed `tech-cyber-purama-ai` → `<PuramaBackground />` prêt à câbler

## Mobile Expo (P7 — bloqué)
- Bundle `dev.purama.purama_ai`, Expo 54, NativeWind, SecureStore adapter
- 14 écrans prêts, 10 flows Maestro, icônes générées
- **Blocker** : `APPLE_TEAM_ID` manque dans les credentials → pas de EAS build/submit tant que la SASU n'a pas d'Apple Developer + Google Service Account.

## Credentials
Voir `~/purama/CLAUDE.md` §17 — clés globales Purama.
Variables Vite locales :
- `VITE_PALETTE_SEED=tech-cyber-purama-ai`
- `VITE_APP_SLUG=purama-ai`
- `VITE_SUPABASE_URL=https://auth.purama.dev`
- `VITE_SUPABASE_ANON_KEY=…` (voir .env.local)
