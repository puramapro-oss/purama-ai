import { View, Text, ScrollView, TouchableOpacity, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { useState, useCallback } from "react";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/hooks/useAuth";
import { useWallet } from "@/hooks/useWallet";
import { usePoints } from "@/hooks/usePoints";
import { useDailyGift } from "@/hooks/useDailyGift";
import { GlassCard } from "@/components/ui/GlassCard";
import { Badge } from "@/components/ui/Badge";
import { AGENTS } from "@/hooks/useAgents";
import { formatPrice } from "@/lib/utils";
import { COLORS } from "@/lib/constants";

export default function DashboardScreen() {
  const { profile } = useAuth();
  const { balance: walletBalance } = useWallet();
  const { balance: pointsBalance } = usePoints();
  const { canOpen, streak } = useDailyGift();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 1000);
  }, []);

  const firstName = profile?.full_name?.split(" ")[0] ?? "toi";

  return (
    <SafeAreaView className="flex-1 bg-background" edges={["top"]}>
      <ScrollView
        className="flex-1 px-4"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.accent} />}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View className="flex-row items-center justify-between mt-2 mb-6">
          <View>
            <Text className="text-white/50 text-sm">Salut</Text>
            <Text className="text-white text-2xl font-bold">{firstName}</Text>
          </View>
          <View className="flex-row gap-3">
            {canOpen && (
              <TouchableOpacity
                testID="daily-gift-btn"
                onPress={() => router.push("/(tabs)/points")}
                className="w-10 h-10 rounded-full bg-amber-500/20 items-center justify-center"
              >
                <Ionicons name="gift" size={20} color="#F59E0B" />
              </TouchableOpacity>
            )}
            <TouchableOpacity
              testID="notifications-btn"
              onPress={() => {}}
              className="w-10 h-10 rounded-full bg-white/5 items-center justify-center"
            >
              <Ionicons name="notifications-outline" size={20} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>

        {/* Stats Cards */}
        <View className="flex-row gap-3 mb-6">
          <GlassCard className="flex-1">
            <Text className="text-white/50 text-xs">Wallet</Text>
            <Text className="text-white text-xl font-bold mt-1">{formatPrice(walletBalance)}</Text>
          </GlassCard>
          <GlassCard className="flex-1">
            <Text className="text-white/50 text-xs">Points</Text>
            <Text className="text-accent text-xl font-bold mt-1">{pointsBalance.toLocaleString()}</Text>
          </GlassCard>
          <GlassCard className="flex-1">
            <Text className="text-white/50 text-xs">Streak</Text>
            <Text className="text-amber-400 text-xl font-bold mt-1">{streak}j</Text>
          </GlassCard>
        </View>

        {/* Plan */}
        <GlassCard className="mb-6">
          <View className="flex-row items-center justify-between">
            <View>
              <Text className="text-white/50 text-xs">Plan actuel</Text>
              <Text className="text-white text-lg font-bold capitalize">{profile?.plan ?? "free"}</Text>
            </View>
            <Badge text={`Niv. ${profile?.level ?? 1}`} variant="accent" />
          </View>
          <View className="flex-row items-center mt-3 gap-2">
            <Text className="text-white/50 text-xs">{profile?.xp ?? 0} XP</Text>
            <View className="flex-1 h-1.5 bg-white/10 rounded-full overflow-hidden">
              <View
                className="h-full bg-accent rounded-full"
                style={{ width: `${Math.min(((profile?.xp ?? 0) % 1000) / 10, 100)}%` }}
              />
            </View>
          </View>
        </GlassCard>

        {/* Quick Agents */}
        <Text className="text-white text-lg font-bold mb-3">Agents rapides</Text>
        <View className="flex-row flex-wrap gap-3 mb-6">
          {AGENTS.slice(0, 4).map((agent) => (
            <TouchableOpacity
              key={agent.slug}
              testID={`agent-${agent.slug}`}
              onPress={() => router.push(`/agent/${agent.slug}`)}
              className="flex-1 min-w-[45%]"
              activeOpacity={0.7}
            >
              <GlassCard>
                <View className="w-10 h-10 rounded-xl items-center justify-center mb-2" style={{ backgroundColor: agent.color + "20" }}>
                  <Ionicons name="sparkles" size={20} color={agent.color} />
                </View>
                <Text className="text-white font-semibold text-sm">{agent.name}</Text>
                <Text className="text-white/40 text-xs mt-1" numberOfLines={1}>{agent.description}</Text>
              </GlassCard>
            </TouchableOpacity>
          ))}
        </View>

        {/* Cross-promo */}
        <GlassCard className="mb-6 border-accent/20">
          <View className="flex-row items-center gap-3">
            <View className="w-10 h-10 rounded-xl bg-accent/20 items-center justify-center">
              <Ionicons name="apps" size={20} color={COLORS.accent} />
            </View>
            <View className="flex-1">
              <Text className="text-white font-semibold text-sm">Decouvre l'ecosysteme Purama</Text>
              <Text className="text-white/40 text-xs mt-0.5">19 apps IA. -50% avec CROSS50</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color="rgba(255,255,255,0.3)" />
          </View>
        </GlassCard>

        <View className="h-8" />
      </ScrollView>
    </SafeAreaView>
  );
}
