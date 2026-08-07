# PURAMA — CLAUDE.md V13 CORE (Tier 1)
> Règles UNIVERSELLES toutes apps. Détails techniques → `~/purama/SKILLS/*.md` chargés à la demande (cf §8).

## 0. PROFIL & MASTER PROTOCOL
Dev solo 15ans Google+Apple+Stripe. 0 question, 0 intervention. Plan→montrer→"ok"→exécuter feature/feature. 10× réflexion>code. Architecte+dev+QA+DevOps+designer+CTO.
**MASTER PROTOCOL — ZÉRO ERREUR ZÉRO OUBLI**:Claude Code=CTO senior 15 ans exp. JAMAIS code en autopilote. Chaque ligne RÉFLÉCHIE+VÉRIFIÉE+TESTÉE. JAMAIS étape suivante sans avoir PROUVÉ étape actuelle 100% terminée+fonctionnelle.
**Réflexion obligatoire avant CHAQUE action**:1.POURQUOI? 2.QUEL IMPACT(grep -r avant modifier)? 3.QUELS CAS D'ERREUR(input vide,timeout,404,auth expiré,offline,concurrent)? 4.COHÉRENT avec reste(types,routes,imports,DB)? 5.SI PLANTE que voit user(jamais écran blanc→message FR+solution)? Si tu ne peux pas répondre aux 5→STOP réfléchis.
**ZERO SKIP RULE**:Claude Code ne saute JAMAIS étape. CHAQUE instruction CLAUDE.md+CHAQUE point BRIEF+CHAQUE feature task_plan.md DOIT être implémentée. "Skip"/"plus tard"/"session dédiée"/"hors scope"=INTERDIT. >50% contexte→`/compact` continuer. >70%→commit+deploy ce qui est fait+nouvelle session pour suite. JAMAIS abandonner feature.
**Auto-correction + Auto-diagnostic**:bug→1.ERRORS.md(fix connu?) 2.grep -r 3.tsc --noEmit 4.console.log temp→fix→supprimer 5.context7 lib doc 6.3 échecs→`/clear`. Bug fixé→IMMÉDIATEMENT ligne `|DATE|BUG|CAUSE|FIX|` dans ERRORS.md. Avant coder→LIRE ERRORS.md+PATTERNS.md+LEARNINGS.md.
**ADAPTATION**:BRIEF=expert domaine(finance→trader|santé→médecin|juridique→avocat|vidéo→réalisateur). UX domaine-native. Contenu RÉEL(0 Lorem). Edge cases anticipés.

## 1. PIPELINE — ARCHI→CODE→REVIEW→TEST→FIX→DEPLOY
**ARCHI**:Lire BRIEF 3×→lister pages/APIs/tables→cohérence→task_plan.md→MONTRER plan→attendre "ok".
**CODE**:Fichier complet, imports vérifiés, API try/catch+auth+Zod, composants loading+error+empty+responsive 375px+dark. 1 feature/fois. Ordre lib/→hooks/→ui/→components/→pages/→API/.
**REVIEW**(anti-pattern):aucun fichier>300 lignes|aucun composant>5 props required|aucun catch vide|aucun `any`|aucun secret hardcodé|aucun useEffect sans cleanup|aucun fetch sans error+loading|aucun TODO/FIXME. PURAMA:IA=NOM_APP jamais Claude|super-admin gold #FFD700+God Mode|design tokens §4|bundle dev.purama.{SLUG}|RLS toutes tables|rate limit toutes API|favicon+OG customisés|meta SEO. **1 anti-pattern→fix IMMÉDIAT**.
**TEST**:5 niveaux→tsc 0+build 0+Playwright 100%+Lighthouse>90+sub-agents qa+security 0 critical. Détails→SKILL TESTING.
**FIX**:1 erreur→corriger MAINTENANT avant feature suivante. Bug fixé→ligne dans ERRORS.md. Avant coder→LIRE ERRORS.md.
**DEPLOY**:Web `vercel --prod`(SKILL DEPLOY). Mobile `eas build+submit`(SKILL NATIVE). 1 niveau échoue=JAMAIS deploy.

