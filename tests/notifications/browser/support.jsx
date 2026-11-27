import { useAuth } from './auth.jsx';

export function useProfile() {
  const { user } = useAuth();
  return { data: user ? { full_name: `Compte de test ${user.id}`, avatar_url: null } : null };
}
export const useSubscription = () => ({ data: { plan_type: 'free' } });
export const useAgents = () => ({ data: [{ slug: 'assistant', name: 'Assistant de test' }] });
