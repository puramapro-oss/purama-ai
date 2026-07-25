import { TouchableOpacity, Text, ActivityIndicator, ViewStyle } from "react-native";
import { COLORS } from "@/lib/constants";

interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  loading?: boolean;
  disabled?: boolean;
  className?: string;
  style?: ViewStyle;
  testID?: string;
}

export function Button({
  title,
  onPress,
  variant = "primary",
  loading = false,
  disabled = false,
  className = "",
  style,
  testID,
}: ButtonProps) {
  const isDisabled = disabled || loading;

  const baseClass = "rounded-xl px-6 py-3.5 items-center justify-center flex-row";
  const variantClass = {
    primary: "bg-accent",
    secondary: "bg-white/10 border border-white/[0.06]",
    ghost: "bg-transparent",
    danger: "bg-red-500/20 border border-red-500/30",
  }[variant];

  const textClass = {
    primary: "text-white font-semibold text-base",
    secondary: "text-white font-medium text-base",
    ghost: "text-accent font-medium text-base",
    danger: "text-red-400 font-medium text-base",
  }[variant];

  return (
    <TouchableOpacity
      testID={testID}
      onPress={onPress}
      disabled={isDisabled}
      className={`${baseClass} ${variantClass} ${isDisabled ? "opacity-50" : ""} ${className}`}
      style={style}
      activeOpacity={0.7}
    >
      {loading ? (
        <ActivityIndicator color={variant === "primary" ? "#fff" : COLORS.accent} size="small" />
      ) : (
        <Text className={textClass}>{title}</Text>
      )}
    </TouchableOpacity>
  );
}
