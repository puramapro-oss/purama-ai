import { createContext, useContext, useState, type ReactNode } from 'react';

const Auth = createContext<{ user: { id: string } | null; loading: boolean }>({ user: { id: 'account-a' }, loading: false });

export function TestAuth({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<{ id: string } | null>({ id: 'account-a' });
  return <Auth.Provider value={{ user, loading: false }}>
    <nav aria-label="Test accounts" className="mb-8 flex gap-4">
      <button onClick={() => setUser({ id: 'account-a' })}>Account A</button>
      <button onClick={() => setUser({ id: 'account-b' })}>Account B</button>
      <button onClick={() => setUser(null)}>Guest</button>
    </nav>
    {children}
  </Auth.Provider>;
}

export function useAuth() { return useContext(Auth); }
