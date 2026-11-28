import { createRoot } from 'react-dom/client';
import IaoTrialPanel from '@/components/IaoTrialPanel';
import { sharedTrial } from '@/lib/iao-trial-entry';
import './page.css';

createRoot(document.getElementById('essais')!).render(
  <IaoTrialPanel standalone entry={{ kind: sharedTrial(window.location.hash) }} />,
);
