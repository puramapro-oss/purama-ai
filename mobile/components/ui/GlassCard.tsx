import { View, ViewProps } from "react-native";

interface GlassCardProps extends ViewProps {
  children: React.ReactNode;
  className?: string;
}

export function GlassCard({ children, className = "", style, ...props }: GlassCardProps) {
  return (
    <View
      className={`rounded-2xl border border-white/[0.06] bg-white/5 p-4 ${className}`}
      style={[{ overflow: "hidden" }, style]}
      {...props}
    >
      {children}
    </View>
  );
}
