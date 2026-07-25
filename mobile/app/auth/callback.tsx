import { useEffect } from "react";
import { router } from "expo-router";
import { LoadingScreen } from "@/components/ui/LoadingScreen";

export default function AuthCallbackScreen() {
  useEffect(() => {
    // Supabase handles the token exchange via the auth listener in useAuth
    // Just redirect to tabs after a short delay
    const timer = setTimeout(() => {
      router.replace("/(tabs)");
    }, 1500);
    return () => clearTimeout(timer);
  }, []);

  return <LoadingScreen message="Connexion en cours..." />;
}
