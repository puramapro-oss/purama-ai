import { useState } from "react";
import { View, Text, TouchableOpacity, KeyboardAvoidingView, Platform, ScrollView, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Link, router } from "expo-router";
import { useAuth } from "@/hooks/useAuth";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Ionicons } from "@expo/vector-icons";

export default function SignupScreen() {
  const { signUp, signInWithGoogle } = useAuth();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSignup = async () => {
    if (!email.trim() || !password.trim() || !fullName.trim()) {
      setError("Remplis tous les champs");
      return;
    }
    if (password.length < 6) {
      setError("Le mot de passe doit faire au moins 6 caracteres");
      return;
    }
    setError("");
    setLoading(true);
    const { error: err } = await signUp(email.trim(), password, fullName.trim());
    if (err) {
      setError(err.message);
    } else {
      Alert.alert(
        "Inscription reussie",
        "Verifie ton email pour confirmer ton compte, puis connecte-toi.",
        [{ text: "OK", onPress: () => router.replace("/(auth)/login") }]
      );
    }
    setLoading(false);
  };

  const handleGoogle = async () => {
    setLoading(true);
    const { error: err } = await signInWithGoogle();
    if (err) setError("Erreur de connexion Google");
    setLoading(false);
  };

  return (
    <SafeAreaView className="flex-1 bg-background">
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        className="flex-1"
      >
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 24 }}
          keyboardShouldPersistTaps="handled"
        >
          <View className="items-center mb-10">
            <View className="w-16 h-16 rounded-2xl bg-accent items-center justify-center mb-4">
              <Text className="text-white text-2xl font-bold">P</Text>
            </View>
            <Text className="text-white text-3xl font-bold">Creer ton compte</Text>
            <Text className="text-white/50 text-base mt-2">Rejoins Purama AI gratuitement</Text>
          </View>

          {error ? (
            <View className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 mb-4">
              <Text className="text-red-400 text-sm text-center">{error}</Text>
            </View>
          ) : null}

          <Input
            testID="signup-name"
            label="Nom complet"
            placeholder="Ton nom"
            value={fullName}
            onChangeText={setFullName}
            autoCapitalize="words"
          />

          <Input
            testID="signup-email"
            label="Email"
            placeholder="ton@email.com"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
          />

          <Input
            testID="signup-password"
            label="Mot de passe"
            placeholder="Minimum 6 caracteres"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
          />

          <Button
            testID="signup-submit"
            title="S'inscrire gratuitement"
            onPress={handleSignup}
            loading={loading}
            className="mt-2"
          />

          <View className="flex-row items-center my-6">
            <View className="flex-1 h-px bg-white/10" />
            <Text className="text-white/30 mx-4 text-sm">ou</Text>
            <View className="flex-1 h-px bg-white/10" />
          </View>

          <TouchableOpacity
            testID="signup-google"
            onPress={handleGoogle}
            className="flex-row items-center justify-center bg-white/5 border border-white/[0.06] rounded-xl py-3.5"
            activeOpacity={0.7}
          >
            <Ionicons name="logo-google" size={20} color="#fff" />
            <Text className="text-white font-medium ml-3">Continuer avec Google</Text>
          </TouchableOpacity>

          <View className="flex-row justify-center mt-8">
            <Text className="text-white/40">Deja un compte ? </Text>
            <Link href="/(auth)/login" asChild>
              <TouchableOpacity>
                <Text className="text-accent font-semibold">Se connecter</Text>
              </TouchableOpacity>
            </Link>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
