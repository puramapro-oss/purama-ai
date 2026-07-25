import { View, Text } from "react-native";

interface BadgeProps {
  text: string;
  variant?: "default" | "success" | "warning" | "error" | "accent";
  className?: string;
}

const variantStyles = {
  default: "bg-white/10",
  success: "bg-emerald-500/20",
  warning: "bg-amber-500/20",
  error: "bg-red-500/20",
  accent: "bg-violet-500/20",
};

const textStyles = {
  default: "text-white/70",
  success: "text-emerald-400",
  warning: "text-amber-400",
  error: "text-red-400",
  accent: "text-violet-400",
};

export function Badge({ text, variant = "default", className = "" }: BadgeProps) {
  return (
    <View className={`rounded-full px-3 py-1 ${variantStyles[variant]} ${className}`}>
      <Text className={`text-xs font-medium ${textStyles[variant]}`}>{text}</Text>
    </View>
  );
}
