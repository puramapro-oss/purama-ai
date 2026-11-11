// Remplacement de useAuth réservé au bundle de tests, jamais importé par le produit.
declare global {
  interface Window {
    __ENTRAIDE_FIXTURE_AUTH__: { id: string; token: string; alias: string; database: 'pglite' | 'postgres' };
    __ENTRAIDE_FIXTURE_CONTROLS__: { refresh: (scope: 'profil' | 'missions' | 'contacts' | 'matches') => Promise<void> };
  }
}

export function useAuth() {
  const fixture = window.__ENTRAIDE_FIXTURE_AUTH__;
  if (!fixture) throw new Error('Missing explicit Entraide auth fixture');
  return {
    user: { id: fixture.id },
    session: { access_token: fixture.token },
    loading: false,
  };
}
