import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import Workshop from '@/pages/Workshop';
import '@/index.css';
createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/dashboard/atelier']}><main className="min-h-screen bg-background p-4 text-foreground sm:p-8"><Workshop /></main></MemoryRouter>,
);
