import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "./useAuth";

interface DailyGift {
  gift_type: string;
  gift_value: string;
  streak_count: number;
  opened_at: string;
}

export function useDailyGift() {
  const { user } = useAuth();
  const [todayGift, setTodayGift] = useState<DailyGift | null>(null);
  const [canOpen, setCanOpen] = useState(false);
  const [streak, setStreak] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const checkGift = useCallback(async () => {
    if (!user) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const today = new Date().toISOString().split("T")[0];
      const { data, error: giftError } = await supabase.schema("purama_ai")
        .from("daily_gifts")
        .select("*")
        .eq("user_id", user.id)
        .eq("gift_day", today)
        .order("opened_at", { ascending: false })
        .limit(1);

      if (giftError) throw giftError;

      if (data && data.length > 0) {
        setTodayGift(data[0]);
        setCanOpen(false);
        setStreak(data[0].streak_count);
      } else {
        setCanOpen(true);
        const { data: points, error: pointsError } = await supabase
          .from("purama_points")
          .select("streak_days")
          .eq("user_id", user.id)
          .maybeSingle();
        if (pointsError) throw pointsError;
        setStreak(points?.streak_days ?? 0);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Impossible de charger le cadeau quotidien");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    checkGift();
  }, [checkGift]);

  const openGift = async () => {
    if (!user || !canOpen) return null;

    const { data, error } = await supabase.rpc("claim_daily_gift");

    if (!error && data) {
      const result = data as Record<string, unknown>;
      const gift: DailyGift = {
        gift_type: String(result.gift_type),
        gift_value: String(result.gift_value),
        streak_count: Number(result.streak_count),
        opened_at: String(result.opened_at),
      };
      setTodayGift(gift);
      setStreak(gift.streak_count);
      setCanOpen(false);
      return gift;
    }
    if (error) setError(error.message);
    return null;
  };

  return { todayGift, canOpen, streak, loading, error, openGift, refresh: checkGift };
}
