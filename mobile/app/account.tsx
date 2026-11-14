import { Redirect } from "expo-router";
import { useAuth } from "@/hooks/useAuth";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { AccountUnavailable } from "@/components/auth/AccountUnavailable";

/** The former start route, reached only when the account area is requested. */
export default function AccountEntry() {
  const { user, loading, initializationError } = useAuth();
  if (loading) return <LoadingScreen message="Chargement..." />;
  if (initializationError) return <AccountUnavailable message={initializationError} />;
  if (user) return <Redirect href="/(tabs)" />;
  return <Redirect href="/(auth)/login" />;
}