## 2. CONSTITUTION — 16 LOIS
1.Plan d'abord→montrer→"ok"→exécuter feature/feature 2.Terminé=prouvé→PW 0 échec+TEST HUMAIN 3.0 placeholder/TODO/Lorem/console.log/`any`/faux contenu 4.Tester avant avancer 5.Impact avant modifier→`grep -r` ou GitNexus 6.context7/Tavily AVANT inventer (JAMAIS halluciner API) 7.Secrets jamais client→seul `NEXT_PUBLIC_` exposable 8.Auth complète→email+OAuth VPS activé,30j,signOut+clear+redirect,middleware 9.Chaque bouton fonctionne(0 mort) 10.3 échecs→ERRORS.md→/clear 11.`'use client'` chaque composant interactif+export default+`?.`optional chaining 12.Adaptation domaine 13.Cohérence totale→1 source vérité 14.Flux A→Z 0 impasse(aller+retour) 15.Erreurs FR explicites+solution(jamais "Error 500") 16.PROGRESSIVE DISCLOSURE(§8).
**Loi 17 PARALLEL MODE**(opt-in):Si BRIEF contient `PARALLEL:true`→toucher QUE fichiers du bloc OWNERSHIP. JAMAIS modifier hors OWNERSHIP même "juste 1 import". Lecture seule si besoin. Créer CONTRACTS.md(interfaces partagées,types,props,endpoints,tables). Conflit inévitable→STOP+écrire "CONFLIT:[desc]" dans task_plan.md+attendre Tissma. Si PARALLEL absent=mode normal.

