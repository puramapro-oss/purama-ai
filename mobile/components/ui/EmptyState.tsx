import { View, Text } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Button } from "./Button";

interface EmptyStateProps {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({ icon = "folder-open-outline", title, description, actionLabel, onAction }: EmptyStateProps) {
  return (
    <View className="flex-1 items-center justify-center py-16 px-8">
      <Ionicons name={icon} size={48} color="rgba(255,255,255,0.2)" />
      <Text className="text-white/60 text-lg font-semibold mt-4 text-center">{title}</Text>
      {description && (
        <Text className="text-white/40 text-sm mt-2 text-center">{description}</Text>
      )}
      {actionLabel && onAction && (
        <Button title={actionLabel} onPress={onAction} className="mt-6" />
      )}
    </View>
  );
}
