import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { toast, Toaster } from 'sonner';
import { AuthFixture } from './AuthFixture';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import PartnerAgentSettings from '@/pages/PartnerAgentSettings';
import EmailAgentSettings from '@/pages/EmailAgentSettings';
import EmailAgent from '@/pages/EmailAgent';
import ComptaAgentSettings from '@/pages/ComptaAgentSettings';
import LegalAgentChat from '@/pages/LegalAgentChat';
import '@/index.css';
declare global { interface Window { uiStateToastHistory: () => string[] } }
// Read the real Sonner history so a notification that already disappeared
// cannot make a forbidden-success assertion pass by timing alone.
window.uiStateToastHistory = () => toast.getHistory().flatMap(entry =>
  'title' in entry && typeof entry.title === 'string' ? [entry.title] : []);
const pages = { partner: PartnerAgentSettings, email: EmailAgentSettings, emailDashboard: EmailAgent, compta: ComptaAgentSettings, legal: LegalAgentChat };
const kind = new URLSearchParams(location.search).get('page') || 'partner';
if (!(kind in pages)) throw new Error('Unknown fixture page');
const Page = pages[kind as keyof typeof pages];
createRoot(document.getElementById('root')!).render(
  <MemoryRouter><AuthFixture><ProtectedRoute><Page /></ProtectedRoute><Toaster /></AuthFixture></MemoryRouter>,
);
