import { SmaranaStorageError, type SmaranaStore } from './smarana-store';

/** This native account replica has no plaintext/browser fallback. */
export function openSmaranaStore(_ownerId: string): Promise<SmaranaStore> {
  return Promise.reject(new SmaranaStorageError('unavailable'));
}
export function invalidateSmaranaStore(): void {}
export function closeSmaranaStore(): Promise<void> { return Promise.resolve(); }
