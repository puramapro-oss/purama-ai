import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "./useAuth";

interface WalletTransaction {
  id: string;
  amount: number;
  type: string;
  description: string;
  created_at: string;
}

export function useWallet() {
  const { user } = useAuth();
  const [balance, setBalance] = useState(0);
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchWallet = useCallback(async () => {
    if (!user) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const purama = supabase.schema("purama_ai");
      const { data: wallet, error: walletError } = await purama
        .from("wallets")
        .select("balance")
        .eq("user_id", user.id)
        .maybeSingle();

      if (walletError) throw walletError;

      setBalance(wallet?.balance ?? 0);

      const { data: txns, error: transactionsError } = await purama
        .from("wallet_transactions")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(50);

      if (transactionsError) throw transactionsError;
      if (txns) setTransactions(txns);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Impossible de charger le wallet");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchWallet();
  }, [fetchWallet]);

  const requestWithdrawal = async (amount: number, iban: string, beneficiaryName: string) => {
    if (!user || amount < 5 || amount > balance) {
      return { error: "Montant invalide ou solde insuffisant" };
    }
    if (!beneficiaryName.trim()) return { error: "Le nom du beneficiaire est requis" };

    const { error } = await supabase.schema("purama_ai").from("withdrawals").insert({
      user_id: user.id,
      amount,
      iban,
      beneficiary_name: beneficiaryName.trim(),
      status: "pending",
    });

    if (!error) {
      await fetchWallet();
    }
    return { error: error?.message ?? null };
  };

  return { balance, transactions, loading, error, refresh: fetchWallet, requestWithdrawal };
}
