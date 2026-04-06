import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { AuthProvider } from '@/hooks/useAuth';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { ChatbotWidget } from '@/components/ChatbotWidget';
import { CookieConsent } from '@/components/CookieConsent';
import { ServiceWorkerRegistration } from '@/components/pwa/ServiceWorkerRegistration';
import { InstallBanner } from '@/components/pwa/InstallBanner';
import { DashboardLayout } from '@/components/dashboard/DashboardLayout';
import Index from '@/pages/Index';
import Login from '@/pages/Login';
import Signup from '@/pages/Signup';
import ForgotPassword from '@/pages/ForgotPassword';
import ResetPassword from '@/pages/ResetPassword';
import AgentDetail from '@/pages/AgentDetail';
import Pricing from '@/pages/Pricing';
import MyAgents from '@/pages/MyAgents';
import MyConnections from '@/pages/MyConnections';
import OAuthCallback from '@/pages/OAuthCallback';
import Notifications from '@/pages/Notifications';
import NotificationSettings from '@/pages/NotificationSettings';
import InfluencerDashboard from '@/pages/InfluencerDashboard';
import InfluencerSignup from '@/pages/InfluencerSignup';
import AdminInfluencers from '@/pages/AdminInfluencers';
import MentionsLegales from '@/pages/MentionsLegales';
import PolitiqueConfidentialite from '@/pages/PolitiqueConfidentialite';
import CGV from '@/pages/CGV';
import CGU from '@/pages/CGU';
import PolitiqueCookies from '@/pages/PolitiqueCookies';
import NotFound from '@/pages/NotFound';
import Parrainage from '@/pages/Parrainage';
import Concours from '@/pages/Concours';
import Classement from '@/pages/Classement';
import Forge from '@/pages/Forge';
import PuramaCompta from '@/pages/PuramaCompta';
import SocialAgent from '@/pages/SocialAgent';
import DashboardOverview from '@/pages/DashboardOverview';
import DashboardAgents from '@/pages/DashboardAgents';
import DashboardAutoAgents from '@/pages/DashboardAutoAgents';
import DashboardAnalytics from '@/pages/DashboardAnalytics';
import DashboardBilling from '@/pages/DashboardBilling';
import DashboardSettings from '@/pages/DashboardSettings';
import SocialSettings from '@/pages/SocialSettings';
import AdminDashboard from '@/pages/AdminDashboard';
import EmailAgent from '@/pages/EmailAgent';
import EmailAgentSettings from '@/pages/EmailAgentSettings';
import EmailAgentLogs from '@/pages/EmailAgentLogs';
import EmailAgentRules from '@/pages/EmailAgentRules';
import EmailAgentMemoryPage from '@/pages/EmailAgentMemory';
import EmailAgentTemplates from '@/pages/EmailAgentTemplates';
import ComptaAgent from '@/pages/ComptaAgent';
import ComptaAgentSettings from '@/pages/ComptaAgentSettings';
import ComptaAgentTransactions from '@/pages/ComptaAgentTransactions';
import ComptaAgentInvoices from '@/pages/ComptaAgentInvoices';
import ComptaAgentDeclarations from '@/pages/ComptaAgentDeclarations';
import ComptaAgentReports from '@/pages/ComptaAgentReports';
import PartnerAgent from '@/pages/PartnerAgent';
import PartnerAgentProspects from '@/pages/PartnerAgentProspects';
import PartnerAgentPartners from '@/pages/PartnerAgentPartners';
import PartnerAgentEmails from '@/pages/PartnerAgentEmails';
import PartnerAgentSettings from '@/pages/PartnerAgentSettings';

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
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Toaster position="top-right" richColors />
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
            <Route path="/forge" element={<Forge />} />
            <Route path="/purama-compta" element={<PuramaCompta />} />
            <Route path="/agent" element={<SocialAgent />} />
            
            {/* Dashboard routes with sidebar layout */}
            <Route path="/dashboard" element={<DashboardRoute><DashboardOverview /></DashboardRoute>} />
            <Route path="/dashboard/agents" element={<DashboardRoute><DashboardAgents /></DashboardRoute>} />
            <Route path="/dashboard/auto-agents" element={<DashboardRoute><DashboardAutoAgents /></DashboardRoute>} />
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
            <Route path="/dashboard/sites" element={<DashboardRoute><div className="text-foreground"><h1 className="text-2xl font-orbitron font-bold mb-4">Mes Sites</h1><p className="text-muted-foreground">Fonctionnalité bientôt disponible.</p></div></DashboardRoute>} />
            <Route path="/dashboard/apps" element={<DashboardRoute><div className="text-foreground"><h1 className="text-2xl font-orbitron font-bold mb-4">Mes Applications</h1><p className="text-muted-foreground">Fonctionnalité bientôt disponible.</p></div></DashboardRoute>} />

            <Route path="/agent/:slug" element={<ProtectedRoute><AgentDetail /></ProtectedRoute>} />
            <Route path="/my-agents" element={<ProtectedRoute><MyAgents /></ProtectedRoute>} />
            <Route path="/mes-connexions" element={<ProtectedRoute><MyConnections /></ProtectedRoute>} />
            <Route path="/oauth/callback" element={<OAuthCallback />} />
            <Route path="/notifications" element={<ProtectedRoute><Notifications /></ProtectedRoute>} />
            <Route path="/notification-settings" element={<ProtectedRoute><NotificationSettings /></ProtectedRoute>} />
            <Route path="/influenceur/dashboard" element={<InfluencerDashboard />} />
            <Route path="/influenceur/inscription" element={<InfluencerSignup />} />
            <Route path="/admin/influenceurs" element={<ProtectedRoute><AdminInfluencers /></ProtectedRoute>} />
            <Route path="/admin/dashboard" element={<ProtectedRoute><AdminDashboard /></ProtectedRoute>} />
            <Route path="/parrainage" element={<Parrainage />} />
            <Route path="/concours" element={<Concours />} />
            <Route path="/classement" element={<Classement />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
          <ChatbotWidget />
          <CookieConsent />
          <ServiceWorkerRegistration />
          <InstallBanner />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
