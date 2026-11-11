import React, { lazy, Suspense, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { PublishEverywhereButton } from '../../src/components/social/PublishEverywhereButton';
import { AuthContext } from '../../src/hooks/useAuth';
import { maybeAutopilot } from '../../src/lib/social';
import { fixture, setFixtureOwner } from './supabase-fixture';

// Load the actual view under test without keeping unrelated views in every page.
const SocialSettings = lazy(() => import('../../src/pages/SocialSettings'));
const DynamicAgentForm = lazy(() => import('../../src/components/agent/DynamicAgentForm')
  .then(module => ({ default: module.DynamicAgentForm })));

const authActions = {
  signIn: async () => ({ error: null }), signUp: async () => ({ error: null }),
  signInWithGoogle: async () => ({ error: null }), signOut: async () => {} };
window.__socialClient = { maybeAutopilot };

function Harness() {
  const [session, setSession] = useState(fixture.session);
  const [content, setContent] = useState('Découvrez les outils PURAMA pour préparer vos contenus.');
  const [instance, setInstance] = useState(0);
  const [visible, setVisible] = useState(true);
  const [agentSlug, setAgentSlug] = useState('contenu-social');
  const requestedView = new URLSearchParams(window.location.search).get('view');
  const view = ['settings', 'agent'].includes(requestedView) ? requestedView : 'publish';
  const auth = { ...authActions, user: session?.user ?? null, session, loading: false };
  return <AuthContext.Provider value={auth}><main style={{ fontFamily: 'system-ui', maxWidth: 700, margin: '40px auto' }}>
    <h1>Vérification des parcours sociaux</h1>
    <section aria-label="Contrôles de session de test">
      <p data-testid="active-owner">{session?.user.id ?? 'signed-out'}</p>
      <button onClick={() => setSession(setFixtureOwner('fixture-owner'))}>Utiliser le compte A</button>
      <button onClick={() => setSession(setFixtureOwner('fixture-other'))}>Utiliser le compte B</button>
      <button onClick={() => setSession(setFixtureOwner(null))}>Déconnecter la session</button>
    </section>
    {view === 'publish' && <label>Contenu de test<textarea aria-label="Contenu de test" value={content}
      onChange={event => setContent(event.target.value)} style={{ display: 'block', width: '100%', height: 90 }} /></label>}
    {visible && <Suspense fallback={<p>Chargement de la vue de test…</p>}>
      {view === 'settings' ? <section key={instance} data-testid="settings-control"><SocialSettings /></section>
      : view === 'agent' ? <section key={instance} data-testid="agent-control">
        <DynamicAgentForm agentSlug={agentSlug} agentName="Contenu Social" />
      </section> : <section data-testid="publish-control" style={{ margin: '20px 0' }}>
        <PublishEverywhereButton key={instance} content={content} platforms={['instagram', 'linkedin']}
          onPublished={postId => fixture.published.push({ postId, owner: session?.user.id, content })} />
      </section>}
    </Suspense>}
    <p data-testid="active-agent">{agentSlug}</p>
    <button onClick={() => setAgentSlug(value => value === 'contenu-social' ? 'hashtags-viraux' : 'contenu-social')}>Changer l’agent</button>
    <button onClick={() => setInstance(value => value + 1)}>Remonter le bouton</button>
    <button onClick={() => setVisible(value => !value)}>{visible ? 'Masquer la vue' : 'Afficher la vue'}</button>
    <Toaster richColors />
  </main></AuthContext.Provider>;
}
createRoot(document.getElementById('root')).render(<Harness />);
