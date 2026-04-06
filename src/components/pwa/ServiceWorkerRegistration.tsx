import { useEffect } from 'react';

/**
 * Registers the Purama service worker on mount. Idempotent.
 * Mounted once at the root.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;
    if (import.meta.env.DEV) return; // skip in dev to avoid stale-cache headaches
    const onLoad = () => {
      navigator.serviceWorker
        .register('/sw.js')
        .catch(err => console.warn('[sw] registration failed', err));
    };
    if (document.readyState === 'complete') onLoad();
    else window.addEventListener('load', onLoad, { once: true });
    return () => window.removeEventListener('load', onLoad);
  }, []);
  return null;
}
