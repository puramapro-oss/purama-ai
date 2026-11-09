import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from '../../src/hooks/useAuth';
import { useSubscription } from '../../src/hooks/useSubscription';

export function SubscriptionProbe() {
  const { user, loading } = useAuth();
  const subscription = useSubscription();
  return (
    <output data-testid="subscription-state">
      {JSON.stringify({
        authReady: !loading,
        userId: user?.id ?? null,
        isLoading: subscription.isLoading,
        planId: subscription.planId,
        planObjectId: subscription.plan.id,
        hasSubscription: subscription.hasSubscription,
        isStarter: subscription.isStarter,
        isPro: subscription.isPro,
        isUltime: subscription.isUltime,
        isTrialing: subscription.isTrialing,
        trialEndsAt: subscription.trialEndsAt,
        hasUsedTrial: subscription.hasUsedTrial,
      })}
    </output>
  );
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <AuthProvider><SubscriptionProbe /></AuthProvider>
  </QueryClientProvider>,
);
