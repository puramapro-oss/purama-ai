import React, { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthContext } from './auth.jsx';
import Notifications from '@/pages/Notifications';
import NotificationSettings from '@/pages/NotificationSettings';
import { NotificationCenter } from '@/components/notifications/NotificationCenter';

const queryClient = new QueryClient({ defaultOptions: {
  queries: { retry: false, staleTime: 0, refetchOnWindowFocus: false },
  mutations: { retry: false },
} });
window.__notificationQueryClient = queryClient;

function App() {
  const [owner, setOwner] = useState(window.__notificationScenario?.owner ?? 'A');
  const user = owner ? { id: owner, email: `${owner.toLowerCase()}@example.test` } : null;
  useLayoutEffect(() => { window.__setNotificationOwner = setOwner; }, []);
  const view = new URLSearchParams(window.location.search).get('view') ?? 'notifications';
  return <AuthContext.Provider value={{ user, loading: false, signOut: () => setOwner(null) }}>
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[view === 'settings' ? '/notification-settings' : '/notifications']}>
        <div style={{ padding: '10px 16px', background: '#e2e8f0', color: '#0f172a', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <span data-testid="fixture-account">{owner ?? 'anonymous'}</span>
          <button onClick={() => setOwner('A')}>Compte A (banc)</button>
          <button onClick={() => setOwner('B')}>Compte B (banc)</button>
          <button onClick={() => setOwner(null)}>Déconnexion (banc)</button>
          <button onClick={() => queryClient.refetchQueries({ type: 'active' })}>Relire les données (banc)</button>
        </div>
        <main data-testid="product-surface">
          {view === 'settings' ? <NotificationSettings /> : view === 'center' ? <div style={{ padding: 32 }}><NotificationCenter /></div> : <Notifications />}
        </main>
        <Toaster richColors position="bottom-right" duration={60000} />
      </MemoryRouter>
    </QueryClientProvider>
  </AuthContext.Provider>;
}

createRoot(document.getElementById('root')).render(<App />);
