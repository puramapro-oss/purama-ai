import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Gift, Sparkles, Star, Zap, Flame } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { usePoints, getStreakMultiplier } from '@/hooks/usePoints';
import { useTodaysGift, useOpenGift } from '@/hooks/useDailyGift';
import confetti from 'canvas-confetti';

export default function DailyGift() {
  const { data: points } = usePoints();
  const { data: todaysGift } = useTodaysGift();
  const openGiftMutation = useOpenGift();
  const [giftResult, setGiftResult] = useState<{ type: string; value: string; label: string } | null>(null);
  const [isOpening, setIsOpening] = useState(false);

  const streakDays = points?.streak_days || 0;
  const multiplier = getStreakMultiplier(streakDays);
  const alreadyOpened = !!todaysGift;

  const handleOpen = async () => {
    if (alreadyOpened || isOpening) return;
    setIsOpening(true);

    // Animate delay
    await new Promise((r) => setTimeout(r, 1500));

    openGiftMutation.mutate(streakDays, {
      onSuccess: (result) => {
        setGiftResult(result);
        setIsOpening(false);
        confetti({ particleCount: 80, spread: 60, origin: { y: 0.6 } });
      },
      onError: () => setIsOpening(false),
    });
  };

  return (
    <div className="space-y-6">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
        <h1 className="text-2xl font-orbitron font-bold text-foreground flex items-center gap-3">
          <Gift className="w-7 h-7 text-yellow-400" />
          Coffre quotidien
        </h1>
        <p className="text-muted-foreground mt-1">Ouvre ton coffre chaque jour pour gagner des récompenses</p>
      </motion.div>

      {/* Streak info */}
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
        <Card className="bg-card/50 backdrop-blur border-border">
          <CardContent className="pt-5">
            <div className="flex items-center gap-6 flex-wrap">
              <div className="flex items-center gap-2">
                <Flame className="w-5 h-5 text-orange-400" />
                <span className="text-sm text-muted-foreground">Streak :</span>
                <span className="font-bold text-foreground">{streakDays} jours</span>
              </div>
              <div className="flex items-center gap-2">
                <Zap className="w-5 h-5 text-accent-cyan" />
                <span className="text-sm text-muted-foreground">Multiplicateur :</span>
                <span className="font-bold text-accent-cyan">x{multiplier}</span>
              </div>
              <div className="flex items-center gap-2">
                <Star className="w-5 h-5 text-accent-purple" />
                <span className="text-sm text-muted-foreground">Points :</span>
                <span className="font-bold text-accent-purple">{(points?.balance || 0).toLocaleString('fr-FR')}</span>
              </div>
            </div>
            <div className="mt-3 flex gap-1">
              {Array.from({ length: 7 }).map((_, i) => (
                <div
                  key={i}
                  className={`h-2 flex-1 rounded-full ${
                    i < (streakDays % 7) ? 'bg-gradient-to-r from-accent-purple to-accent-cyan' : 'bg-secondary/50'
                  }`}
                />
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {7 - (streakDays % 7)} jour{7 - (streakDays % 7) > 1 ? 's' : ''} avant le prochain palier streak
            </p>
          </CardContent>
        </Card>
      </motion.div>

      {/* Chest */}
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: 0.2, type: 'spring', stiffness: 200 }}
        className="flex justify-center"
      >
        <div className="relative">
          <AnimatePresence mode="wait">
            {!alreadyOpened && !giftResult ? (
              <motion.div
                key="closed"
                initial={{ scale: 1 }}
                animate={isOpening ? { scale: [1, 1.1, 0.9, 1.2], rotate: [0, -5, 5, -3, 0] } : {}}
                transition={{ duration: 1.5 }}
                className="flex flex-col items-center"
              >
                <div className="w-40 h-40 md:w-52 md:h-52 rounded-2xl bg-gradient-to-br from-yellow-500/20 via-amber-500/10 to-orange-500/20 border-2 border-yellow-500/30 flex items-center justify-center relative overflow-hidden">
                  <div className="absolute inset-0 bg-gradient-to-t from-yellow-500/5 to-transparent" />
                  <Gift className={`w-20 h-20 text-yellow-400 ${isOpening ? 'animate-bounce' : ''}`} />
                  {!isOpening && (
                    <motion.div
                      className="absolute inset-0 flex items-center justify-center"
                      animate={{ opacity: [0.3, 0.6, 0.3] }}
                      transition={{ duration: 2, repeat: Infinity }}
                    >
                      <Sparkles className="w-32 h-32 text-yellow-400/20" />
                    </motion.div>
                  )}
                </div>
                <Button
                  onClick={handleOpen}
                  disabled={isOpening}
                  className="mt-6 bg-gradient-to-r from-yellow-500 to-amber-500 text-black font-bold text-lg px-8 py-3 h-auto"
                >
                  {isOpening ? 'Ouverture...' : 'Ouvrir le coffre'}
                </Button>
              </motion.div>
            ) : (
              <motion.div
                key="opened"
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 300, damping: 20 }}
                className="flex flex-col items-center"
              >
                <div className="w-40 h-40 md:w-52 md:h-52 rounded-2xl bg-gradient-to-br from-green-500/20 via-emerald-500/10 to-cyan-500/20 border-2 border-green-500/30 flex items-center justify-center">
                  <Sparkles className="w-20 h-20 text-green-400" />
                </div>
                <motion.div
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.3 }}
                  className="mt-6 text-center"
                >
                  <p className="text-2xl font-bold font-orbitron text-foreground">
                    {giftResult?.label || todaysGift?.gift_value || 'Récompense obtenue !'}
                  </p>
                  <p className="text-muted-foreground mt-2">Reviens demain pour un nouveau coffre</p>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>

      {/* How it works */}
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}>
        <Card className="bg-card/50 backdrop-blur border-border">
          <CardContent className="pt-5">
            <h3 className="font-semibold text-foreground mb-3">Comment ça marche ?</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm text-muted-foreground">
              <p>Ouvre ton coffre chaque jour pour gagner des points, coupons, tickets ou crédits.</p>
              <p>Plus ton streak est long, meilleures sont les récompenses (min -10% à 7j+).</p>
              <p>Le multiplicateur augmente tes gains de points : x2 à 7j, x5 à 30j, x10 à 100j.</p>
              <p>Ne manque pas un jour pour ne pas casser ton streak !</p>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
