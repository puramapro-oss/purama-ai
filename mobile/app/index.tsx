import { Redirect } from "expo-router";
import { useAuth } from "@/hooks/useAuth";
import { LoadingScreen } from "@/components/ui/LoadingScreen";

export default function Index() {
  const { user, loading } = useAuth();

  if (loading) return <LoadingScreen message="Chargement..." />;

  if (user) return <Redirect href="/(tabs)" />;

  return <Redirect href="/(auth)/login" />;
}
