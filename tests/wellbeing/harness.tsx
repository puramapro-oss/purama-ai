import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { SpiritualLayer } from '../../src/components/shared/SpiritualLayer';
import Breathe from '../../src/pages/Breathe';
import Gratitude from '../../src/pages/Gratitude';
import { useAwakening } from '../../src/hooks/useAwakening';
import { TestAuth } from './auth';
import i18n from '../../src/i18n';
import '../../src/index.css';

function ActivityProbe() {
  const activity = useAwakening();
  return <div>
    <button onClick={activity.recordAffirmation}>Record chosen pause</button>
    <button onClick={() => activity.addXp(50000)}>Legacy XP</button>
    <output data-testid="activity">{JSON.stringify(activity)}</output>
  </div>;
}

function Harness() {
  const [view, setView] = useState(new URLSearchParams(location.search).get('view') ?? 'pause');
  return <main className="p-6 pb-32">
    <nav aria-label="Test language" className="mb-4 flex gap-4">
      <button onClick={() => { void i18n.changeLanguage('fr'); }}>Français</button>
      <button onClick={() => { void i18n.changeLanguage('en'); }}>English</button>
      <button onClick={() => { void i18n.changeLanguage('es'); }}>Español</button>
    </nav>
    <TestAuth>
      <nav aria-label="Test views" className="mb-8 flex gap-4">
        <button onClick={() => setView('pause')}>Pause view</button>
        <button onClick={() => setView('breathe')}>Breathing view</button>
        <button onClick={() => setView('journal')}>Journal view</button>
      </nav>
      {view === 'breathe' ? <Breathe /> : view === 'journal' ? <Gratitude /> : view === 'activity' ? <ActivityProbe /> : <SpiritualLayer />}
    </TestAuth>
  </main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><MemoryRouter><Harness /></MemoryRouter></React.StrictMode>);
