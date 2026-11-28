import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";

/** This route has no native/storage import or fixture capability in a normal build. */
export default function IaoQualificationScreen() {
  const offlineEnabled = process.env.EXPO_PUBLIC_PURAMA_OFFLINE_QUALIFICATION === "1";
  const digestEnabled = process.env.EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION === "1";
  const conflicting = offlineEnabled && digestEnabled;
  const enabled = (offlineEnabled || digestEnabled) && !conflicting;
  const [status, setStatus] = useState("Initialisation de la qualification native…");
  const [result, setResult] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let mounted = true;
    const diagnose = (event: string, detail: string) => {
      if (!digestEnabled) return;
      // Qualification-only, bounded signals. A logger must not alter the result.
      try { console.info("PURAMA_DIGEST_QUALIFICATION", event, detail); } catch { /* diagnostic only */ }
    };
    diagnose("route", "mounted");
    const onStatus = (value: string) => {
      diagnose("status", value);
      if (mounted) setStatus(value);
    };
    const qualification = digestEnabled
      ? import("../lib/iao-digest-qualification").then(module => module.runIaoDigestQualification(onStatus))
      : import("../lib/iao-native-qualification").then(module => module.runIaoNativeQualification(onStatus));
    void qualification.then(receipt => {
      diagnose("receipt", receipt.status);
      if (mounted) setResult(JSON.stringify(receipt, null, 2));
    }).catch((error: unknown) => {
      let code = "unclassified";
      try {
        if (error !== null && typeof error === "object") {
          const candidate = (error as { code?: unknown; name?: unknown }).code
            ?? (error as { name?: unknown }).name;
          if (typeof candidate === "string" && /^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(candidate)) code = candidate;
        }
      } catch { /* An exceptional getter must not hide the original rejection. */ }
      diagnose("rejected", code);
      if (mounted) setStatus("Qualification native indisponible.");
    });
    return () => { mounted = false; };
  }, [enabled, digestEnabled]);
  if (!enabled) return <View style={{ flex: 1, backgroundColor: "#0A0A0F", padding: 24 }}>
    <Text style={{ color: "#FFFFFF" }}>{conflicting
      ? "La configuration de qualification est incompatible."
      : "Cette qualification n’est pas disponible dans cette application."}</Text>
  </View>;
  return <ScrollView contentContainerStyle={{ padding: 24, gap: 16, backgroundColor: "#0A0A0F", flexGrow: 1 }}>
    <Text accessibilityRole="header" style={{ color: "#FFFFFF", fontSize: 24 }}>Qualification native PURAMA</Text>
    <Text style={{ color: "#C4B5FD" }}>Application de qualification — comptes et messages synthétiques uniquement.</Text>
    <Text accessibilityLiveRegion="polite" style={{ color: "#FFFFFF" }}>{status}</Text>
    {result && <Text selectable style={{ color: "#D1D5DB", fontFamily: "monospace" }}>{result}</Text>}
  </ScrollView>;
}
