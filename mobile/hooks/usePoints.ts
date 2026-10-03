import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "./useAuth";

interface PointTransaction {
  id: string;
  amount: number;
  type: string;
  source: string;
  created_at: string;
}

export function usePoints() {
  const { user } = useAuth();
  const [balance, setBalance] = useState(0);
  const [lifetimeEarned, setLifetimeEarned] = useState(0);
  const [transactions, setTransactions] = useState<PointTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPoints = useCallback(async () => {
    if (!user) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const purama = supabase.schema("purama_ai");
      const { data: points, error: pointsError } = await purama
        .from("purama_points")
        .select("balance, lifetime_earned")
        .eq("user_id", user.id)
        .maybeSingle();

      if (pointsError) throw pointsError;

      if (points) {
        setBalance(points.balance ?? 0);
        setLifetimeEarned(points.lifetime_earned ?? 0);
      }

      const { data: txns, error: transactionsError } = await purama
        .from("point_transactions")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(50);

      if (transactionsError) throw transactionsError;
      if (txns) setTransactions(txns);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Impossible de charger les points");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchPoints();
  }, [fetchPoints]);

  return { balance, lifetimeEarned, transactions, loading, error, refresh: fetchPoints };
}
