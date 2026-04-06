import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';

export interface Influencer {
  id: string;
  user_id: string;
  promo_code: string;
  affiliation_link: string;
  commission_rate: number;
  commission_tier: 'bronze' | 'silver' | 'gold';
  total_revenue: number;
  total_sales: number;
  contract_status: 'pending' | 'signed' | 'expired';
  contract_signed_at: string | null;
  iban: string | null;
  beneficiary_name: string | null;
  created_at: string;
  expires_at: string;
  updated_at: string;
}

// Commission tier configuration
export const COMMISSION_TIERS = {
  bronze: {
    name: 'Bronze',
    rate: 9.99,
    minSales: 0,
    maxSales: 19,
    color: 'text-amber-600',
    bgColor: 'bg-amber-500/20',
    borderColor: 'border-amber-500/30',
    icon: '🥉',
  },
  silver: {
    name: 'Silver',
    rate: 19.99,
    minSales: 20,
    maxSales: 49,
    color: 'text-slate-400',
    bgColor: 'bg-slate-400/20',
    borderColor: 'border-slate-400/30',
    icon: '🥈',
  },
  gold: {
    name: 'Gold',
    rate: 33,
    minSales: 50,
    maxSales: Infinity,
    color: 'text-yellow-500',
    bgColor: 'bg-yellow-500/20',
    borderColor: 'border-yellow-500/30',
    icon: '🥇',
  },
} as const;

export function getTierProgress(totalSales: number, currentTier: string) {
  if (currentTier === 'gold') {
    return { progress: 100, nextTier: null, salesNeeded: 0 };
  }
  
  if (currentTier === 'silver') {
    const salesNeeded = 50 - totalSales;
    const progress = ((totalSales - 20) / 30) * 100;
    return { progress: Math.min(progress, 100), nextTier: 'gold', salesNeeded };
  }
  
  // Bronze
  const salesNeeded = 20 - totalSales;
  const progress = (totalSales / 20) * 100;
  return { progress: Math.min(progress, 100), nextTier: 'silver', salesNeeded };
}

export interface Commission {
  id: string;
  influencer_id: string;
  client_id: string;
  sale_amount: number;
  commission_amount: number;
  status: 'pending' | 'validated' | 'paid' | 'cancelled';
  payment_date: string | null;
  subscription_id: string | null;
  created_at: string;
}

const BASE_URL = (import.meta.env.VITE_APP_URL as string) || 'https://purama-ai.purama.dev';

