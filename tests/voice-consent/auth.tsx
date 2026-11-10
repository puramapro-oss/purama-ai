import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { harness } from './transport';
const initialUser = { id: '00000000-0000-4000-8000-000000000001', email: 'fixture@example.invalid' };
const Auth = createContext<{ user: typeof initialUser | null }>({ user: initialUser });
export function TestAuth({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<typeof initialUser | null>(initialUser);
  useEffect(() => { harness.setIdentity = id => setUser(id ? { ...initialUser, id } : null); }, []);
  return <Auth.Provider value={{ user }}>{children}</Auth.Provider>;
}
export function useAuth() { return { ...useContext(Auth), loading: false }; }
