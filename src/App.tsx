import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { ThemeProvider } from 'next-themes';
import { Loader2 } from 'lucide-react';
import { AuthProvider } from '@/hooks/useAuth';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { ChatbotWidget } from '@/components/ChatbotWidget';
import { CookieConsent } from '@/components/CookieConsent';
import { ServiceWorkerRegistration } from '@/components/pwa/ServiceWorkerRegistration';
import { CinematicIntro } from '@/components/shared/CinematicIntro';
import { InstallBanner } from '@/components/pwa/InstallBanner';
import { SpiritualLayer } from '@/components/shared/SpiritualLayer';
import { DashboardLayout } from '@/components/dashboard/DashboardLayout';
import Index from '@/pages/Index';
import Login from '@/pages/Login';
import Signup from '@/pages/Signup';
const ForgotPassword = lazy(() => import('@/pages/ForgotPassword'));
const ResetPassword = lazy(() => import('@/pages/ResetPassword'));
const AgentDetail = lazy(() => import('@/pages/AgentDetail'));
const Pricing = lazy(() => import('@/pages/Pricing'));
const MyAgents = lazy(() => import('@/pages/MyAgents'));
const MyConnections = lazy(() => import('@/pages/MyConnections'));
const OAuthCallback = lazy(() => import('@/pages/OAuthCallback'));
const Notifications = lazy(() => import('@/pages/Notifications'));
const NotificationSettings = lazy(() => import('@/pages/NotificationSettings'));
const InfluencerDashboard = lazy(() => import('@/pages/InfluencerDashboard'));
const InfluencerSignup = lazy(() => import('@/pages/InfluencerSignup'));
const AdminInfluencers = lazy(() => import('@/pages/AdminInfluencers'));
const MentionsLegales = lazy(() => import('@/pages/MentionsLegales'));
const PolitiqueConfidentialite = lazy(() => import('@/pages/PolitiqueConfidentialite'));
const CGV = lazy(() => import('@/pages/CGV'));
const CGU = lazy(() => import('@/pages/CGU'));
const PolitiqueCookies = lazy(() => import('@/pages/PolitiqueCookies'));
const NotFound = lazy(() => import('@/pages/NotFound'));
const Parrainage = lazy(() => import('@/pages/Parrainage'));
const Concours = lazy(() => import('@/pages/Concours'));
const Classement = lazy(() => import('@/pages/Classement'));
const Forge = lazy(() => import('@/pages/Forge'));
const PuramaCompta = lazy(() => import('@/pages/PuramaCompta'));
const SocialAgent = lazy(() => import('@/pages/SocialAgent'));
const DashboardOverview = lazy(() => import('@/pages/DashboardOverview'));
const DashboardAgents = lazy(() => import('@/pages/DashboardAgents'));
const DashboardAnalytics = lazy(() => import('@/pages/DashboardAnalytics'));
const DashboardBilling = lazy(() => import('@/pages/DashboardBilling'));
const DashboardSettings = lazy(() => import('@/pages/DashboardSettings'));
const SocialSettings = lazy(() => import('@/pages/SocialSettings'));
const AdminDashboard = lazy(() => import('@/pages/AdminDashboard'));
const EmailAgent = lazy(() => import('@/pages/EmailAgent'));
const EmailAgentSettings = lazy(() => import('@/pages/EmailAgentSettings'));
const EmailAgentLogs = lazy(() => import('@/pages/EmailAgentLogs'));
const EmailAgentRules = lazy(() => import('@/pages/EmailAgentRules'));
const EmailAgentMemoryPage = lazy(() => import('@/pages/EmailAgentMemory'));
const EmailAgentTemplates = lazy(() => import('@/pages/EmailAgentTemplates'));
const ComptaAgent = lazy(() => import('@/pages/ComptaAgent'));
const ComptaAgentSettings = lazy(() => import('@/pages/ComptaAgentSettings'));
const ComptaAgentTransactions = lazy(() => import('@/pages/ComptaAgentTransactions'));
const ComptaAgentInvoices = lazy(() => import('@/pages/ComptaAgentInvoices'));
const ComptaAgentDeclarations = lazy(() => import('@/pages/ComptaAgentDeclarations'));
const ComptaAgentReports = lazy(() => import('@/pages/ComptaAgentReports'));
const PartnerAgent = lazy(() => import('@/pages/PartnerAgent'));
const PartnerAgentProspects = lazy(() => import('@/pages/PartnerAgentProspects'));
const PartnerAgentPartners = lazy(() => import('@/pages/PartnerAgentPartners'));
const PartnerAgentEmails = lazy(() => import('@/pages/PartnerAgentEmails'));
const PartnerAgentSettings = lazy(() => import('@/pages/PartnerAgentSettings'));
const LegalAgent = lazy(() => import('@/pages/LegalAgent'));
const LegalAgentChat = lazy(() => import('@/pages/LegalAgentChat'));
const LegalAgentDocuments = lazy(() => import('@/pages/LegalAgentDocuments'));
const LegalAgentCases = lazy(() => import('@/pages/LegalAgentCases'));
const LegalAgentImpayes = lazy(() => import('@/pages/LegalAgentImpayes'));
const LegalAgentVeille = lazy(() => import('@/pages/LegalAgentVeille'));
const CreatorAgentPage = lazy(() => import('@/pages/CreatorAgent'));
const CreatorAgentNew = lazy(() => import('@/pages/CreatorAgentNew'));
const CreatorAgentDetail = lazy(() => import('@/pages/CreatorAgentDetail'));
const CreatorAgentTemplates = lazy(() => import('@/pages/CreatorAgentTemplates'));
const CreatorAgentRuns = lazy(() => import('@/pages/CreatorAgentRuns'));
const Wallet = lazy(() => import('@/pages/Wallet'));
const Boutique = lazy(() => import('@/pages/Boutique'));
const DailyGift = lazy(() => import('@/pages/DailyGift'));
const Tirage = lazy(() => import('@/pages/Tirage'));
const Ecosystem = lazy(() => import('@/pages/Ecosystem'));
const Aide = lazy(() => import('@/pages/Aide'));
const Guide = lazy(() => import('@/pages/Guide'));
const Breathe = lazy(() => import('@/pages/Breathe'));
const Gratitude = lazy(() => import('@/pages/Gratitude'));
const Financer = lazy(() => import('@/pages/Financer'));

