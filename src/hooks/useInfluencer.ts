import { useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { isValidReferralCode } from '@/lib/public-share';

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

// A withdrawal belongs to this document, not to one mounted component.
// Revision checks prevent an older capture from reviving it or clearing a newer capture.
let referralRevision = 0;
let referralWithdrawn = false;

// Hook for tracking referrals
export function useReferralTracking() {
  const captureFailedAt = useRef<number | null>(null);

  const clearReferral = useCallback(() => {
    referralWithdrawn = true;
    captureFailedAt.current = ++referralRevision;
    try {
      localStorage.removeItem('referral_code');
      localStorage.removeItem('referral_timestamp');
      return localStorage.getItem('referral_code') === null
        && localStorage.getItem('referral_timestamp') === null;
    } catch {
      // A browser may deny storage. Referral tracking must not block navigation.
      return false;
    }
  }, []);

  const checkAndStoreReferral = useCallback((search = window.location.search) => {
    const referrals = new URLSearchParams(search).getAll('ref');
    if (referrals.length !== 1 || !isValidReferralCode(referrals[0])) return null;
    const code = referrals[0].toUpperCase();
    const revision = ++referralRevision;
    const current = () => referralRevision === revision;
    captureFailedAt.current = revision;
    try {
      const timestamp = Date.now().toString();
      // Keep both historical keys. Invalidate first and commit the code last, so
      // even denied cleanup cannot join a new code to a previous timestamp.
      // The decimal prefix stays readable by the historical parseInt reader.
      const receipt = `${timestamp}:${encodeURIComponent(code)}`;
      localStorage.setItem('referral_code', '');
      if (!current()) return null;
      localStorage.setItem('referral_timestamp', receipt);
      if (!current()) return null;
      localStorage.setItem('referral_code', code);
      if (!current()) return null;
      const storedCode = localStorage.getItem('referral_code');
      if (!current()) return null;
      const storedReceipt = localStorage.getItem('referral_timestamp');
      if (!current()) return null;
      if (storedCode !== code || storedReceipt !== receipt) {
        clearReferral();
        return null;
      }
      referralWithdrawn = false;
      captureFailedAt.current = null;
      return code;
    } catch {
      // Never reuse a partial capture, or clear a newer capture after this one was superseded.
      if (current()) clearReferral();
      return null;
    }
  }, [clearReferral]);

  const getStoredReferral = useCallback((): { code: string; timestamp: number } | null => {
    if (referralWithdrawn || captureFailedAt.current === referralRevision) return null;
    const revision = referralRevision;
    try {
      const storedCode = localStorage.getItem('referral_code');
      const storedTimestamp = localStorage.getItem('referral_timestamp');
      if (referralWithdrawn || referralRevision !== revision) return null;
      if (!storedCode || !storedTimestamp) return null;
      if (!isValidReferralCode(storedCode)) {
        clearReferral();
        return null;
      }
      const code = storedCode.toUpperCase();
      const [timestampText, encodedCode, ...extra] = storedTimestamp.split(':');
      const timestamp = Number(timestampText);
      const now = Date.now();
      // Keep the existing 30-day window; malformed dates must not make it infinite.
      // Plain decimal dates remain valid for pre-existing records. New captures
      // bind the timestamp to the code, including across remounts or reloads.
      const thirtyDays = 30 * 24 * 60 * 60 * 1000;
      if (extra.length || (encodedCode !== undefined && decodeURIComponent(encodedCode) !== code)
        || !/^\d+$/.test(timestampText) || !Number.isSafeInteger(timestamp)
        || timestamp > now || now - timestamp > thirtyDays) {
        clearReferral();
        return null;
      }
      return { code, timestamp };
    } catch {
      return null;
    }
  }, [clearReferral]);

  return {
    checkAndStoreReferral,
    getStoredReferral,
    clearReferral,
  };
}

// Admin hook for managing all influencers
export function useInfluencerAdmin() {
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

  return {
    allInfluencers,
    allCommissions,
    isLoading,
  };
}