export function useInfluencer() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const { data: influencer, isLoading } = useQuery({
    queryKey: ['influencer', user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      
      const { data, error } = await supabase
        .from('influencers')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();
      
      if (error) throw error;
      return data as Influencer | null;
    },
    enabled: !!user?.id,
  });

  const { data: commissions = [], isLoading: commissionsLoading } = useQuery({
    queryKey: ['commissions', influencer?.id],
    queryFn: async () => {
      if (!influencer?.id) return [];
      
      const { data, error } = await supabase
        .from('commissions')
        .select('*')
        .eq('influencer_id', influencer.id)
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      return data as Commission[];
    },
    enabled: !!influencer?.id,
  });

  const registerAsInfluencer = useMutation({
    mutationFn: async (name: string) => {
      if (!user?.id) throw new Error('Non authentifié');

      // Generate promo code
      const { data: promoCode, error: codeError } = await supabase
        .rpc('generate_promo_code', { influencer_name: name });

      if (codeError) throw codeError;

      const affiliationLink = `${BASE_URL}/?ref=${promoCode}`;

      const { data, error } = await supabase
        .from('influencers')
        .insert({
          user_id: user.id,
          promo_code: promoCode,
          affiliation_link: affiliationLink,
          beneficiary_name: name,
        })
        .select()
        .single();

      if (error) throw error;
      return data as Influencer;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['influencer', user?.id] });
      toast.success('Inscription influenceur réussie !');
    },
    onError: (error) => {
      toast.error('Erreur lors de l\'inscription', {
        description: error.message,
      });
    },
  });

  const regenerateLink = useMutation({
    mutationFn: async () => {
      if (!influencer?.id || !user?.id) throw new Error('Non authentifié');

      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + 1);

      const { error } = await supabase
        .from('influencers')
        .update({
          expires_at: expiresAt.toISOString(),
        })
        .eq('id', influencer.id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['influencer', user?.id] });
      toast.success('Lien renouvelé pour 1 mois !');
    },
  });

  const signContract = useMutation({
    mutationFn: async () => {
      if (!influencer?.id) throw new Error('Pas de profil influenceur');

      const { error } = await supabase
        .from('influencers')
        .update({
          contract_status: 'signed',
          contract_signed_at: new Date().toISOString(),
        })
        .eq('id', influencer.id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['influencer', user?.id] });
      toast.success('Contrat signé avec succès !');
    },
  });

  const updateBankDetails = useMutation({
    mutationFn: async ({ iban, beneficiaryName }: { iban: string; beneficiaryName: string }) => {
      if (!influencer?.id) throw new Error('Pas de profil influenceur');

      const { error } = await supabase
        .from('influencers')
        .update({
          iban,
          beneficiary_name: beneficiaryName,
        })
        .eq('id', influencer.id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['influencer', user?.id] });
      toast.success('Coordonnées bancaires mises à jour !');
    },
  });

  const isExpired = influencer ? new Date(influencer.expires_at) < new Date() : false;

  return {
    influencer,
    commissions,
    isLoading,
    commissionsLoading,
    isExpired,
    registerAsInfluencer,
    regenerateLink,
    signContract,
    updateBankDetails,
  };
}

// Hook for tracking referrals
export function useReferralTracking() {
  const checkAndStoreReferral = () => {
    const urlParams = new URLSearchParams(window.location.search);
    const refCode = urlParams.get('ref');
    
    if (refCode) {
      localStorage.setItem('referral_code', refCode.toUpperCase());
      localStorage.setItem('referral_timestamp', Date.now().toString());
      return refCode.toUpperCase();
    }
    
    return null;
  };

  const getStoredReferral = (): { code: string; timestamp: number } | null => {
    const code = localStorage.getItem('referral_code');
    const timestamp = localStorage.getItem('referral_timestamp');
    
    if (!code || !timestamp) return null;
    
    // Check if referral is still valid (within 30 days)
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - parseInt(timestamp) > thirtyDays) {
      localStorage.removeItem('referral_code');
      localStorage.removeItem('referral_timestamp');
      return null;
    }
    
    return { code, timestamp: parseInt(timestamp) };
  };

  const clearReferral = () => {
    localStorage.removeItem('referral_code');
    localStorage.removeItem('referral_timestamp');
  };

  return {
    checkAndStoreReferral,
    getStoredReferral,
    clearReferral,
  };
}

// Admin hook for managing all influencers
export function useInfluencerAdmin() {
  const queryClient = useQueryClient();

  const { data: allInfluencers = [], isLoading } = useQuery({
    queryKey: ['admin-influencers'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('influencers')
        .select('*')
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      return data as Influencer[];
    },
  });

  const { data: allCommissions = [] } = useQuery({
    queryKey: ['admin-commissions'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('commissions')
        .select('*')
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      return data as Commission[];
    },
  });

  const markCommissionPaid = useMutation({
    mutationFn: async (commissionId: string) => {
      const { error } = await supabase
        .from('commissions')
        .update({
          status: 'paid',
          payment_date: new Date().toISOString(),
        })
        .eq('id', commissionId);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-commissions'] });
      queryClient.invalidateQueries({ queryKey: ['admin-influencers'] });
      toast.success('Commission marquée comme payée');
    },
  });

  return {
    allInfluencers,
    allCommissions,
    isLoading,
    markCommissionPaid,
  };
}
