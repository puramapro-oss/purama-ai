// Metro resolves offline-account.native.ts on installed iOS/Android applications.
// The web build must not silently replace the protected native vault by plaintext storage.
import type { OfflineAccount } from "./offline-account-core";
export type { OfflineAccount } from "./offline-account-core";
const unavailable = async (): Promise<never> => { throw new Error("Cette capacité demande l’application PURAMA installée."); };
export const offlineAccount = {
  read: async (): Promise<OfflineAccount | null> => null,
  selectOwner: async (_ownerId: string | null) => {},
  clear: async () => {},
  subscribe: (_listener: () => void) => () => {},
  verificationTicket: () => 0,
  rememberVerified: async (_ownerId: string, _ticket: number, _signal?: AbortSignal): Promise<OfflineAccount> => unavailable(),
  setAutoSync: async (_ownerId: string, _allowed: boolean): Promise<OfflineAccount> => unavailable(),
};
