# ERRORS.md — Purama AI

| DATE | BUG | CAUSE | FIX |
|------|-----|-------|-----|
| 2026-07-25 | Edge functions manquent validation Zod | Aucune validation stricte requêtes AI | Ajout ChatMessageSchema + AgentRunSchema + validateBody() dans _shared/validation.ts, appliqué à 10 fonctions AI critiques |
| 2026-07-25 | Edge functions sans rate limiting | Abus possible endpoints AI (coût Claude API) | Ajout rate-limit.ts in-memory (Deno-compatible), 20 req/h chat, 10 req/h agent-run, 30 req/h chatbot public |
| 2026-07-25 | Boutons Google OAuth sans aria-label | A11y WCAG violation | Ajout aria-label + aria-hidden sur SVG dans Login.tsx + Signup.tsx |
| 2026-07-25 | Toggle comparaison pricing sans aria-expanded | A11y WCAG violation | Ajout aria-label + aria-expanded dans PricingSection.tsx |
| 2026-07-25 | App React sans ErrorBoundary | Crash non géré → écran blanc | Ajout react-error-boundary wrapping <Routes>, fallback FR avec bouton reload |
