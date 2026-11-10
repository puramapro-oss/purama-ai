import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthFixture } from './AuthFixture';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import PartnerAgentSettings from '@/pages/PartnerAgentSettings';
import EmailAgentSettings from '@/pages/EmailAgentSettings';
import ComptaAgentSettings from '@/pages/ComptaAgentSettings';
import LegalAgentChat from '@/pages/LegalAgentChat';
import '@/index.css';
const pages = { partner: PartnerAgentSettings, email: EmailAgentSettings, compta: ComptaAgentSettings, legal: LegalAgentChat };
const kind = new URLSearchParams(location.search).get('page') || 'partner';
if (!(kind in pages)) throw new Error('Unknown fixture page');
const Page = pages[kind as keyof typeof pages];
createRoot(document.getElementById('root')!).render(
  <MemoryRouter><AuthFixture><ProtectedRoute><Page /></ProtectedRoute><Toaster /></AuthFixture></MemoryRouter>,
);
