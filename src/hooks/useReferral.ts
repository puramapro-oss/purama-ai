import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';

export function useReferralProfile() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['referral-profile', user?.id],
    queryFn: async () => {
      if (!user) return null;
      const { data, error } = await supabase
        .from('profiles')
        .select('code_parrainage, nombre_filleuls, palier_actuel, gains_totaux')
        .eq('user_id', user.id)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: !!user,
  });
}

export function useMyReferrals() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['my-referrals', user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await supabase
        .from('referrals')
        .select('*')
        .eq('parrain_user_id', user.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    enabled: !!user,
  });
}

export function useMyReferralCommissions() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['referral-commissions', user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await supabase
        .from('referral_commissions')
        .select('*')
        .eq('parrain_user_id', user.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    enabled: !!user,
  });
}

export function useMyPaliers() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['my-paliers', user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await supabase
        .from('paliers_parrainage')
        .select('*')
        .eq('user_id', user.id)
        .order('palier', { ascending: true });
      if (error) throw error;
      return data || [];
    },
    enabled: !!user,
  });
}

export const PALIERS = [
  { palier: 1, nom: '🥉 Bronze', filleuls: 10, prime: '1 mois Pro OFFERT + Badge Bronze' },
  { palier: 2, nom: '🥈 Argent', filleuls: 20, prime: '2 mois Pro OFFERTS + Badge Argent + Accès bêta' },
  { palier: 3, nom: '🥇 Or', filleuls: 30, prime: '3 mois Pro OFFERTS + Badge Or + 1 agent exclusif' },
  { palier: 4, nom: '💎 Platine', filleuls: 50, prime: '6 mois Pro OFFERTS + Badge Platine + 3 agents exclusifs' },
  { palier: 5, nom: '👑 Diamant', filleuls: 100, prime: '1 AN Pro OFFERT + Badge Diamant + 15% commission' },
  { palier: 6, nom: '🌟 Légende', filleuls: 200, prime: 'Pro à VIE + Badge Légende + 20% commission' },
  { palier: 7, nom: '🚀 Ambassadeur', filleuls: 500, prime: 'Pro à VIE + 25% commission + Mention sur le site' },
  { palier: 8, nom: '👼 Fondateur', filleuls: 1000, prime: 'Pro à VIE + 30% commission + Co-création agent IA' },
];
