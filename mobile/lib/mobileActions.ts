import { Alert, Linking } from "react-native";

const WEB_APP_URL = "https://purama-ai.purama.dev";

export const PUBLIC_WEB_ROUTES = {
  parrainage: "/parrainage",
  concours: "/concours",
  ecosystem: "/ecosystem",
  privacy: "/politique-de-confidentialite",
  legal: "/mentions-legales",
} as const;

export async function openPublicWebRoute(route: keyof typeof PUBLIC_WEB_ROUTES): Promise<void> {
  try {
    await Linking.openURL(`${WEB_APP_URL}${PUBLIC_WEB_ROUTES[route]}`);
  } catch {
    Alert.alert("Lien indisponible", "Cette page ne peut pas être ouverte pour le moment.");
  }
}

export function showComingSoon(feature: string): void {
  Alert.alert("Bientôt disponible", `${feature} arrive prochainement dans l'application mobile.`);
}
