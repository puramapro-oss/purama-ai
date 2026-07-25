import { View, ActivityIndicator, Text } from "react-native";
import { COLORS } from "@/lib/constants";

interface LoadingScreenProps {
  message?: string;
}

export function LoadingScreen({ message }: LoadingScreenProps) {
  return (
    <View className="flex-1 items-center justify-center bg-background">
      <ActivityIndicator size="large" color={COLORS.accent} />
      {message && (
        <Text className="text-white/50 text-sm mt-4">{message}</Text>
      )}
    </View>
  );
}
