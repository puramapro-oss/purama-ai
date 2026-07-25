import { View, Text, ScrollView, TouchableOpacity, Alert, Share } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/hooks/useAuth";
import { GlassCard } from "@/components/ui/GlassCard";
import { Badge } from "@/components/ui/Badge";

interface SettingsItemProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  color?: string;
  badge?: string;
  testID?: string;
}

function SettingsItem({ icon, label, onPress, color = "#fff", badge, testID }: SettingsItemProps) {
  return (
    <TouchableOpacity
      testID={testID}
      onPress={onPress}
      className="flex-row items-center py-3.5 px-1"
      activeOpacity={0.6}
    >
      <Ionicons name={icon} size={22} color={color} />
      <Text className="text-white flex-1 ml-4 text-base">{label}</Text>
      {badge && <Badge text={badge} variant="accent" />}
      <Ionicons name="chevron-forward" size={16} color="rgba(255,255,255,0.2)" style={{ marginLeft: 8 }} />
    </TouchableOpacity>
  );
}

export default function SettingsScreen() {
  const { profile, signOut } = useAuth();

  const handleShare = async () => {
    try {
      await Share.share({
        message: `Rejoins Purama AI ! Utilise mon code ${profile?.referral_code ?? ""} pour obtenir des bonus. https://purama-ai.purama.dev`,
      });
    } catch {
      // cancelled
    }
  };

  const handleSignOut = () => {
    Alert.alert("Deconnexion", "Es-tu sur de vouloir te deconnecter ?", [
      { text: "Annuler", style: "cancel" },
      {
        text: "Deconnecter",
        style: "destructive",
        onPress: async () => {
          await signOut();
          router.replace("/(auth)/login");
        },
      },
    ]);
  };

  return (
    <SafeAreaView className="flex-1 bg-background" edges={["top"]}>
      <ScrollView className="flex-1 px-4" showsVerticalScrollIndicator={false}>
        <Text className="text-white text-2xl font-bold mt-2 mb-6">Plus</Text>

        {/* Profile card */}
        <GlassCard className="mb-6">
          <View className="flex-row items-center gap-4">
            <View className="w-14 h-14 rounded-full bg-accent/20 items-center justify-center">
              <Text className="text-accent text-xl font-bold">
                {profile?.full_name?.charAt(0)?.toUpperCase() ?? "?"}
              </Text>
            </View>
            <View className="flex-1">
              <Text className="text-white font-bold text-lg">{profile?.full_name ?? "Utilisateur"}</Text>
              <Text className="text-white/40 text-sm">{profile?.email ?? ""}</Text>
            </View>
            <Badge text={profile?.plan?.toUpperCase() ?? "FREE"} variant="accent" />
          </View>
        </GlassCard>

        {/* Sections */}
        <GlassCard className="mb-4">
          <SettingsItem testID="settings-parrainage" icon="people" label="Parrainage" onPress={() => {}} badge={profile?.referral_code ?? undefined} />
          <View className="h-px bg-white/[0.06]" />
          <SettingsItem testID="settings-concours" icon="trophy" label="Concours" onPress={() => {}} />
          <View className="h-px bg-white/[0.06]" />
          <SettingsItem testID="settings-tirage" icon="ticket" label="Tirage mensuel" onPress={() => {}} />
          <View className="h-px bg-white/[0.06]" />
          <SettingsItem testID="settings-boutique" icon="bag" label="Boutique" onPress={() => {}} />
        </GlassCard>

        <GlassCard className="mb-4">
          <SettingsItem testID="settings-share" icon="share-social" label="Partager l'app" onPress={handleShare} />
          <View className="h-px bg-white/[0.06]" />
          <SettingsItem testID="settings-ecosystem" icon="apps" label="Ecosysteme Purama" onPress={() => {}} />
          <View className="h-px bg-white/[0.06]" />
          <SettingsItem testID="settings-aide" icon="help-circle" label="Aide et FAQ" onPress={() => {}} />
        </GlassCard>

        <GlassCard className="mb-4">
          <SettingsItem testID="settings-notifications" icon="notifications" label="Notifications" onPress={() => {}} />
          <View className="h-px bg-white/[0.06]" />
          <SettingsItem testID="settings-privacy" icon="shield" label="Confidentialite" onPress={() => {}} />
          <View className="h-px bg-white/[0.06]" />
          <SettingsItem testID="settings-legal" icon="document-text" label="Mentions legales" onPress={() => {}} />
        </GlassCard>

        <TouchableOpacity
          testID="settings-logout"
          onPress={handleSignOut}
          className="bg-red-500/10 border border-red-500/20 rounded-2xl py-4 items-center mb-8"
          activeOpacity={0.7}
        >
          <Text className="text-red-400 font-semibold text-base">Se deconnecter</Text>
        </TouchableOpacity>

        <Text className="text-white/20 text-xs text-center mb-8">
          Purama AI v1.0.0 - SASU PURAMA - Art. 293B du CGI
        </Text>

        <View className="h-4" />
      </ScrollView>
    </SafeAreaView>
  );
}
