import { ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Button } from "@/components/ui/Button";
import { COLORS } from "@/lib/constants";

export default function Index() {
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: COLORS.background }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 24, gap: 24 }}>
        <Text accessibilityRole="header" style={{ color: COLORS.text, fontSize: 32, fontWeight: "700" }}>
          Bienvenue sur Purama
        </Text>
        <View style={{ gap: 16 }}>
          <Text style={{ color: COLORS.text, fontSize: 22, lineHeight: 32 }}>
            Écrivez un message et montrez-le en grand à la personne avec vous.
          </Text>
          <Text style={{ color: COLORS.textSecondary, fontSize: 18, lineHeight: 28 }}>
            La communication écrite fonctionne sans compte et sans connexion à Internet dans l’application installée.
          </Text>
          <Button
            testID="entry-communication"
            title="Communiquer par écrit"
            onPress={() => router.push("/communication")}
            style={{ minHeight: 60 }}
            textStyle={{ fontSize: 22, textAlign: "center" }}
          />
          <Button
            testID="entry-accessible-one"
            title="Accessible pour moi"
            variant="secondary"
            onPress={() => router.push("/accessible-one")}
            style={{ minHeight: 56 }}
            textStyle={{ fontSize: 20, textAlign: "center" }}
          />
        </View>
        <View style={{ gap: 12 }}>
          <Button
            testID="entry-account"
            title="Ouvrir mon espace compte"
            variant="secondary"
            onPress={() => router.push("/account")}
            style={{ minHeight: 56 }}
            textStyle={{ fontSize: 20, textAlign: "center" }}
          />
          <Text style={{ color: COLORS.textSecondary, fontSize: 16, lineHeight: 24 }}>
            Les services du compte utilisent une connexion à Internet.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