## 3. INTERDICTIONS ABSOLUES
- JAMAIS faux avis/témoignages/chiffres/logos→compteurs DB(0 si 0)
- JAMAIS dire "terminé" sans avoir TESTÉ CHAQUE BOUTON
- JAMAIS landing 13 sections→écran APP(logo+CTA comme ChatGPT)
- JAMAIS Pollinations dans design app→Lucide+gradients CSS
- JAMAIS OAuth non testé en VRAI(pas juste bouton existe)
- JAMAIS "construis tout A→Z"→1 feature→test→suivante
- JAMAIS multi-tâche (partial=source #1 bugs)
- JAMAIS prix/€/abonnement UI iOS native (Apple rejette→SKILL NATIVE)
- JAMAIS env var via dashboard Vercel→CLI ONLY (SKILL DEPLOY)
- JAMAIS coder sans lire task_plan+ERRORS+PATTERNS début session
- **DESIGN=APP**:sidebar desktop+bottom tabs mobile+chat plein écran. Login=card glass max-w-md|Dashboard=sidebar 280px+grid cards|Chat=h-screen flex-col|Settings=glass cards.

## 4. DESIGN TOKENS GOD MODE V3
**Background**:`#0A0A0F` base, `#14141C` soft. **Foreground**:`#F5F5FA`, muted `rgba(245,245,250,0.6)`. **Primary** défaut Purama:`#7C3AED` violet (override par app dans globals.css). **Secondary** défaut:`#06B6D4` cyan. **Super-admin gold**:`#FFD700`. **Glass**:`bg rgba(255,255,255,0.05); backdrop-filter blur(20px) saturate(150%); border 1px rgba(255,255,255,0.06); border-radius 1.5rem`. **Gradient**:`linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%)`. **Radii**:sm 0.5|md 1|lg 1.5|xl 2|pill 9999rem. **Shadow glow**:`0 0 60px color-mix(in srgb, var(--primary) 30%, transparent)`. **Body ambiance**:radial 8% primary top + radial 6% secondary bottom-right.
**Anti-AI-slop** (3 questions avant CHAQUE composant):1.Ressemble vraie app pro du domaine?(trading=Robinhood|wellness=Calm|juridique=Notion) 2.2 apps Purama auraient ce design?(oui=REFAIRE) 3.Designer senior dirait "AI slop"?(oui=REFAIRE).

## 5. ENV VARS COMMUNES
```
# Supabase (auth.purama.dev — schéma {SLUG})
NEXT_PUBLIC_SUPABASE_URL=https://auth.purama.dev
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzQwNTI0ODAwLCJleHAiOjE4OTgyOTEyMDB9.GkiVoEuCykK7vIpNzY_Zmc6XPNnJF3BUPvijXXZy2aU
SUPABASE_SERVICE_ROLE_KEY=[.env.secrets]
NEXT_PUBLIC_SUPABASE_DB_SCHEMA={SLUG}
POSTGRES_PASSWORD=[.env.secrets]
POSTGRES_HOST=72.62.191.111

# IA (cf SKILL AI)
ANTHROPIC_API_KEY=[.env.secrets]
ANTHROPIC_MODEL_MAIN=claude-sonnet-4-6
ANTHROPIC_MODEL_FAST=claude-haiku-4-5-20251001
ANTHROPIC_MODEL_PRO=claude-opus-4-7
OPENAI_API_KEY=[.env.secrets]

# Stripe (cf SKILL PAYMENTS)
STRIPE_SECRET_KEY=[.env.secrets]
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=[.env.secrets]
STRIPE_WEBHOOK_SECRET=

# Vercel + DNS (cf SKILL DEPLOY)
VERCEL_TOKEN=[.env.secrets]
DOMAIN=purama.dev

# Resend
RESEND_API_KEY=[.env.secrets]
RESEND_FROM_EMAIL=hello@{SLUG}.purama.dev

# Monitoring
SENTRY_AUTH_TOKEN=[.env.secrets]
SENTRY_ORG=purama
NEXT_PUBLIC_POSTHOG_KEY=phc_H3oYKeaaJrx801AZsZmZCzUZEpMH048ysKOqg9Mig1H
NEXT_PUBLIC_POSTHOG_HOST=https://eu.i.posthog.com
BETTERSTACK_API_KEY=[.env.secrets]
UPSTASH_MANAGEMENT_API_KEY=[.env.secrets]
UPSTASH_EMAIL=matiss.frasne@gmail.com

# OAuth
GOOGLE_CLIENT_ID=897200950419-dh86vocgp1ii0csj4eer6jjkqrh00oe7.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=[.env.secrets]

# Mobile
EXPO_TOKEN=[.env.secrets]
APPLE_TEAM_ID=___à_remplir___
APPLE_ID=matiss.frasne@gmail.com
GOOGLE_SERVICE_ACCOUNT=./google-service-account.json

# Outils
TAVILY_API_KEY=[.env.secrets]
PINECONE_API_KEY=[.env.secrets]
ZERNIO_API_KEY=[.env.secrets]
ZERNIO_BASE_URL=https://zernio.com/api/v1
INSEE_API_KEY=[.env.secrets]
PAPPERS_API_KEY=[.env.secrets]
CRON_SECRET=
```
**CLI rules**:INTERDIT `vercel login`/`gh auth login` interactif→`--token $VERCEL_TOKEN --scope puramapro-oss --yes`. VPS `sshpass -p '[.env.secrets→VPS_SSH_PASSWORD]' ssh root@72.62.191.111`. Team Vercel `team_dGuJ4PqnSU1uaAHa26kkmKKk`. n8n `n8n.srv1286148.hstgr.cloud` (57 workflows).

## 6. RÈGLES D'ARRÊT
**task_plan.md**:phases P0→P8 cochables ✅/❌. Update APRÈS CHAQUE feature. **ERRORS.md+PATTERNS.md**:créés P0. ERRORS=`|DATE|BUG|CAUSE|FIX|`. Bug fixé→ligne IMMÉDIATE. **LEARNINGS.md** global `~/purama/`:`|DATE|APP|LEÇON|IMPACT|`.
**Context monitoring**:>50%→`/compact` continue|>60%→finir feature→commit→deploy→handoff "Relance-moi"|3 échecs même bug→ERRORS.md→`/clear`. JAMAIS dépasser 60%.
**Handoff OBLIGATOIRE avant arrêt**:1.Update task_plan ✅/❌ 2.progress.md état exact 3.ERRORS+PATTERNS 4.Commit+deploy ce qui marche 5."✅ P[X] terminé. Relance-moi P[X+1]." ou "✅ TERMINÉ" 6.Rapport `📋[APP]—[DATE] FAIT|RESTE|BUGS|DEPLOY|NEXT|LEARNINGS`.
**Début session**:1.Lire task_plan+progress+ERRORS+PATTERNS 2.tsc+build vérifier 3.Re-lire CLAUDE.md 4.Charger SKILLS pertinents (§8) 5.Continuer feature suivante. JAMAIS recoder ce qui marche. JAMAIS casser existant.

## 7. WORKFLOW P0→P8
P0:Setup+lecture BRIEF 3×+task_plan+schema.sql+MONTRER plan+"ok"|P1:Structure+Auth+DB→tester auth email+Google OAuth EN VRAI→deploy|P2:Features core(BRIEF) 1/1→tester chaque→deploy|P3:Universels(parrainage,wallet,points,cross-promo)→tester→deploy|P4:Admin+Aide+FAQ+chatbot SAV→tester→deploy|P5:Design polish+Animations+i18n 16 langues→tester→deploy|P6:QA sub-agent(21 SIM)+security sub-agent→Lighthouse>90→deploy|P7:Mobile Expo(SKILL NATIVE)→EAS→stores|P8:Watch si app santé(SKILL NATIVE).

## 8. RÈGLE 16 — PROGRESSIVE DISCLOSURE (13 SKILLS)
**Lire BRIEF d'abord→charger UNIQUEMENT SKILLS pertinents**. JAMAIS tout charger (token waste).

| SKILL | Charger quand BRIEF mentionne... |
|---|---|
| `~/purama/SKILLS/SUPABASE.md` | auth/DB/RLS/migrations/Edge Functions/OAuth/realtime/storage/PostgREST/triggers |
| `~/purama/SKILLS/PAYMENTS.md` | paiement/Stripe/abo/webhook/parrainage/wallet/KARMA 50/10/40/Treezor/OpenTimestamps/INSEE/SIRET/setup auto produits/pricing concurrents/Apple Sign-In/challenge stake jackpot |
| `~/purama/SKILLS/NATIVE.md` | mobile/iOS/Android/Expo/EAS/HealthKit/Health Connect/temps écran/Watch/App Store/SecureStore |
| `~/purama/SKILLS/AI-INTEGRATION.md` | IA/Claude/OpenAI/Whisper/ElevenLabs/RunPod/Suno/RAG/Pinecone/voix/system prompts/mémoire conversationnelle/mode démo/versioning prompts/insights/ERROR_MESSAGES/cost optimization |
| `~/purama/SKILLS/SOCIAL.md` | réseau social/Zernio/cross-promo/écosystème/n8n autopilot |
| `~/purama/SKILLS/TESTING.md` | tests/Playwright/Maestro/Lighthouse/sub-agents qa+security/21 SIM/feature gates/regression guardian |
| `~/purama/SKILLS/DEPLOY.md` | deploy/Vercel/DNS/monitoring/auto-healing/rollback/env vars CLI/plugins+MCPs/CRONs |
| `~/purama/SKILLS/DESIGN.md` | design/UI/UX/landing page/responsive/dark mode/animations/glassmorphism/12 univers visuels/footer/typo/branding |
| `~/purama/SKILLS/UI-COMPONENTS.md` | Hero3D/Three.js/Framer/PWA InstallBanner/Service Worker/composants critiques code/animations CSS keyframes/MagneticButton/CursorGlow |
| `~/purama/SKILLS/EMAILS.md` | email/Resend/onboarding séquence/transactional/revenue recovery J1-J7/relance/win-back/RGPD unsubscribe |
| `~/purama/SKILLS/GAMIFICATION.md` | achievements/badges/XP/tirage au sort/lottery/tickets/concours/leaderboard/cross-promo CROSS33/notifications push/partage social/affiliation N1+N2 |
| `~/purama/SKILLS/UX-FEATURES.md` | favoris/bookmarks/offline/Web Share/haptic/voice/PDF/QR/Realtime/Cmd+K/multi-thème OLED/PWA shortcuts/WCAG/philosophie/naming spirituel |
| `~/purama/SKILLS/LIB-UTILS.md` | lib utils/middleware auth/headers sécurité CSP/OG image/social login Apple GitHub/calendar ICS/widget embarquable/Zod schémas/toast Sonner/loading-error-empty states |

**Pattern invocation**:`@~/purama/SKILLS/SUPABASE.md` `@~/purama/SKILLS/DESIGN.md` (uniquement pertinents).
**Cas typiques**:BRIEF trivial sans backend→CLAUDE.md+DESIGN+LIB-UTILS|App santé→SUPABASE+NATIVE+AI+TESTING+DEPLOY+DESIGN+UI-COMPONENTS+GAMIFICATION+UX-FEATURES+LIB-UTILS+EMAILS|App finance→SUPABASE+PAYMENTS+AI+TESTING+DEPLOY+DESIGN+UI-COMPONENTS+EMAILS+LIB-UTILS|App mobile-first→+NATIVE|Toutes apps prod→TESTING+DEPLOY+LIB-UTILS+EMAILS systématique. **Charge MAX 6-8 SKILLS simultanés**, recharge dynamiquement si besoin.
**Note**:SKILLS du repo `purama-template` (business/design-code/spiritual/purama-system/wealth-engine) sont des PRESETS d'app. Ceux d'ici sont des MANUELS techniques. Ne pas confondre.

## 9. RÉSOLUTIONS — REGISTRE D'AUTORITÉ
1.**SPLIT KARMA**:50/10/40 (50% users|10% asso|40% SASU). Anciens 50/10/10/30 et 50/20/30 OBSOLÈTES.
2.**PARRAINAGE V4**:N1=50% premier paiement+carte à vie. Ancien "surplus CPA" OBSOLÈTE.
3.**MODÈLES IA**:claude-sonnet-4-6(main)|claude-haiku-4-5-20251001(fast)|claude-opus-4-7(pro). Génériques OBSOLÈTES.
4.**CPA**:Universel 250-265€/user. Carte complète 365-665€/user.
5.**RÉTRACTATION**(15/04/2026):Art L221-28 3° waiver implicite par clic, ZÉRO checkbox. Prime wallet only+retrait bloqué 30j+annulation<30j=prime déduite.
6.**AGENTS V13**:qa-agent(22 points)+security-agent(severity).
7.**OPENTIMESTAMPS**(21/04/2026)>OriginStamp(retired 31 mai 2025).
8.**SANTÉ NATIVE**(21/04/2026):HealthKit+Health Connect>Terra API($399/mois OBSOLÈTE).
9.**TEMPS D'ÉCRAN**(21/04/2026):iOS FamilyControls+DeviceActivity / Android UsageStatsManager natif.
10.**STRIPE CONNECT**(19/04/2026):Embedded Components. PAS besoin STRIPE_CONNECT_CLIENT_ID.
11.**INSEE SIRENE**(06/04/2026):1 clé couvre tout l'écosystème.
12.**WORKFLOW**:V13(Agentic)>V6 en cas de conflit.

## 10. JURIDIQUE — INFO STRUCTURELLE
TOI→CCA 1500€/m+IK Tesla 667€/m−charges 109€/m=**2058€/m net** (0 URSSAF, 0 IR). HOLDING SAS→dividendes SASU régime mère-fille 95% exo→IS 1,25%. SASU PURAMA→exploite 100 apps→IS 0% ZFRR 5 ans puis ~3%. ASSO PURAMA→reçoit Solidaire 5%+mécénat→0% IS dons→remise IS 60% SASU. SCI future→loue SASU(déductible)→protège patrimoine.
**6 boucliers IS**:B1 ZFRR Frasne 25560 0% IS 5 ans|B2 JEI exo charges R&D|B3 CIR 30%|B4 IP Box 10% IS algos|B5 Mécénat 60% réduction max 20K€|B6 Holding 95% exo. **IS combiné 0-3% à vie.**
**TVA**:non applicable art 293B CGI franchise (CA<85800€/an services). Mention obligatoire factures.

## 11. ARCHITECTURE src/ (toutes apps)
**src/app/**:`layout.tsx,page.tsx,globals.css,not-found.tsx,error.tsx`|**(auth)/**:`login,signup,callback,forgot-password,reset-password`|**(dashboard)/**:`layout,dashboard,chat,chat/[id],referral,wallet,contest,lottery,achievements,profile,settings,settings/abonnement,notifications,invoices,guide,classement,financer,fiscal,[SPÉCIFIQUES]`|**(ambassadeur)/**:`ambassadeur,apply`|**(admin)/**:`admin/users,admin/payments,admin/withdrawals,admin/influencers,admin/financement,admin/logs,admin/health`|**statiques**:`pricing,aide,go/[slug],ecosystem,how-it-works,status,changelog,privacy,terms,legal/*,offline,subscribe,confirmation,p/[slug],share/[code],scan/[code],partenariat,partenaires,impact,resultats`|**api/**:`status,health,stripe/(checkout+webhook+portal+setup),ai/(chat+demo+judge),referral,wallet/(balance+withdraw),ambassadeur,admin,email,cron/(account-deletion+wallet-confirm+trial-will-end+stats+backup+churn+health),og,v1/*,setup/stripe,setup/dns,karma`.
**components/**:`ui/`(Button,Input,Card,Modal,Badge,Skeleton,Avatar,Dropdown,Tabs,Toggle,Tooltip,ProgressBar,EmptyState,ErrorState,AnimatedCounter,MagneticButton,Confetti,Spinner,Switch)|`layout/`(Header,Sidebar,BottomTabBar,Footer,MobileNav,SearchModal,InstallBanner,CursorGlow,PageTransition)|`landing/`(Hero,Hero3D,Features,HowItWorks,Testimonials,SocialProof,CTASection,FAQ,ScrollRevealText,StickyScroll,ParallaxSection,DeviceMockup,AppleScrollReveal)|`shared/`(ErrorBoundary,ThemeProvider,SupabaseProvider,ParticleBackground,CookieBanner,TutorialOverlay,CinematicIntro,SpiritualLayer,SubconsciousEngine)|`wallet/`(WalletPhase1,WalletPhase2,CardTeaser,CardActivation,PrimeTracker,SmartSplit,PrimeCheckout)|`engagement/`(StreakCounter,MultiplierBadge,SeasonBanner,PuramaScore,SocialFeed,ImpactDashboard,Flywheel,AmbassadorTier)|`fiscal/`(FiscalBanner,FiscalPage,AnnualSummaryPDF)|`chat/`(ChatInterface,Message,MessageInput,VoiceRecorder,Sidebar)|`pricing/`(PricingCard,PricingTable,DiscountBanner)|`notifications/`(NotificationBell,NotificationList,PushPermission)|`tutorial/`(TutorialStep,TutorialOverlay,Spotlight)|`admin/`(StatsCard,UserTable,PaymentTable,WithdrawalQueue).
**hooks/**:`useAuth,useWallet,useRealtime,useReferral,useTheme,useSearch(Cmd+K),useAwakening,useEmpowerment,usePhase,useMultiplier,usePrime,useNatureScore,useAchievements,useNotifications,useHaptic,useLocalStorage,useDebounce,useIntersection,useMediaQuery`.
**types/**:`database.ts(supabase gen types),api.ts,domain.ts`.
**lib/**:`supabase.ts(createClient/createServiceClient),supabase-server.ts,claude.ts(askClaude/streamClaude/askClaudeJSON,3 tiers),stripe.ts(PLANS+createCheckout),utils.ts(cn,formatPrice,formatDate,getGreeting,getInitials,stringToColor,copyToClipboard,isSuperAdmin),constants.ts(SUPER_ADMIN_EMAIL,WALLET_MIN=5,COMPANY_INFO SASU PURAMA 8 Rue Chapelle 25560 Frasne art 293B),resend.ts(sendWelcomeEmail/sendCommissionEmail/sendPaymentFailedEmail/sendContestResultEmail/sendWithdrawalEmail/sendWeeklyRecap),karma.ts(splitRevenue 50/10/40),zernio.ts(publishToZernio/trackEvent),awakening.ts,phase.ts,opentimestamps.ts,health.ts(HealthKit+Health Connect abstraction),screen-time.ts,cron-auth.ts`.
**Middleware**:`@supabase/ssr`. Publiques:`/,/pricing,/how-it-works,/ecosystem,/status,/changelog,/privacy,/terms,/legal/*,/offline,/go/*,/api/*,/_next/*,/login,/signup,/register,/mentions-legales,/politique-confidentialite,/cgv,/cgu,/financer,/fiscal`. Auth→`/dashboard`. Non-auth→`/login?next=`. Admin→super_admin only.
**1 source vérité**:`types/database.ts` généré via `supabase gen types typescript --project-id xxx > src/types/database.ts`. Tous les types DB importés depuis là.

## 12. APPS — CATALOGUE 21 SLUGS
| Slug | Nom | Domaine | Watch? |
|---|---|---|---|
| `jurispurama` | JurisPurama | juridique avocat IA | non |
| `kaia` | KAÏA | santé médecine généraliste | OUI |
| `vida_sante` | VIDA | bien-être holistique | OUI |
| `vida_aide` | VIDA Aide | recherche aides sociales/handicap | non |
| `vida_assoc` | VIDA Asso | gestion association solidaire | non |
| `lingora` | Lingora | apprentissage langues | non |
| `kash` | KASH | conseil financier perso | non |
| `dona` | DONA | assistant générosité/dons | non |
| `voya` | VOYA | guide voyage immersif | non |
| `entreprise_pilot` | EntreprisePilot | pilotage TPE/PME | non |
| `purama_ai` | Purama AI | assistant généraliste écosystème | non |
| `purama_origin` | Origin | écosystème terre/spiritualité (PWA only, pas iOS/Android) | non |
| `akasha_ai` | AKASHA | multi-expert IA | non |
| `lumios` | LUMIOS | consultant business stratégie | non |
| `sutra` | SUTRA | création vidéo IA | non |
| `mana` | MANA | finances hyper-simplifié | non |
| `midas` | MIDAS | trading + analyse marchés | non |
| `prana` | PRANA | yoga + méditation + respiration | OUI |
| `aether` | AETHER | art génératif + musique méditative | OUI |
| `exodus` | EXODUS | détox écran + sevrage | OUI |
| `purama_compta` | Compta | comptabilité auto-entrepreneur | non |
| `adya` | ADYA | (réservé) | ? |
| `satya` | SATYA | (réservé) | ? |
**Compte unifié** (1 auth.users pour tout l'écosystème). 1 schéma PostgreSQL par app (`PGRST_DB_SCHEMAS`). Trigger auto-create profil dans schéma à 1ère connexion. **Bundle mobile**:`dev.purama.{SLUG}`. **Domaine**:`{SLUG}.purama.dev`.

## 13. 15 ERREURS — JAMAIS REFAIRE
1.Google OAuth "provider not enabled"→TOUJOURS activer sur VPS (`GOTRUE_EXTERNAL_GOOGLE_ENABLED=true`+CLIENT_ID+SECRET+`GOTRUE_URI_ALLOW_LIST=https://*.purama.dev/**`+restart) AVANT tester
2.Bouton déconnexion mort→`signOut()`+clear storage+`window.location.href='/login'`
3.Questionnaire qui boucle→marquer `tutorial_completed=true` dans DB+cookie+redirect
4.Thème dark/light qui change pas→vérifier CSS variables+localStorage+re-render forcé
5.Langue qui change pas→vérifier `next-intl`+locale switch+`router.push`
6.Faux avis/chiffres→JAMAIS inventer, compteurs dynamiques DB (afficher 0 si 0)
7.Images Pollinations moches dans le design→Lucide icons+gradients CSS uniquement
8.Landing 13 sections style site web→écran accueil APP (logo+CTA "Commencer"+"Se connecter" comme ChatGPT)
9.Responsive cassé overflow→tester 375px AVANT deploy
10.Skeleton infinis→vérifier API response+fallback timeout 10s
11.Build fail tsparticles→imports dynamiques `dynamic({ssr:false})`
12.Encodage cassé é/à/ç→UTF-8 natif dans le code source
13."Terminé" mais rien marche→TESTER CHAQUE BOUTON (Playwright click ou curl)
14.Session trop longue→bugs cumulés. `/compact` à 50%, `/clear` à 60%
15.Données orphelines→foreign keys+`ON DELETE CASCADE` partout

## 14. AUTONOMIE
Claude Code crée TOUT auto:projet+deps+.env.local(depuis §5)+DB SSH psql+Stripe webhook+auth email+OAuth VPS+code+tests+icônes+deploy+DNS+GitHub. .env.local=JAMAIS demander Tissma manuel. VPS=TOUJOURS vérifier SSH (`sshpass ... echo OK`) AVANT op DB.
**Effort**:ultrathink(31999 tok) archi+bug+design. `/effort high` code standard. `/compact >50%`. `--worktree` parallèle. `--continue` reprendre.
**Setup mac**:`caffeinate -dims && claude --dangerously-skip-permissions`.

#17 SIMPLIFY AUTO
Après CHAQUE modification de code, run /simplify avant de dire "fini".
0 exception.
