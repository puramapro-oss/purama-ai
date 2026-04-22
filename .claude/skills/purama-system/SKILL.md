---
name: purama-system
description: "System V3:26 obligations,contests auto,ligues,défis Bartle,onboarding 10sec,anti-fraude 6 couches,KYC,wrapped mensuel,mobile Expo 52,auth SecureStore,EAS build,Watch,Maestro tests."
---
## PURAMA SYSTEM V3.0
**RÈGLE**:feature=compréhensible 12ans|1ère récompense<10sec|micro-interaction=1émotion|anti-fraude INVISIBLE|IA=ami sage|design screenshotable|100% AUTONOME.
Profil:Curieux→Érudit→Sage→Maître→Légende→Ultime(+Éveillé→Unifié)|impact|badges+classement.Mode Créateur:1vidéo=-50%|3=GRATUIT|5+=cash.Viralité:#[App]ChangedMyLife|Drop FOMO|Wrapped MENSUEL|Mascotte|Easter eggs.
Contests IA:1hebdo+1mensuel.10 gagnants.Ligues:Bronze→Argent→Or→Platine→Diamant→Rubis→Émeraude→Obsidienne→Cosmique→Purama.
Défis:KILLER|ACHIEVER|SOCIALIZER|EXPLORER.Daily|Flash|Coffres|Beast Mode|Quêtes 90j certif|Squad 3+×2|Saisonniers.
Rareté:mois1=100→12=50→24=25.POOL=10%CA(40%contests|25%classement|15%challenges|10%créateurs|10%coffres).
Onboarding 10sec:0 tuto,1 action→100pts,wallet 1€,mascotte+affirmation.Physique:NFC QR|merch|offline.
Édition communautaire:premium 2.99€|auteur 70%.PURAMA DAY:gratuit 24h|contests géants|prix cash+equity.
Anti-fraude:Score 0-100(nouveau50,+1/j,<40=bloqué,>70=OK).6 couches:fingerprint|email+tel|comportement IA|géoIP|contenu IA|KYC progressif.Retrait AUTO>70+KYC→Stripe Connect.
Émotions:level up=lotus+bol+vibration+"Tu t'élèves"|mascotte contextuelle.
**26 OBLIGATIONS**:1.Auth 2.Wallet 3.Profil+titres 4.Créateur 5.Parrainage3niv 6.Contests 7.Classement+ligues 8.Streak 9.Daily Challenge 10.Coffres 11.Flash 12.Squad 13.Onboarding10sec 14.Anti-fraude 15.KYC 16.Retraits auto 17.Dashboard impact 18.Cross-pollination 19.Mascotte 20.Son signature 21.Wrapped 22.Pool 10% 23.Reinforcement learning 24.Modération auto 25.Affirmation+citations 26.Micro-textes+géométrie.**App≠terminée sans 26.**
## MOBILE — Expo 52
Stack:expo-router|NativeWind|reanimated|Zustand|EAS.Bundle:dev.purama.{SLUG}.TOUJOURS après web.Santé=+Watch P8.
**Auth CRITIQUE**:
```typescript
import "react-native-url-polyfill/auto";
import * as SecureStore from "expo-secure-store";
import { createClient } from "@supabase/supabase-js";
import { Platform } from "react-native";
const adapter = {
  getItem: async (k: string) => Platform.OS === "web" ? localStorage.getItem(k) : await SecureStore.getItemAsync(k),
  setItem: async (k: string, v: string) => { Platform.OS === "web" ? localStorage.setItem(k, v) : await SecureStore.setItemAsync(k, v); },
  removeItem: async (k: string) => { Platform.OS === "web" ? localStorage.removeItem(k) : await SecureStore.deleteItemAsync(k); },
};
export const supabase = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
  { auth: { storage: adapter, autoRefreshToken: true, persistSession: true, detectSessionInUrl: Platform.OS === "web" } });
```
❌window/localStorage/document→✅Platform.OS==="web".Config:eas.json+app.json(dark,scheme,bundle dev.purama.SLUG).Maestro:10+2 flows.EAS:16langues+full-deploy.yaml.Responsive:iPhone SE→16 Pro Max|iPad|Android 360→pliables.
**Watch**(santé):watchOS(WatchKit+SwiftUI+HealthKit+APNs+haptics)|Wear OS(Compose+Health Services+FCM).Features:cercles|streak🔥|notif|timer|pas|cardiaque|sync|respiration|affirmation.
