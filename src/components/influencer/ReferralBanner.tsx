import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Gift, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useReferralTracking } from '@/hooks/useInfluencer';
import { supabase } from '@/integrations/supabase/client';

export function ReferralBanner() {
  const { getStoredReferral, clearReferral } = useReferralTracking();
  const [referral, setReferral] = useState<{ code: string; influencerName?: string } | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const stored = getStoredReferral();
    if (stored) {
      // Fetch influencer name
      const fetchInfluencer = async () => {
        const { data } = await supabase
          .from('influencers')
          .select('beneficiary_name, promo_code')
          .eq('promo_code', stored.code)
          .maybeSingle();

        if (data) {
          setReferral({
            code: data.promo_code,
            influencerName: data.beneficiary_name || undefined,
          });
        }
      };
      fetchInfluencer();
    }
  }, []);

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
                🎉 Offre spéciale : <strong>-50%</strong> sur votre première année !
              </p>
              {referral.influencerName && (
                <p className="text-sm opacity-90">
                  Grâce à {referral.influencerName}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              className="bg-white/20 hover:bg-white/30 text-white border-0"
              asChild
            >
              <a href="/pricing">Profiter de l'offre</a>
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="text-white hover:bg-white/20"
              onClick={() => setDismissed(true)}
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
