import { createContext, useContext } from 'react';
export const ACCOUNT_A = '00000000-0000-4000-8000-000000000001';
export const ACCOUNT_B = '00000000-0000-4000-8000-000000000002';
export const initialUser = { id: ACCOUNT_A, email: 'fixture@example.invalid' };
export const Auth = createContext<{ user: typeof initialUser | null }>({ user: initialUser });
export function useAuth() { return { ...useContext(Auth), loading: false }; }
