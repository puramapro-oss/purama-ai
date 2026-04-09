import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { toast } from 'sonner';

export function useWallet() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['wallet', user?.id],
    queryFn: async () => {
      if (!user) return null;
      const { data, error } = await supabase
        .from('wallets')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!user,
  });
}

export function useWalletTransactions() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['wallet-transactions', user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await supabase
        .from('wallet_transactions')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data || [];
    },
    enabled: !!user,
  });
}

export function useWithdrawals() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['withdrawals', user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await supabase
        .from('withdrawals')
        .select('*')
        .eq('user_id', user.id)
        .order('requested_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    enabled: !!user,
  });
}

export function useRequestWithdrawal() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ amount, iban, beneficiaryName }: { amount: number; iban: string; beneficiaryName: string }) => {
      if (!user) throw new Error('Non connecté');
      if (amount < 5) throw new Error('Montant minimum : 5€');

      const { error } = await supabase
        .from('withdrawals')
        .insert({
          user_id: user.id,
          amount,
          iban,
          beneficiary_name: beneficiaryName,
        });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['wallet'] });
      queryClient.invalidateQueries({ queryKey: ['withdrawals'] });
      toast.success('Demande de retrait envoyée ! Traitement sous 3-5 jours ouvrés.');
    },
    onError: (err: Error) => {
      toast.error(err.message || 'Erreur lors de la demande de retrait');
    },
  });
}
