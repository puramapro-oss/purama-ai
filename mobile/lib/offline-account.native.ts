import * as SecureStore from "expo-secure-store";
import { createOfflineAccountLedger } from "./offline-account-core";
export type { OfflineAccount } from "./offline-account-core";

const KEY = "purama.smarana.offline-account.v1";
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
export const offlineAccount = createOfflineAccountLedger({
  read: async () => {
    const raw = await SecureStore.getItemAsync(KEY, options);
    if (!raw) return null;
    // Read the existing SDK cache without initializing auth or refreshing tokens.
    // This second binding also defeats a surviving lease after a failed Keychain
    // deletion, a completed sign-out, or an account switch across process restarts.
    const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
    if (!url) return null;
    try {
      const authKey = `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
      const cached = await SecureStore.getItemAsync(authKey);
      const ownerId = cached ? JSON.parse(cached)?.user?.id : null;
      return ownerId && ownerId === JSON.parse(raw).ownerId ? raw : null;
    } catch { return null; }
  },
  write: value => SecureStore.setItemAsync(KEY, value, options),
  remove: () => SecureStore.deleteItemAsync(KEY, options),
});
