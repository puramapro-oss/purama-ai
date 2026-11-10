import { createContext, useContext } from 'react';
import { ACCOUNT_A } from './transport';
export const initialUser = { id: ACCOUNT_A, email: 'fixture@example.invalid' };
export const Auth = createContext<{ user: typeof initialUser | null }>({ user: initialUser });
export function useAuth() { return { ...useContext(Auth), loading: false }; }
