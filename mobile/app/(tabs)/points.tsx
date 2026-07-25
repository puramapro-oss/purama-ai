import { View, Text, ScrollView, RefreshControl, TouchableOpacity } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { usePoints } from "@/hooks/usePoints";
import { useDailyGift } from "@/hooks/useDailyGift";
import { GlassCard } from "@/components/ui/GlassCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatDate } from "@/lib/utils";
import { COLORS } from "@/lib/constants";
import { useState } from "react";
import Animated, { useSharedValue, useAnimatedStyle, withSpring, withSequence } from "react-native-reanimated";

export default function PointsScreen() {
  const { balance, lifetimeEarned, transactions, loading, refresh } = usePoints();
  const { canOpen, streak, todayGift, openGift } = useDailyGift();
  const [giftResult, setGiftResult] = useState<string | null>(null);
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handleOpenGift = async () => {
    scale.value = withSequence(withSpring(1.2), withSpring(1));
    const gift = await openGift();
    if (gift) {
      const labels: Record<string, string> = {
        points: `+${gift.gift_value} points`,
        coupon: `-${gift.gift_value}% de reduction`,
        ticket: `${gift.gift_value} ticket(s) loterie`,
        credits: `+${gift.gift_value} credits IA`,
      };
      setGiftResult(labels[gift.gift_type] ?? gift.gift_value);
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-background" edges={["top"]}>
      <ScrollView
        className="flex-1 px-4"
        refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} tintColor={COLORS.accent} />}
        showsVerticalScrollIndicator={false}
      >
        <Text className="text-white text-2xl font-bold mt-2 mb-6">Points Purama</Text>

        {/* Balance */}
        <GlassCard className="mb-4 items-center py-6">
          <Text className="text-white/50 text-sm">Solde actuel</Text>
          <Text className="text-accent text-4xl font-bold mt-2">{balance.toLocaleString()}</Text>
          <Text className="text-white/30 text-xs mt-1">= {(balance * 0.01).toFixed(2)} euros</Text>
          <Text className="text-white/20 text-xs mt-1">{lifetimeEarned.toLocaleString()} pts gagnes au total</Text>
        </GlassCard>

        {/* Daily Gift */}
        <Animated.View style={animatedStyle}>
          <TouchableOpacity
            testID="open-daily-gift"
            onPress={canOpen ? handleOpenGift : undefined}
            activeOpacity={canOpen ? 0.7 : 1}
          >
            <GlassCard className={`mb-6 items-center py-6 ${canOpen ? "border-amber-500/30" : ""}`}>
              <Ionicons
                name={canOpen ? "gift" : "gift-outline"}
                size={40}
                color={canOpen ? "#F59E0B" : "rgba(255,255,255,0.2)"}
              />
              {giftResult ? (
                <Text className="text-amber-400 text-lg font-bold mt-3">{giftResult}</Text>
              ) : canOpen ? (
                <Text className="text-amber-400 font-bold mt-3">Ouvre ton coffre du jour !</Text>
              ) : (
                <Text className="text-white/40 mt-3">Coffre deja ouvert aujourd'hui</Text>
              )}
              <Text className="text-white/30 text-xs mt-2">Streak : {streak} jour(s)</Text>
            </GlassCard>
          </TouchableOpacity>
        </Animated.View>

        {/* How to earn */}
        <Text className="text-white text-lg font-bold mb-3">Comment gagner</Text>
        <View className="flex-row flex-wrap gap-2 mb-6">
          {[
            { label: "Inscription", pts: "+100" },
            { label: "Parrainage", pts: "+200" },
            { label: "Streak/j", pts: "+10" },
            { label: "Partage", pts: "+300" },
            { label: "Feedback", pts: "+200" },
            { label: "Avis store", pts: "+500" },
          ].map((item) => (
            <View key={item.label} className="bg-white/5 rounded-xl px-3 py-2 flex-row items-center gap-2">
              <Text className="text-accent text-xs font-bold">{item.pts}</Text>
              <Text className="text-white/50 text-xs">{item.label}</Text>
            </View>
          ))}
        </View>

        {/* Transactions */}
        <Text className="text-white text-lg font-bold mb-3">Historique</Text>
        {transactions.length === 0 ? (
          <EmptyState icon="diamond-outline" title="Aucun mouvement" description="Tes points apparaitront ici" />
        ) : (
          transactions.map((tx) => (
            <GlassCard key={tx.id} className="mb-2">
              <View className="flex-row items-center justify-between">
                <View>
                  <Text className="text-white text-sm font-medium">{tx.type}</Text>
                  <Text className="text-white/30 text-xs">{formatDate(tx.created_at)}</Text>
                </View>
                <Text className={`font-bold ${tx.amount > 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {tx.amount > 0 ? "+" : ""}{tx.amount}
                </Text>
              </View>
            </GlassCard>
          ))
        )}

        <View className="h-8" />
      </ScrollView>
    </SafeAreaView>
  );
}
