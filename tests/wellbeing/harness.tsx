import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as Dialog from '@radix-ui/react-dialog';
import { MemoryRouter } from 'react-router-dom';
import { SpiritualLayer } from '../../src/components/shared/SpiritualLayer';
import Breathe from '../../src/pages/Breathe';
import Gratitude from '../../src/pages/Gratitude';
import { useAwakening } from '../../src/hooks/useAwakening';
import { TestAuth } from './auth';
import i18n from '../../src/i18n';
import '../../src/index.css';

function useNestedDialogFixture(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let host: HTMLDivElement | undefined;
    let nestedRoot: ReturnType<typeof createRoot> | undefined;
    const attach = () => {
      if (host?.isConnected) return;
      nestedRoot?.unmount(); nestedRoot = undefined;
      const outer = document.querySelector('[role="dialog"]');
      if (!outer) return;
      host = document.createElement('div');
      outer.appendChild(host);
      // A real nested React root and Radix layer, as with an embedded widget.
      // No test-only prop or alternate keyboard handler enters the product.
      nestedRoot = createRoot(host);
      nestedRoot.render(<Dialog.Root>
        <Dialog.Trigger>Ouvrir le dialogue imbriqué</Dialog.Trigger>
        <Dialog.Content data-testid="nested-pause-dialog" className="border bg-background p-4">
          <Dialog.Title>Dialogue imbriqué de test</Dialog.Title>
          <Dialog.Description>La touche du dialogue interne ne doit pas fermer la pause.</Dialog.Description>
          <Dialog.Close>Fermer le dialogue imbriqué</Dialog.Close>
        </Dialog.Content>
      </Dialog.Root>);
    };
    const observer = new MutationObserver(attach);
    observer.observe(document.body, { childList: true, subtree: true });
    attach();
    return () => { observer.disconnect(); nestedRoot?.unmount(); host?.remove(); };
  }, [enabled]);
}

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
  useNestedDialogFixture(new URLSearchParams(location.search).has('nested-dialog'));
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
