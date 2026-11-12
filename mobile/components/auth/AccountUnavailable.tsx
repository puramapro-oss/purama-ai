import { ScrollView, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Button } from "@/components/ui/Button";
import { COLORS } from "@/lib/constants";

/** Recoverable account startup failure; no account data or credentials are shown. */
export function AccountUnavailable({ message }: { message: string }) {
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: COLORS.background }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 24, gap: 24 }}>
        <Text accessibilityRole="header" style={{ color: COLORS.text, fontSize: 28, fontWeight: "700" }}>
          Espace compte indisponible
        </Text>
        <Text style={{ color: COLORS.text, fontSize: 20, lineHeight: 30 }}>{message}</Text>
        <Text style={{ color: COLORS.textSecondary, fontSize: 18, lineHeight: 28 }}>
          Vous pouvez continuer à communiquer par écrit sans compte, puis réessayer l’espace compte depuis l’accueil.
        </Text>
        <Button testID="account-unavailable-communication" title="Communiquer par écrit"
          onPress={() => router.replace("/communication")} style={{ minHeight: 56 }}
          textStyle={{ fontSize: 20, textAlign: "center" }} />
      </ScrollView>
    </SafeAreaView>
  );
}
