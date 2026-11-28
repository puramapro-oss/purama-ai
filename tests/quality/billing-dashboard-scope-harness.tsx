import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import type { User } from '@supabase/supabase-js';
import { AuthContext } from '../../src/hooks/useAuth';
import DashboardBilling from '../../src/pages/DashboardBilling';
import { getPlan } from '../../src/lib/plans';
import type { UsageSnapshot } from '../../src/lib/usage';
import '../../src/index.css';

const users = ['a', 'b'].map((suffix, index) => ({
  id: `00000000-0000-4000-8000-00000000000${index + 1}`,
  email: `${suffix}@fixture.invalid`, app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-01-01T00:00:00Z',
} as User));
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
const uncachedSubscription = new URLSearchParams(window.location.search).has('uncached');
// Seed only display data. The real component, hooks and billing invokes run unchanged.
client.setQueryData(['agents', undefined], []);
for (const user of users) {
  if (!uncachedSubscription) client.setQueryData(['subscription', user.id], { plan_type: 'pro', status: 'active', has_used_trial: true, trial_ends_at: null });
  client.setQueryData(['agent-usage', user.id, 365], []);
  client.setQueryData<UsageSnapshot>(['usage-snapshot', user.id], {
    used: 8500, limit: 10000, percent: 85, plan: getPlan('pro'), days_until_reset: 10,
    by_agent: { email: 0, compta: 0, partner: 0, legal: 0, creator: 0, karta: 0, marketplace: 8500 },
    hours_saved: 0, money_recovered: 0,
  });
}

function Harness() {
  const [user, setUser] = useState<User | null>(users[0]);
  const [visible, setVisible] = useState(true);
  return <AuthContext.Provider value={{ user, session: null, loading: false,
    signIn: async () => ({ error: null }), signUp: async () => ({ error: null }),
    signInWithGoogle: async () => ({ error: null }), signOut: async () => { setUser(null); },
  }}>
    <button onClick={() => setUser(users[0])}>Compte A</button>
    <button onClick={() => setUser(users[1])}>Compte B</button>
    <button onClick={() => setUser(null)}>Déconnexion fixture</button>
    <button onClick={() => setVisible(value => !value)}>{visible ? 'Masquer facturation fixture' : 'Afficher facturation fixture'}</button>
    <output data-testid="account">{user?.id ?? 'signed-out'}</output>
    {visible && <DashboardBilling />}<Toaster />
  </AuthContext.Provider>;
}

createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><BrowserRouter><Harness /></BrowserRouter></QueryClientProvider>);