function PageFallback() {
  return (
    <div className="flex h-screen w-full items-center justify-center bg-background">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
    </div>
  );
}

const queryClient = new QueryClient();

function DashboardRoute({ children }: { children: React.ReactNode }) {
  return (
    <ProtectedRoute>
      <DashboardLayout>{children}</DashboardLayout>
    </ProtectedRoute>
  );
}

export default function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" storageKey="purama-theme">
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <CinematicIntro />
          <SpiritualLayer />
          <Toaster position="top-right" richColors />
          <Suspense fallback={<PageFallback />}>
          <Routes>
            <Route path="/" element={<Index />} />
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<Signup />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/pricing" element={<Pricing />} />
            <Route path="/mentions-legales" element={<MentionsLegales />} />
            <Route path="/politique-de-confidentialite" element={<PolitiqueConfidentialite />} />
            <Route path="/cgv" element={<CGV />} />
            <Route path="/cgu" element={<CGU />} />
            <Route path="/politique-cookies" element={<PolitiqueCookies />} />
            <Route path="/financer" element={<Financer />} />
            <Route path="/ecosystem" element={<Ecosystem />} />
            <Route path="/forge" element={<Forge />} />
            <Route path="/purama-compta" element={<PuramaCompta />} />
            <Route path="/agent" element={<SocialAgent />} />
            
            {/* Dashboard routes with sidebar layout */}
            <Route path="/dashboard" element={<DashboardRoute><DashboardOverview /></DashboardRoute>} />
            <Route path="/dashboard/agents" element={<DashboardRoute><DashboardAgents /></DashboardRoute>} />
            <Route path="/dashboard/auto-agents" element={<Navigate to="/dashboard/agents" replace />} />
            <Route path="/dashboard/analytics" element={<DashboardRoute><DashboardAnalytics /></DashboardRoute>} />
            <Route path="/dashboard/billing" element={<DashboardRoute><DashboardBilling /></DashboardRoute>} />
            <Route path="/dashboard/settings" element={<DashboardRoute><DashboardSettings /></DashboardRoute>} />
            <Route path="/dashboard/social" element={<DashboardRoute><SocialSettings /></DashboardRoute>} />
            <Route path="/dashboard/email-agent" element={<DashboardRoute><EmailAgent /></DashboardRoute>} />
            <Route path="/dashboard/email-agent/settings" element={<DashboardRoute><EmailAgentSettings /></DashboardRoute>} />
            <Route path="/dashboard/email-agent/logs" element={<DashboardRoute><EmailAgentLogs /></DashboardRoute>} />
            <Route path="/dashboard/email-agent/rules" element={<DashboardRoute><EmailAgentRules /></DashboardRoute>} />
            <Route path="/dashboard/email-agent/memory" element={<DashboardRoute><EmailAgentMemoryPage /></DashboardRoute>} />
            <Route path="/dashboard/email-agent/templates" element={<DashboardRoute><EmailAgentTemplates /></DashboardRoute>} />
            <Route path="/dashboard/compta-agent" element={<DashboardRoute><ComptaAgent /></DashboardRoute>} />
            <Route path="/dashboard/compta-agent/settings" element={<DashboardRoute><ComptaAgentSettings /></DashboardRoute>} />
            <Route path="/dashboard/compta-agent/transactions" element={<DashboardRoute><ComptaAgentTransactions /></DashboardRoute>} />
            <Route path="/dashboard/compta-agent/invoices" element={<DashboardRoute><ComptaAgentInvoices /></DashboardRoute>} />
            <Route path="/dashboard/compta-agent/declarations" element={<DashboardRoute><ComptaAgentDeclarations /></DashboardRoute>} />
            <Route path="/dashboard/compta-agent/reports" element={<DashboardRoute><ComptaAgentReports /></DashboardRoute>} />
            <Route path="/dashboard/partner-agent" element={<DashboardRoute><PartnerAgent /></DashboardRoute>} />
            <Route path="/dashboard/partner-agent/prospects" element={<DashboardRoute><PartnerAgentProspects /></DashboardRoute>} />
            <Route path="/dashboard/partner-agent/partners" element={<DashboardRoute><PartnerAgentPartners /></DashboardRoute>} />
            <Route path="/dashboard/partner-agent/emails" element={<DashboardRoute><PartnerAgentEmails /></DashboardRoute>} />
            <Route path="/dashboard/partner-agent/settings" element={<DashboardRoute><PartnerAgentSettings /></DashboardRoute>} />
            <Route path="/dashboard/legal-agent" element={<DashboardRoute><LegalAgent /></DashboardRoute>} />
            <Route path="/dashboard/legal-agent/chat" element={<DashboardRoute><LegalAgentChat /></DashboardRoute>} />
            <Route path="/dashboard/legal-agent/documents" element={<DashboardRoute><LegalAgentDocuments /></DashboardRoute>} />
            <Route path="/dashboard/legal-agent/cases" element={<DashboardRoute><LegalAgentCases /></DashboardRoute>} />
            <Route path="/dashboard/legal-agent/impayes" element={<DashboardRoute><LegalAgentImpayes /></DashboardRoute>} />
            <Route path="/dashboard/legal-agent/veille" element={<DashboardRoute><LegalAgentVeille /></DashboardRoute>} />
            <Route path="/dashboard/creator-agent" element={<DashboardRoute><CreatorAgentPage /></DashboardRoute>} />
            <Route path="/dashboard/creator-agent/new" element={<DashboardRoute><CreatorAgentNew /></DashboardRoute>} />
            <Route path="/dashboard/creator-agent/templates" element={<DashboardRoute><CreatorAgentTemplates /></DashboardRoute>} />
            <Route path="/dashboard/creator-agent/runs" element={<DashboardRoute><CreatorAgentRuns /></DashboardRoute>} />
            <Route path="/dashboard/creator-agent/:id" element={<DashboardRoute><CreatorAgentDetail /></DashboardRoute>} />
            <Route path="/dashboard/wallet" element={<DashboardRoute><Wallet /></DashboardRoute>} />
            <Route path="/dashboard/boutique" element={<DashboardRoute><Boutique /></DashboardRoute>} />
            <Route path="/dashboard/daily-gift" element={<DashboardRoute><DailyGift /></DashboardRoute>} />
            <Route path="/dashboard/tirage" element={<DashboardRoute><Tirage /></DashboardRoute>} />
            <Route path="/dashboard/aide" element={<DashboardRoute><Aide /></DashboardRoute>} />
            <Route path="/dashboard/guide" element={<DashboardRoute><Guide /></DashboardRoute>} />
            <Route path="/dashboard/breathe" element={<DashboardRoute><Breathe /></DashboardRoute>} />
            <Route path="/dashboard/gratitude" element={<DashboardRoute><Gratitude /></DashboardRoute>} />
            <Route path="/dashboard/sites" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard/apps" element={<Navigate to="/dashboard" replace />} />

            <Route path="/agent/:slug" element={<ProtectedRoute><AgentDetail /></ProtectedRoute>} />
            <Route path="/my-agents" element={<ProtectedRoute><MyAgents /></ProtectedRoute>} />
            <Route path="/mes-connexions" element={<ProtectedRoute><MyConnections /></ProtectedRoute>} />
            <Route path="/oauth/callback" element={<OAuthCallback />} />
            <Route path="/notifications" element={<ProtectedRoute><Notifications /></ProtectedRoute>} />
            <Route path="/notification-settings" element={<ProtectedRoute><NotificationSettings /></ProtectedRoute>} />
            <Route path="/influenceur/dashboard" element={<ProtectedRoute><InfluencerDashboard /></ProtectedRoute>} />
            <Route path="/influenceur/inscription" element={<InfluencerSignup />} />
            <Route path="/admin/influenceurs" element={<ProtectedRoute><AdminInfluencers /></ProtectedRoute>} />
            <Route path="/admin/dashboard" element={<ProtectedRoute><AdminDashboard /></ProtectedRoute>} />
            <Route path="/parrainage" element={<Parrainage />} />
            <Route path="/concours" element={<Concours />} />
            <Route path="/classement" element={<Classement />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
          </Suspense>
          <ChatbotWidget />
          <CookieConsent />
          <ServiceWorkerRegistration />
          <InstallBanner />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
    </ThemeProvider>
  );
}
