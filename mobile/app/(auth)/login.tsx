import { useState } from "react";
import { View, Text, TouchableOpacity, KeyboardAvoidingView, Platform, ScrollView, Image } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Link, router } from "expo-router";
import { useAuth } from "@/hooks/useAuth";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Ionicons } from "@expo/vector-icons";

export default function LoginScreen() {
  const { signIn, signInWithGoogle } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleLogin = async () => {
    if (!email.trim() || !password.trim()) {
      setError("Remplis tous les champs");
      return;
    }
    setError("");
    setLoading(true);
    const { error: err } = await signIn(email.trim(), password);
    if (err) {
      setError("Email ou mot de passe incorrect");
    } else {
      router.replace("/(tabs)");
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
            <Text className="text-white text-3xl font-bold">Purama AI</Text>
            <Text className="text-white/50 text-base mt-2">Tes agents IA au quotidien</Text>
          </View>

          {error ? (
            <View className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 mb-4">
              <Text className="text-red-400 text-sm text-center">{error}</Text>
            </View>
          ) : null}

          <Input
            testID="login-email"
            label="Email"
            placeholder="ton@email.com"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
          />

          <Input
            testID="login-password"
            label="Mot de passe"
            placeholder="Ton mot de passe"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="password"
          />

          <TouchableOpacity className="self-end mb-6" onPress={() => router.push("/(auth)/forgot-password")}>
            <Text className="text-accent text-sm">Mot de passe oublie ?</Text>
          </TouchableOpacity>

          <Button
            testID="login-submit"
            title="Se connecter"
            onPress={handleLogin}
            loading={loading}
          />

          <View className="flex-row items-center my-6">
            <View className="flex-1 h-px bg-white/10" />
            <Text className="text-white/30 mx-4 text-sm">ou</Text>
            <View className="flex-1 h-px bg-white/10" />
          </View>

          <TouchableOpacity
            testID="login-google"
            onPress={handleGoogle}
            className="flex-row items-center justify-center bg-white/5 border border-white/[0.06] rounded-xl py-3.5"
            activeOpacity={0.7}
          >
            <Ionicons name="logo-google" size={20} color="#fff" />
            <Text className="text-white font-medium ml-3">Continuer avec Google</Text>
          </TouchableOpacity>

          <View className="flex-row justify-center mt-8">
            <Text className="text-white/40">Pas encore de compte ? </Text>
            <Link href="/(auth)/signup" asChild>
              <TouchableOpacity>
                <Text className="text-accent font-semibold">S'inscrire</Text>
              </TouchableOpacity>
            </Link>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
