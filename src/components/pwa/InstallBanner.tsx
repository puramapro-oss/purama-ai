import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Download, X, Smartphone, Share, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';

const DISMISS_KEY = 'purama-pwa-banner-dismissed';
const SHOW_DELAY_MS = 30_000;

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

type Platform = 'ios' | 'android' | 'desktop' | 'unknown';

function detectPlatform(): Platform {
  if (typeof window === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Windows|Macintosh|Linux/i.test(ua)) return 'desktop';
  return 'unknown';
}

function isInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // @ts-expect-error iOS Safari property
    window.navigator.standalone === true
  );
}

export function InstallBanner() {
  const [show, setShow] = useState(false);
  const [showIosTuto, setShowIosTuto] = useState(false);
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const platform = detectPlatform();

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (isInstalled()) return;
    if (localStorage.getItem(DISMISS_KEY)) return;

    const onBIP = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onBIP);

    const t = setTimeout(() => setShow(true), SHOW_DELAY_MS);
    return () => {
      clearTimeout(t);
      window.removeEventListener('beforeinstallprompt', onBIP);
    };
  }, []);

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, '1');
    setShow(false);
    setShowIosTuto(false);
  };

  const handleInstall = async () => {
    if (platform === 'ios') {
      setShowIosTuto(true);
      return;
    }
    if (deferred) {
      await deferred.prompt();
      const { outcome } = await deferred.userChoice;
      if (outcome === 'accepted') dismiss();
      setDeferred(null);
    } else {
      setShowIosTuto(true);
    }
  };

  if (!show) return null;

  return (
    <AnimatePresence>
      {showIosTuto ? (
        <motion.div
          key="tuto"
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 40 }}
          className="fixed bottom-4 left-4 right-4 sm:left-auto sm:bottom-6 sm:right-6 sm:max-w-sm z-[9000]"
        >
          <div className="rounded-2xl border border-accent-purple/30 bg-card/95 backdrop-blur-xl p-4 shadow-2xl">
            <div className="flex items-start justify-between mb-3">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Smartphone className="w-4 h-4 text-accent-cyan" />
                {platform === 'ios' ? 'Installer sur iPhone (Safari)' : 'Installer Purama'}
              </h3>
              <button onClick={dismiss} aria-label="Fermer">
                <X className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>
            {platform === 'ios' ? (
              <ol className="space-y-2 text-xs text-foreground/80">
                <Step n={1} icon={<Share className="w-3 h-3" />} text="Appuie sur le bouton Partager (en bas)" />
                <Step n={2} icon={<Plus className="w-3 h-3" />} text="« Sur l'écran d'accueil »" />
                <Step n={3} icon={<Download className="w-3 h-3" />} text="« Ajouter » en haut à droite" />
              </ol>
            ) : (
              <ol className="space-y-2 text-xs text-foreground/80">
                <Step n={1} text="Ouvre le menu ⋮ en haut à droite" />
                <Step n={2} text="« Installer l'application » ou « Ajouter à l'écran d'accueil »" />
                <Step n={3} text="Confirme l'installation" />
              </ol>
            )}
            <p className="text-[10px] text-muted-foreground mt-3">
              Une fois installée, tu reçois les notifications push de tes agents directement sur ton téléphone.
            </p>
          </div>
        </motion.div>
      ) : (
        <motion.div
          key="banner"
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 40 }}
          className="fixed bottom-4 left-4 right-4 sm:left-auto sm:bottom-6 sm:right-6 sm:max-w-sm z-[9000]"
        >
          <div className="rounded-2xl border border-accent-purple/30 bg-gradient-to-br from-accent-purple/10 to-accent-cyan/10 backdrop-blur-xl p-4 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent-purple to-accent-cyan flex items-center justify-center flex-shrink-0">
                <Smartphone className="w-5 h-5 text-white" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground">Installer Purama AI</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Comme une vraie app + notifications push
                </p>
              </div>
              <button onClick={dismiss} aria-label="Fermer" className="flex-shrink-0">
                <X className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>
            <Button onClick={handleInstall} size="sm" className="w-full mt-3">
              <Download className="w-3 h-3 mr-2" /> Installer
            </Button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Step({ n, text, icon }: { n: number; text: string; icon?: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      <span className="w-5 h-5 rounded-full bg-accent-cyan/20 text-accent-cyan text-[10px] font-bold flex items-center justify-center flex-shrink-0">
        {n}
      </span>
      {icon && <span className="text-accent-purple">{icon}</span>}
      <span>{text}</span>
    </li>
  );
}
