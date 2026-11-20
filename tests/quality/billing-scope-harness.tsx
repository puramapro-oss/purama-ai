import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import type { User } from '@supabase/supabase-js';
import { AuthContext } from '../../src/hooks/useAuth';
import Pricing from '../../src/pages/Pricing';
import '../../src/index.css';

const users = ['a', 'b'].map((suffix, index) => ({
  id: `00000000-0000-4000-8000-00000000000${index + 1}`,
  email: `${suffix}@fixture.invalid`, app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-01-01T00:00:00Z',
} as User));
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function Harness() {
  const [user, setUser] = useState<User | null>(users[0]);
  return <AuthContext.Provider value={{ user, session: null, loading: false,
    signIn: async () => ({ error: null }), signUp: async () => ({ error: null }),
    signInWithGoogle: async () => ({ error: null }), signOut: async () => { setUser(null); },
  }}>
    <button onClick={() => setUser(users[0])}>Compte A</button>
    <button onClick={() => setUser(users[1])}>Compte B</button>
    <button onClick={() => setUser(null)}>Déconnexion fixture</button>
    <output data-testid="account">{user?.id ?? 'signed-out'}</output>
    <Pricing /><Toaster />
  </AuthContext.Provider>;
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><BrowserRouter><Harness /></BrowserRouter></QueryClientProvider>);
