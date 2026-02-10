import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Cookie, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

const COOKIE_KEY = 'cookie_consent';
const CONSENT_MAX_AGE_MS = 13 * 30 * 24 * 60 * 60 * 1000; // ~13 months

interface ConsentState {
  essential: boolean;
  analytics: boolean;
  timestamp: number;
}

function getConsent(): ConsentState | null {
  try {
    const raw = localStorage.getItem(COOKIE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ConsentState;
    if (Date.now() - parsed.timestamp > CONSENT_MAX_AGE_MS) {
      localStorage.removeItem(COOKIE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveConsent(analytics: boolean) {
  const state: ConsentState = { essential: true, analytics, timestamp: Date.now() };
  localStorage.setItem(COOKIE_KEY, JSON.stringify(state));
}

export function CookieConsent() {
  const [visible, setVisible] = useState(false);
  const [showCustomize, setShowCustomize] = useState(false);
  const [analyticsChecked, setAnalyticsChecked] = useState(false);

  useEffect(() => {
    const consent = getConsent();
    if (!consent) setVisible(true);
  }, []);

  const accept = (analytics: boolean) => {
    saveConsent(analytics);
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ y: 100, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 100, opacity: 0 }}
        className="fixed bottom-0 left-0 right-0 z-[200] p-4"
      >
        <div className="max-w-3xl mx-auto glass-effect rounded-2xl p-6">
          <div className="flex items-start gap-4">
            <Cookie className="w-8 h-8 text-accent-cyan shrink-0 mt-1" />
            <div className="flex-1">
              <h3 className="font-bold text-foreground mb-2">Nous utilisons des cookies</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Ce site utilise des cookies essentiels pour son fonctionnement et des cookies analytiques pour améliorer votre expérience.{' '}
                <Link to="/politique-cookies" className="text-primary hover:underline">En savoir plus</Link>
              </p>

              {showCustomize && (
                <div className="mb-4 p-4 rounded-lg bg-secondary/50 space-y-3">
                  <label className="flex items-center gap-3 text-sm">
                    <input type="checkbox" checked disabled className="accent-primary w-4 h-4" />
                    <span className="text-foreground">Cookies essentiels</span>
                    <span className="text-muted-foreground">(toujours actifs)</span>
                  </label>
                  <label className="flex items-center gap-3 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={analyticsChecked}
                      onChange={(e) => setAnalyticsChecked(e.target.checked)}
                      className="accent-primary w-4 h-4"
                    />
                    <span className="text-foreground">Cookies analytiques</span>
                    <span className="text-muted-foreground">(Google Analytics)</span>
                  </label>
                </div>
              )}

              <div className="flex flex-wrap gap-3">
                <Button onClick={() => accept(true)} className="bg-gradient-to-r from-primary to-accent hover:opacity-90">
                  Accepter tout
                </Button>
                <Button onClick={() => accept(false)} variant="outline">
                  Refuser tout
                </Button>
                {showCustomize ? (
                  <Button onClick={() => accept(analyticsChecked)} variant="secondary">
                    Enregistrer mes choix
                  </Button>
                ) : (
                  <Button onClick={() => setShowCustomize(true)} variant="ghost" className="text-muted-foreground">
                    Personnaliser
                  </Button>
                )}
              </div>
            </div>
            <button onClick={() => accept(false)} className="text-muted-foreground hover:text-foreground" aria-label="Fermer le bandeau cookies">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

/** Call this to re-open the consent banner */
export function resetCookieConsent() {
  localStorage.removeItem(COOKIE_KEY);
  window.location.reload();
}
