import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { AuthContext } from '@/hooks/useAuth';
import { useUserConnections } from '@/hooks/useUserConnections';
import OAuthCallback from '@/pages/OAuthCallback';
import { getGmailOAuthUrl } from '@/lib/email-agent';
import { OWNER, port } from './transport';
const mode = new URLSearchParams(location.search).get('mode') ?? 'callback';
const state = 'ab'.repeat(32);
const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
const user = (id: string) => ({ id, email: 'fixture@example.invalid', app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-11-10T00:00:00Z' });
function HookProbe() {
  const hook = useUserConnections();
  Object.assign(window, { startOAuth: () => hook.initiateOAuth('gmail') });
  return <button onClick={() => { void hook.initiateOAuth('gmail'); }}>Connecter Gmail</button>;
}
function GmailProbe() {
  const start = () => {
    const controller = new AbortController();
    Object.assign(window, { abortGmail: () => controller.abort(), gmailResult: null });
    void getGmailOAuthUrl(OWNER, controller.signal).then(url => {
      Object.assign(window, { gmailResult: { url } });
    }, error => { Object.assign(window, { gmailResult: { error: String(error) } }); });
  };
  return <button onClick={start}>Démarrer Gmail</button>;
}
function Fixture() {
  const [identity, setIdentity] = useState<string | null>(OWNER);
  const [visible, setVisible] = useState(true);
  const navigate = useNavigate(); const location = useLocation();
  Object.assign(window, { switchIdentity: setIdentity, hideOAuth: () => setVisible(false), navigateFixture: navigate });
  return <AuthContext.Provider value={{ user: identity ? user(identity) : null, session: identity ? port.session(identity) : null,
    loading: false, signIn: async () => ({ error: null }), signUp: async () => ({ error: null }),
    signInWithGoogle: async () => ({ error: null }), signOut: async () => {} } as never}>
    <output data-testid="account">{identity ?? 'anonymous'}</output>
    <output data-testid="path">{location.pathname + location.search}</output>
    {visible && <Routes><Route path="/oauth/callback" element={<OAuthCallback />} /><Route path="/connections" element={<HookProbe />} /><Route path="/gmail-start" element={<GmailProbe />} /><Route path="*" element={<p>Autre page conservée</p>} /></Routes>}
    <Toaster />
  </AuthContext.Provider>;
}
const callback = mode === 'error' ? '/oauth/callback?error=access_denied&state=' + state : '/oauth/callback?code=synthetic-code&state=' + state;
const element = <QueryClientProvider client={client}><MemoryRouter initialEntries={[mode === 'hook' ? '/connections' : mode === 'gmail-start' ? '/gmail-start' : callback]}><Fixture /></MemoryRouter></QueryClientProvider>;
createRoot(document.getElementById('root')!).render(mode === 'strict' ? <StrictMode>{element}</StrictMode> : element);
