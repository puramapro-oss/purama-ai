import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { Gift, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useReferralTracking } from '@/hooks/useInfluencer';

export function ReferralBanner() {
  const { t } = useTranslation();
  const { checkAndStoreReferral, getStoredReferral } = useReferralTracking();
  const { search } = useLocation();
  const [referral, setReferral] = useState<{ code: string } | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    checkAndStoreReferral(search);
    setReferral(getStoredReferral());
  }, [checkAndStoreReferral, getStoredReferral, search]);

  if (!referral || dismissed) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ y: -100, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: -100, opacity: 0 }}
        className="fixed top-0 left-0 right-0 z-[100] bg-gradient-to-r from-primary to-accent text-primary-foreground"
      >
        <div className="container mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center">
              <Gift className="w-4 h-4" />
            </div>
            <div>
              <p className="font-medium">
                Invitation PURAMA : consultez les prix et conditions avant paiement.
              </p>
              <p className="text-sm opacity-90 break-all">
                Code enregistré : {referral.code}. Son éligibilité sera vérifiée au paiement.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              className="bg-white/20 hover:bg-white/30 text-white border-0"
              asChild
            >
              <a href="/pricing">Voir les prix</a>
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="text-white hover:bg-white/20"
              onClick={() => setDismissed(true)}
              aria-label={t('common.close')}
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
