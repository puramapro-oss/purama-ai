import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";

/** This route has no native/storage import or fixture capability in a normal build. */
export default function IaoQualificationScreen() {
  const enabled = process.env.EXPO_PUBLIC_PURAMA_OFFLINE_QUALIFICATION === "1";
  const [status, setStatus] = useState("Initialisation de la qualification native…");
  const [result, setResult] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let mounted = true;
    void import("../lib/iao-native-qualification").then(module => module.runIaoNativeQualification(value => {
      if (mounted) setStatus(value);
    })).then(receipt => {
      if (mounted) setResult(JSON.stringify(receipt, null, 2));
    }).catch(() => { if (mounted) setStatus("Qualification native indisponible."); });
    return () => { mounted = false; };
  }, [enabled]);
  if (!enabled) return <View style={{ flex: 1, backgroundColor: "#0A0A0F", padding: 24 }}>
    <Text style={{ color: "#FFFFFF" }}>Cette qualification n’est pas disponible dans cette application.</Text>
  </View>;
  return <ScrollView contentContainerStyle={{ padding: 24, gap: 16, backgroundColor: "#0A0A0F", flexGrow: 1 }}>
    <Text accessibilityRole="header" style={{ color: "#FFFFFF", fontSize: 24 }}>Qualification native PURAMA</Text>
    <Text style={{ color: "#C4B5FD" }}>Application de qualification — comptes et messages synthétiques uniquement.</Text>
    <Text accessibilityLiveRegion="polite" style={{ color: "#FFFFFF" }}>{status}</Text>
    {result && <Text selectable style={{ color: "#D1D5DB", fontFamily: "monospace" }}>{result}</Text>}
  </ScrollView>;
}
