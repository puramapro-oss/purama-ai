import { View, Text, ScrollView, TouchableOpacity, TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import { GlassCard } from "@/components/ui/GlassCard";
import { Badge } from "@/components/ui/Badge";
import { AGENTS } from "@/hooks/useAgents";
import { COLORS } from "@/lib/constants";

export default function AgentsScreen() {
  const [search, setSearch] = useState("");

  const filtered = AGENTS.filter(
    (a) =>
      a.name.toLowerCase().includes(search.toLowerCase()) ||
      a.category.toLowerCase().includes(search.toLowerCase())
  );

  const categories = [...new Set(AGENTS.map((a) => a.category))];

  return (
    <SafeAreaView className="flex-1 bg-background" edges={["top"]}>
      <ScrollView className="flex-1 px-4" showsVerticalScrollIndicator={false}>
        <Text className="text-white text-2xl font-bold mt-2 mb-4">Agents IA</Text>

        {/* Search */}
        <View className="flex-row items-center bg-white/5 border border-white/[0.06] rounded-xl px-4 py-3 mb-6">
          <Ionicons name="search" size={18} color="rgba(255,255,255,0.4)" />
          <TextInput
            testID="agent-search"
            className="flex-1 ml-3 text-white text-base"
            placeholder="Chercher un agent..."
            placeholderTextColor="rgba(255,255,255,0.3)"
            value={search}
            onChangeText={setSearch}
            selectionColor={COLORS.accent}
          />
        </View>

        {/* Categories */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-6">
          <View className="flex-row gap-2">
            {categories.map((cat) => (
              <TouchableOpacity
                key={cat}
                onPress={() => setSearch(search === cat ? "" : cat)}
                className={`px-4 py-2 rounded-full ${search === cat ? "bg-accent" : "bg-white/5"}`}
              >
                <Text className={`text-sm font-medium ${search === cat ? "text-white" : "text-white/60"}`}>
                  {cat}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>

        {/* Agent list */}
        {filtered.map((agent) => (
          <TouchableOpacity
            key={agent.slug}
            testID={`agent-card-${agent.slug}`}
            onPress={() => router.push(`/agent/${agent.slug}`)}
            activeOpacity={0.7}
            className="mb-3"
          >
            <GlassCard>
              <View className="flex-row items-center gap-3">
                <View
                  className="w-12 h-12 rounded-xl items-center justify-center"
                  style={{ backgroundColor: agent.color + "20" }}
                >
                  <Ionicons name="sparkles" size={24} color={agent.color} />
                </View>
                <View className="flex-1">
                  <View className="flex-row items-center gap-2">
                    <Text className="text-white font-semibold">{agent.name}</Text>
                    {agent.premium && <Badge text="Premium" variant="accent" />}
                  </View>
                  <Text className="text-white/40 text-sm mt-0.5">{agent.description}</Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color="rgba(255,255,255,0.3)" />
              </View>
            </GlassCard>
          </TouchableOpacity>
        ))}

        <View className="h-8" />
      </ScrollView>
    </SafeAreaView>
  );
}
