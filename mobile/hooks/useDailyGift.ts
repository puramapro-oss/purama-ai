import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "./useAuth";
import { APP_SLUG } from "@/lib/constants";

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

  const checkGift = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const today = new Date().toISOString().split("T")[0];
      const { data } = await supabase
        .from("daily_gifts")
        .select("*")
        .eq("user_id", user.id)
        .eq("app_slug", APP_SLUG)
        .gte("opened_at", today)
        .order("opened_at", { ascending: false })
        .limit(1);

      if (data && data.length > 0) {
        setTodayGift(data[0]);
        setCanOpen(false);
        setStreak(data[0].streak_count);
      } else {
        setCanOpen(true);
        const { data: lastGift } = await supabase
          .from("daily_gifts")
          .select("streak_count, opened_at")
          .eq("user_id", user.id)
          .eq("app_slug", APP_SLUG)
          .order("opened_at", { ascending: false })
          .limit(1);

        if (lastGift && lastGift.length > 0) {
          const lastDate = new Date(lastGift[0].opened_at);
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          setStreak(
            lastDate.toDateString() === yesterday.toDateString()
              ? lastGift[0].streak_count
              : 0
          );
        }
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    checkGift();
  }, [checkGift]);

  const openGift = async () => {
    if (!user || !canOpen) return null;

    const rand = Math.random() * 100;
    let giftType: string;
    let giftValue: string;

    if (rand < 40) {
      giftType = "points";
      giftValue = String(Math.floor(Math.random() * 16) + 5);
    } else if (rand < 65) {
      giftType = "coupon";
      giftValue = Math.random() < 0.5 ? "5" : "10";
    } else if (rand < 80) {
      giftType = "ticket";
      giftValue = "1";
    } else if (rand < 90) {
      giftType = "credits";
      giftValue = "3";
    } else if (rand < 95) {
      giftType = "coupon";
      giftValue = "20";
    } else if (rand < 98) {
      giftType = "points";
      giftValue = String(Math.floor(Math.random() * 51) + 50);
    } else {
      giftType = "coupon";
      giftValue = "50";
    }

    const newStreak = streak + 1;
    const { data, error } = await supabase
      .from("daily_gifts")
      .insert({
        user_id: user.id,
        app_slug: APP_SLUG,
        gift_type: giftType,
        gift_value: giftValue,
        streak_count: newStreak,
      })
      .select()
      .single();

    if (!error && data) {
      setTodayGift(data);
      setCanOpen(false);
      setStreak(newStreak);
    }

    return data;
  };

  return { todayGift, canOpen, streak, loading, openGift, refresh: checkGift };
}
