import { useEffect, useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { exchangeOAuthCode } from "@/lib/oauth";
import { supabase } from "@/lib/supabase";

export default function AuthCallbackScreen() {
  const params = useLocalSearchParams<{ code?: string | string[]; error?: string | string[] }>();
  const [message, setMessage] = useState("Connexion en cours...");

  useEffect(() => {
    let active = true;
    let redirectTimer: ReturnType<typeof setTimeout> | undefined;

    const complete = async () => {
      try {
        if (params.error) throw new Error("OAuth provider rejected the request");
        const code = Array.isArray(params.code) ? params.code[0] : params.code;
        if (code) {
          await exchangeOAuthCode(code);
        }

        const { data } = await supabase.auth.getSession();
        if (!data.session) throw new Error("No authenticated session was created");
        if (active) router.replace("/(tabs)");
      } catch {
        if (!active) return;
        setMessage("Connexion impossible. Retour à la connexion...");
        redirectTimer = setTimeout(() => router.replace("/(auth)/login"), 1200);
      }
    };

    void complete();
    return () => {
      active = false;
      if (redirectTimer) clearTimeout(redirectTimer);
    };
  }, [params.code, params.error]);

  return <LoadingScreen message={message} />;
}
