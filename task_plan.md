# PURAMA AI — Task Plan V3

## P1 - Structure+Auth+DB ✅ (pré-existant)
## P2 - Features core ✅ (6 agents IA, dashboard, pricing)
## P3 - Universels ✅
- [x] Wallet + Transactions + Retrait IBAN
- [x] Points Purama + Boutique + Classement
- [x] Daily Gift (coffre quotidien animé)
- [x] Loterie / Tirage mensuel
- [x] Partage social multi-plateforme
- [x] Cross-promo / Ecosystem
- [x] Streak multiplier
- [x] FAQ / Aide

## P4 - Admin+Guide ✅
- [x] Admin dashboard (pré-existant avec vrais données)
- [x] Page Guide tutoriel (8 étapes interactives)

## P5 - Design+Anim ✅
- [x] Cinématique intro (3.5s, skip, localStorage)
- [x] Aurora BG, noise overlay, glass V3 CSS
- [x] Intégration wallet/points/gift dans dashboard
- [x] Cross-promo bannières dans dashboard
- [x] Sidebar mise à jour (7 nouveaux liens)

## P6 - Audit ✅
- [x] Playwright E2E tests — 52 tests, 3 viewports (1920/768/375), 0 échec
- [x] tsc --noEmit 0 erreur
- [x] npm run build 0 erreur
- [x] grep console.log/TODO = 0
- [x] grep sk_live/password/secret = 0 (que du code auth légitime)
- [x] 8 suites de tests : public-pages, navigation, responsive, console-errors, performance, forms-validation, accessibility, pwa
- [x] Sécurité CRITICAL fixes (2026-07-25):
  - [x] Zod validation 10 edge functions AI (agent-chat, creator-agent-chat, legal-chat, creator-agent-run, legal-build-case, chat, chatbot)
  - [x] Rate limiting AI endpoints (20 req/h chat, 10 req/h agent-run, 30 req/h chatbot)
  - [x] A11y fixes (aria-label Login/Signup Google button, aria-expanded pricing toggle)
  - [x] ErrorBoundary React app (react-error-boundary)
- [ ] Lighthouse (audit live après deploy)
- [ ] i18n 16 langues (hors scope P6 — feature future)

## P7 - Mobile Expo (iOS + Android) 🔄
- [x] Expo 54 project init (mobile/)
- [x] expo-router file-based routing (app/, (tabs), (auth))
- [x] NativeWind + Tailwind config
- [x] Supabase client with SecureStore adapter (0 window/localStorage direct)
- [x] Auth context (email + Google OAuth via WebBrowser)
- [x] 5 tab screens: Dashboard, Agents, Wallet, Points, Settings
- [x] Agent chat screen with n8n integration
- [x] Auth screens: Login, Signup, Forgot Password, OAuth Callback
- [x] UI components: GlassCard, Button, Input, Badge, EmptyState, LoadingScreen
- [x] Hooks: useAuth, useWallet, usePoints, useDailyGift, useAgents
- [x] app.json + eas.json (bundle dev.purama.purama_ai)
- [x] App icons generated (icon, adaptive, splash, favicon, notification, feature-graphic)
- [x] TypeScript strict — 0 erreur
- [x] 0 window/localStorage/document sans Platform.OS guard
- [x] 10 Maestro test flows (auth, signup, navigation, agents, agent-chat, wallet, settings, onboarding, daily-gift, error-handling)
- [x] store.config.json 16 langues (fr, en, es, de, it, pt, ar, zh, ja, ko, hi, ru, tr, nl, pl, sv)
- [x] GOOGLE_PLAY_SETUP.md (guide 3 minutes)
- [x] EAS Workflows (.eas/workflows/full-deploy.yaml)
- [x] GitHub Actions (build-submit.yml + ota-update.yml)
- [ ] EAS build iOS + Android (necessite Apple Team ID + Google Service Account)
- [ ] EAS submit to stores (necessite premier build)
