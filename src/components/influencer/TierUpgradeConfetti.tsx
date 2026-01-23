import { useEffect, useCallback, useState } from 'react';
import confetti from 'canvas-confetti';
import { supabase } from '@/integrations/supabase/client';
import { motion, AnimatePresence } from 'framer-motion';
import { Crown, Star, Sparkles } from 'lucide-react';

interface TierUpgradeConfettiProps {
  userId: string;
  currentTier: string;
}

const TIER_CONFIG = {
  bronze: { icon: Star, color: 'text-amber-600', gradient: 'from-amber-600 to-amber-400', label: 'Bronze' },
  silver: { icon: Sparkles, color: 'text-slate-400', gradient: 'from-slate-400 to-slate-200', label: 'Argent' },
  gold: { icon: Crown, color: 'text-yellow-400', gradient: 'from-yellow-400 to-amber-300', label: 'Or' },
};

export function TierUpgradeConfetti({ userId, currentTier }: TierUpgradeConfettiProps) {
  const [showBanner, setShowBanner] = useState(false);
  const [upgradedTier, setUpgradedTier] = useState<string | null>(null);

  const fireConfetti = useCallback(() => {
    const duration = 4000;
    const animationEnd = Date.now() + duration;
    const defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 9999 };

    const tierColors = {
      bronze: ['#CD7F32', '#B87333', '#FFD700'],
      silver: ['#C0C0C0', '#A8A8A8', '#E8E8E8'],
      gold: ['#FFD700', '#FFA500', '#FF8C00'],
    };

    const colors = tierColors[currentTier as keyof typeof tierColors] || tierColors.gold;

    function randomInRange(min: number, max: number) {
      return Math.random() * (max - min) + min;
    }

    const interval: ReturnType<typeof setInterval> = setInterval(function() {
      const timeLeft = animationEnd - Date.now();

      if (timeLeft <= 0) {
        return clearInterval(interval);
      }

      const particleCount = 50 * (timeLeft / duration);

      confetti({
        ...defaults,
        particleCount,
        origin: { x: randomInRange(0.1, 0.3), y: Math.random() - 0.2 },
        colors,
      });
      confetti({
        ...defaults,
        particleCount,
        origin: { x: randomInRange(0.7, 0.9), y: Math.random() - 0.2 },
        colors,
      });
    }, 250);

    // Big burst at start
    confetti({
      particleCount: 100,
      spread: 70,
      origin: { y: 0.6, x: 0.5 },
      colors,
      zIndex: 9999,
    });
  }, [currentTier]);

  useEffect(() => {
    const checkRecentUpgrade = async () => {
      // Check if there's a recent upgrade in the queue (within last hour)
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      
      const { data: influencer } = await supabase
        .from('influencers')
        .select('id')
        .eq('user_id', userId)
        .single();

      if (!influencer) return;

      const { data: recentUpgrade } = await supabase
        .from('tier_upgrade_queue')
        .select('*')
        .eq('influencer_id', influencer.id)
        .eq('processed', true)
        .gte('created_at', oneHourAgo)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (recentUpgrade) {
        // Check if we already showed confetti for this upgrade
        const confettiKey = `confetti_shown_${recentUpgrade.id}`;
        const alreadyShown = localStorage.getItem(confettiKey);

        if (!alreadyShown) {
          setUpgradedTier(recentUpgrade.new_tier);
          setShowBanner(true);
          fireConfetti();
          localStorage.setItem(confettiKey, 'true');

          // Hide banner after 8 seconds
          setTimeout(() => setShowBanner(false), 8000);
        }
      }
    };

    if (userId) {
      checkRecentUpgrade();
    }
  }, [userId, fireConfetti]);

  const tierConfig = TIER_CONFIG[upgradedTier as keyof typeof TIER_CONFIG] || TIER_CONFIG.gold;
  const TierIcon = tierConfig.icon;

  return (
    <AnimatePresence>
      {showBanner && upgradedTier && (
        <motion.div
          initial={{ opacity: 0, y: -100, scale: 0.8 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -50, scale: 0.9 }}
          transition={{ type: 'spring', stiffness: 200, damping: 20 }}
          className="fixed top-20 left-1/2 -translate-x-1/2 z-[100]"
        >
          <div className={`
            relative px-8 py-5 rounded-2xl 
            bg-gradient-to-r ${tierConfig.gradient} 
            shadow-2xl shadow-primary/30
            overflow-hidden
          `}>
            {/* Shine effect */}
            <motion.div
              className="absolute inset-0 bg-gradient-to-r from-transparent via-white/40 to-transparent"
              initial={{ x: '-100%' }}
              animate={{ x: '200%' }}
              transition={{ repeat: Infinity, duration: 2, ease: 'linear' }}
            />
            
            <div className="relative flex items-center gap-4">
              <motion.div
                animate={{ rotate: [0, 10, -10, 0], scale: [1, 1.1, 1] }}
                transition={{ repeat: Infinity, duration: 2 }}
              >
                <TierIcon className="w-10 h-10 text-white drop-shadow-lg" />
              </motion.div>
              
              <div>
                <p className="text-white/90 text-sm font-medium">
                  🎉 Félicitations !
                </p>
                <p className="text-white font-bold text-xl">
                  Vous êtes maintenant {tierConfig.label} !
                </p>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
