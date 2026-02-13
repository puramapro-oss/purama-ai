import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { AuthProvider } from '@/hooks/useAuth';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { ChatbotWidget } from '@/components/ChatbotWidget';
import { CookieConsent } from '@/components/CookieConsent';
import Index from '@/pages/Index';
import Login from '@/pages/Login';
import Signup from '@/pages/Signup';
import ForgotPassword from '@/pages/ForgotPassword';
import ResetPassword from '@/pages/ResetPassword';
import Dashboard from '@/pages/Dashboard';
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

const queryClient = new QueryClient();

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
            <Route
              path="/dashboard"
              element={<ProtectedRoute><Dashboard /></ProtectedRoute>}
            />
            <Route
              path="/agent/:slug"
              element={<ProtectedRoute><AgentDetail /></ProtectedRoute>}
            />
            <Route
              path="/my-agents"
              element={<ProtectedRoute><MyAgents /></ProtectedRoute>}
            />
            <Route
              path="/mes-connexions"
              element={<ProtectedRoute><MyConnections /></ProtectedRoute>}
            />
            <Route path="/oauth/callback" element={<OAuthCallback />} />
            <Route
              path="/notifications"
              element={<ProtectedRoute><Notifications /></ProtectedRoute>}
            />
            <Route
              path="/notification-settings"
              element={<ProtectedRoute><NotificationSettings /></ProtectedRoute>}
            />
            <Route path="/influenceur/dashboard" element={<InfluencerDashboard />} />
            <Route path="/influenceur/inscription" element={<InfluencerSignup />} />
            <Route
              path="/admin/influenceurs"
              element={<ProtectedRoute><AdminInfluencers /></ProtectedRoute>}
            />
            <Route path="/parrainage" element={<Parrainage />} />
            <Route path="/concours" element={<Concours />} />
            <Route path="/classement" element={<Classement />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
          <ChatbotWidget />
          <CookieConsent />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
