import { requireOptionalNativeModule } from 'expo-modules-core';
import { createWatchNativeApi, type WatchNativeModule } from './host';
const api = createWatchNativeApi(requireOptionalNativeModule<WatchNativeModule>('PuramaAccessibilityWatch'));
export const { createNativeWatchHost, discoverWatches, authorizeWatch, clearWatchAuthorization,
  subscribeWatchStatus, createNativeWatchChallenge } = api;
export * from './contract';
