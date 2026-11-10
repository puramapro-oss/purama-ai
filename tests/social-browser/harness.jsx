import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { PublishEverywhereButton } from '../../src/components/social/PublishEverywhereButton';

function Harness() {
  const [content, setContent] = useState('Découvrez les outils PURAMA pour préparer vos contenus.');
  const [instance, setInstance] = useState(0);
  return <main style={{ fontFamily: 'system-ui', maxWidth: 700, margin: '40px auto' }}>
    <h1>Vérification du bouton de publication</h1>
    <label>Contenu de test<textarea aria-label="Contenu de test" value={content}
      onChange={event => setContent(event.target.value)} style={{ display: 'block', width: '100%', height: 90 }} /></label>
    <section data-testid="publish-control" style={{ margin: '20px 0' }}>
      <PublishEverywhereButton key={instance} content={content} platforms={['instagram', 'linkedin']}
        onPublished={postId => window.__socialFixture.published.push(postId)} />
    </section>
    <button onClick={() => setInstance(value => value + 1)}>Remonter le bouton</button>
    <Toaster richColors />
  </main>;
}
createRoot(document.getElementById('root')).render(<Harness />);
