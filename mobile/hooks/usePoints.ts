import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "./useAuth";

interface PointTransaction {
  id: string;
  amount: number;
  type: string;
  source_app: string;
  created_at: string;
}

export function usePoints() {
  const { user } = useAuth();
  const [balance, setBalance] = useState(0);
  const [lifetimeEarned, setLifetimeEarned] = useState(0);
  const [transactions, setTransactions] = useState<PointTransaction[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchPoints = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const { data: points } = await supabase
        .from("purama_points")
        .select("balance, lifetime_earned")
        .eq("user_id", user.id)
        .single();

      if (points) {
        setBalance(points.balance ?? 0);
        setLifetimeEarned(points.lifetime_earned ?? 0);
      }

      const { data: txns } = await supabase
        .from("point_transactions")
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
    fetchPoints();
  }, [fetchPoints]);

  return { balance, lifetimeEarned, transactions, loading, refresh: fetchPoints };
}
