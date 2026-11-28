import React, { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthContext } from '../../../src/hooks/useAuth';
import { IaoRoutinesSettings } from '../../../src/components/notifications/IaoRoutinesSettings';
import { accounts, fixture, initialOwner } from './fixture';

export function Harness() {
  const [owner, setOwner] = useState<string | null>(initialOwner);
  fixture.bindOwner(setOwner);
  const value = { user: owner ? { id: owner } : null,
    session: owner ? { user: { id: owner }, access_token: `test-session-${owner}` } : null,
    loading: false, signUp: async () => ({ error: null }), signIn: async () => ({ error: null }),
    signInWithGoogle: async () => ({ error: null }), signOut: async () => { setOwner(null); } };
  return <AuthContext.Provider value={value as never}>
    <div className="max-w-2xl mx-auto px-4 pt-4 text-xs text-muted-foreground" data-testid="fixture-account">
      Recette isolée · Compte {owner === accounts.A ? 'A' : owner === accounts.B ? 'B' : 'déconnecté'}
    </div>
    <main className="max-w-2xl mx-auto px-4 py-8"><IaoRoutinesSettings /></main>
  </AuthContext.Provider>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Harness /></StrictMode>);
