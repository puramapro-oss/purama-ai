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

  const fetchWallet = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const { data: profile } = await supabase
        .from("profiles")
        .select("wallet_balance")
        .eq("id", user.id)
        .single();

      if (profile) setBalance(profile.wallet_balance ?? 0);

      const { data: txns } = await supabase
        .from("wallet_transactions")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(50);

      if (txns) setTransactions(txns);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchWallet();
  }, [fetchWallet]);

  const requestWithdrawal = async (amount: number, iban: string) => {
    if (!user || amount < 5 || amount > balance) {
      return { error: "Montant invalide ou solde insuffisant" };
    }

    const { error } = await supabase.from("withdrawals").insert({
      user_id: user.id,
      amount,
      iban,
      status: "pending",
    });

    if (!error) {
      await supabase
        .from("profiles")
        .update({ wallet_balance: balance - amount })
        .eq("id", user.id);
      await fetchWallet();
    }
    return { error: error?.message ?? null };
  };

  return { balance, transactions, loading, refresh: fetchWallet, requestWithdrawal };
}
