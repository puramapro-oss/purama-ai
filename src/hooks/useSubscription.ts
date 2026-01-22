import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';

export interface SubscriptionInfo {
  planType: 'none' | 'starter' | 'premium';
  subscriptionEnd: string | null;
  isLoading: boolean;
}

export const PLANS = {
  starter: {
    id: 'starter',
    name: 'Starter',
    price: 33,
    priceId: 'price_1SsT3a4Y1unNvKtXMIU8MvN6',
    productId: 'prod_Tq9M8BqZXnWp8A',
    maxAgents: 5,
  },
  premium: {
    id: 'premium',
    name: 'Premium',
    price: 99,
    priceId: 'price_1SsT7x4Y1unNvKtXvRnyLp4W',
    productId: 'prod_Tq9Q2m69e3A5h4',
    maxAgents: 45,
  },
} as const;

export function useSubscription() {
  const { user } = useAuth();
  const [subscription, setSubscription] = useState<SubscriptionInfo>({
    planType: 'none',
    subscriptionEnd: null,
    isLoading: true,
  });

  const checkSubscription = useCallback(async () => {
    if (!user) {
      setSubscription({ planType: 'none', subscriptionEnd: null, isLoading: false });
      return;
    }

    try {
      const { data, error } = await supabase.functions.invoke('check-subscription');
      
      if (error) throw error;
      
      if (data) {
        let planType: 'none' | 'starter' | 'premium' = 'none';
        
        if (data.subscribed && data.product_id) {
          if (data.product_id === PLANS.premium.productId) {
            planType = 'premium';
          } else if (data.product_id === PLANS.starter.productId) {
            planType = 'starter';
          }
        }
        
        setSubscription({
          planType,
          subscriptionEnd: data.subscription_end || null,
          isLoading: false,
        });
      }
    } catch (err) {
      console.error('Error checking subscription:', err);
      setSubscription(prev => ({ ...prev, isLoading: false }));
    }
  }, [user]);

  useEffect(() => {
    checkSubscription();
  }, [checkSubscription]);

  return {
    ...subscription,
    refresh: checkSubscription,
    hasSubscription: subscription.planType !== 'none',
    isStarter: subscription.planType === 'starter',
    isPremium: subscription.planType === 'premium',
  };
}
