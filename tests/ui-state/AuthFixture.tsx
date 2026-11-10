import { useEffect, useState, type ReactNode } from 'react';
import { Auth, initialUser } from './auth-state';
import { harness } from './transport';
export function AuthFixture({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<typeof initialUser | null>(initialUser);
  useEffect(() => { harness.setIdentity = id => setUser(id ? { ...initialUser, id } : null); }, []);
  return <Auth.Provider value={{ user }}>{children}</Auth.Provider>;
}
