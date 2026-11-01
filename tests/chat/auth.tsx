import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { harness } from './transport';
type State = { user: { id: string; email: string } | null; loading: boolean };
const Auth = createContext<State>({ user: null, loading: false });
export function TestAuth({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ user: null, loading: false });
  useEffect(() => { harness.setIdentity = (user, loading = false) => setState({ user, loading }); }, []);
  return <Auth.Provider value={state}>{children}</Auth.Provider>;
}
export function useAuth() {
  const state = useContext(Auth);
  return { ...state, session: state.user ? { access_token: 'test-session-' + state.user.id } : null };
}
