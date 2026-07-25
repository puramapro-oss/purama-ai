import { TextInput, View, Text, TextInputProps } from "react-native";
import { COLORS } from "@/lib/constants";

interface InputProps extends TextInputProps {
  label?: string;
  error?: string;
  testID?: string;
}

export function Input({ label, error, className = "", testID, ...props }: InputProps) {
  return (
    <View className="mb-4">
      {label && (
        <Text className="text-white/70 text-sm mb-1.5 font-medium">{label}</Text>
      )}
      <TextInput
        testID={testID}
        className={`bg-white/5 border rounded-xl px-4 py-3.5 text-white text-base ${
          error ? "border-red-500/50" : "border-white/[0.06]"
        } ${className}`}
        placeholderTextColor={COLORS.textSecondary}
        selectionColor={COLORS.accent}
        {...props}
      />
      {error && (
        <Text className="text-red-400 text-xs mt-1">{error}</Text>
      )}
    </View>
  );
}
