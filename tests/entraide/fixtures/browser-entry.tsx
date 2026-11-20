import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import Entraide from '../../../src/pages/Entraide';
import './browser-auth';

const queryClient = new QueryClient();
const actor = window.__ENTRAIDE_FIXTURE_AUTH__;
window.__ENTRAIDE_FIXTURE_CONTROLS__ = {
  refresh: (scope) => queryClient.invalidateQueries({ queryKey: [`entraide-${scope}`, actor.id] }),
};

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <aside aria-label="Périmètre de la fixture" className="border-b border-input p-2 text-center text-xs text-muted-foreground">
      Test local · {actor.alias} · authentification simulée · handlers et RPC réels · {actor.database === 'pglite' ? 'moteur PostgreSQL PGlite' : 'PostgreSQL local'}
    </aside>
    <main><Entraide /></main>
    <Toaster richColors />
  </QueryClientProvider>,
);
