import { useState, useRef, useEffect } from "react";
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  KeyboardAvoidingView, Platform, ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { AGENTS, useAgentChat } from "@/hooks/useAgents";
import { COLORS } from "@/lib/constants";
import * as Haptics from "expo-haptics";
import Animated, { FadeInDown } from "react-native-reanimated";

export default function AgentChatScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const agent = AGENTS.find((a) => a.slug === slug);
  const { messages, loading, sendMessage } = useAgentChat(agent!);
  const [input, setInput] = useState("");
  const flatListRef = useRef<FlatList>(null);

  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [messages]);

  if (!agent) {
    return (
      <SafeAreaView className="flex-1 bg-background items-center justify-center">
        <Text className="text-white/50">Agent introuvable</Text>
        <TouchableOpacity onPress={() => router.back()} className="mt-4">
          <Text className="text-accent">Retour</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const handleSend = () => {
    if (!input.trim()) return;
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    sendMessage(input.trim());
    setInput("");
  };

  return (
    <SafeAreaView className="flex-1 bg-background" edges={["top"]}>
      {/* Header */}
      <View className="flex-row items-center px-4 py-3 border-b border-white/[0.06]">
        <TouchableOpacity testID="agent-back" onPress={() => router.back()} className="mr-3">
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <View
          className="w-10 h-10 rounded-xl items-center justify-center mr-3"
          style={{ backgroundColor: agent.color + "20" }}
        >
          <Ionicons name="sparkles" size={20} color={agent.color} />
        </View>
        <View className="flex-1">
          <Text className="text-white font-bold">{agent.name}</Text>
          <Text className="text-white/40 text-xs">{agent.category}</Text>
        </View>
        <TouchableOpacity testID="agent-clear" onPress={() => {}} className="p-2">
          <Ionicons name="trash-outline" size={20} color="rgba(255,255,255,0.3)" />
        </TouchableOpacity>
      </View>

      {/* Messages */}
      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={{ padding: 16, paddingBottom: 8 }}
        showsVerticalScrollIndicator={false}
        renderItem={({ item, index }) => (
          <Animated.View
            entering={FadeInDown.delay(50).springify()}
            className={`mb-3 max-w-[85%] ${item.role === "user" ? "self-end" : "self-start"}`}
          >
            <View
              className={`rounded-2xl px-4 py-3 ${
                item.role === "user"
                  ? "bg-accent rounded-tr-sm"
                  : "bg-white/5 border border-white/[0.06] rounded-tl-sm"
              }`}
            >
              <Text className="text-white text-sm leading-5">{item.content}</Text>
            </View>
          </Animated.View>
        )}
        ListEmptyComponent={() => (
          <View className="flex-1 items-center justify-center py-20">
            <View
              className="w-16 h-16 rounded-2xl items-center justify-center mb-4"
              style={{ backgroundColor: agent.color + "20" }}
            >
              <Ionicons name="sparkles" size={32} color={agent.color} />
            </View>
            <Text className="text-white font-bold text-lg">{agent.name}</Text>
            <Text className="text-white/40 text-sm mt-2 text-center px-8">{agent.description}</Text>
            <Text className="text-white/20 text-xs mt-4">Ecris un message pour commencer</Text>
          </View>
        )}
      />

      {loading && (
        <View className="px-4 pb-2">
          <View className="bg-white/5 rounded-2xl rounded-tl-sm px-4 py-3 self-start">
            <ActivityIndicator size="small" color={COLORS.accent} />
          </View>
        </View>
      )}

      {/* Input */}
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View className="flex-row items-end px-4 py-3 border-t border-white/[0.06] gap-3">
          <TextInput
            testID="agent-input"
            className="flex-1 bg-white/5 border border-white/[0.06] rounded-2xl px-4 py-3 text-white text-base max-h-28"
            placeholder="Ecris ton message..."
            placeholderTextColor="rgba(255,255,255,0.3)"
            value={input}
            onChangeText={setInput}
            multiline
            selectionColor={COLORS.accent}
            onSubmitEditing={handleSend}
          />
          <TouchableOpacity
            testID="agent-send"
            onPress={handleSend}
            disabled={!input.trim() || loading}
            className={`w-12 h-12 rounded-full items-center justify-center ${input.trim() && !loading ? "bg-accent" : "bg-white/10"}`}
            activeOpacity={0.7}
          >
            <Ionicons name="send" size={18} color={input.trim() && !loading ? "#fff" : "rgba(255,255,255,0.3)"} />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
