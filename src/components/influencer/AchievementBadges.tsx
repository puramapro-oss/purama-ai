import { motion } from 'framer-motion';
import { Award, Lock, Trophy, Target, Zap, Crown, Star } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface Achievement {
  id: string;
  name: string;
  description: string;
  threshold: number;
  icon: React.ElementType;
  unlockedGradient: string;
  lockedBg: string;
}

const ACHIEVEMENTS: Achievement[] = [
  {
    id: 'first_sale',
    name: 'Première Vente',
    description: 'Réalisez votre première vente',
    threshold: 1,
    icon: Star,
    unlockedGradient: 'from-yellow-400 to-orange-500',
    lockedBg: 'bg-muted',
  },
  {
    id: 'rising_star',
    name: 'Étoile Montante',
    description: 'Atteignez 10 ventes',
    threshold: 10,
    icon: Zap,
    unlockedGradient: 'from-blue-400 to-cyan-500',
    lockedBg: 'bg-muted',
  },
  {
    id: 'top_seller',
    name: 'Top Vendeur',
    description: 'Atteignez 25 ventes',
    threshold: 25,
    icon: Target,
    unlockedGradient: 'from-green-400 to-emerald-500',
    lockedBg: 'bg-muted',
  },
  {
    id: 'champion',
    name: 'Champion',
    description: 'Atteignez 50 ventes',
    threshold: 50,
    icon: Trophy,
    unlockedGradient: 'from-purple-400 to-pink-500',
    lockedBg: 'bg-muted',
  },
  {
    id: 'legend',
    name: 'Légende',
    description: 'Atteignez 100 ventes',
    threshold: 100,
    icon: Crown,
    unlockedGradient: 'from-amber-400 to-yellow-500',
    lockedBg: 'bg-muted',
  },
];

interface AchievementBadgesProps {
  totalSales: number;
}

export function AchievementBadges({ totalSales }: AchievementBadgesProps) {
  const unlockedCount = ACHIEVEMENTS.filter(a => totalSales >= a.threshold).length;

  return (
    <Card className="glass-effect">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Award className="w-5 h-5 text-primary" />
          Badges de Réussite
          <span className="ml-auto text-sm font-normal text-muted-foreground">
            {unlockedCount}/{ACHIEVEMENTS.length} débloqués
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
          {ACHIEVEMENTS.map((achievement, index) => {
            const isUnlocked = totalSales >= achievement.threshold;
            const Icon = achievement.icon;
            const progress = Math.min((totalSales / achievement.threshold) * 100, 100);

            return (
              <motion.div
                key={achievement.id}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: index * 0.1 }}
                className="relative group"
              >
                <div
                  className={`
                    relative flex flex-col items-center p-4 rounded-xl border transition-all duration-300
                    ${isUnlocked 
                      ? 'border-primary/30 bg-gradient-to-br ' + achievement.unlockedGradient + ' shadow-lg' 
                      : 'border-border bg-card hover:border-muted-foreground/30'
                    }
                  `}
                >
                  {/* Icon */}
                  <div
                    className={`
                      w-12 h-12 rounded-full flex items-center justify-center mb-2 transition-all
                      ${isUnlocked 
                        ? 'bg-white/20 backdrop-blur-sm' 
                        : 'bg-muted'
                      }
                    `}
                  >
                    {isUnlocked ? (
                      <Icon className="w-6 h-6 text-white" />
                    ) : (
                      <Lock className="w-5 h-5 text-muted-foreground" />
                    )}
                  </div>

                  {/* Name */}
                  <p
                    className={`
                      text-xs font-semibold text-center mb-1
                      ${isUnlocked ? 'text-white' : 'text-foreground'}
                    `}
                  >
                    {achievement.name}
                  </p>

                  {/* Threshold */}
                  <p
                    className={`
                      text-[10px] text-center
                      ${isUnlocked ? 'text-white/80' : 'text-muted-foreground'}
                    `}
                  >
                    {achievement.threshold} ventes
                  </p>

                  {/* Progress bar for locked badges */}
                  {!isUnlocked && (
                    <div className="w-full mt-2">
                      <div className="h-1 bg-muted rounded-full overflow-hidden">
                        <motion.div
                          className="h-full bg-primary/60 rounded-full"
                          initial={{ width: 0 }}
                          animate={{ width: `${progress}%` }}
                          transition={{ duration: 0.8, delay: index * 0.1 }}
                        />
                      </div>
                      <p className="text-[9px] text-center text-muted-foreground mt-1">
                        {totalSales}/{achievement.threshold}
                      </p>
                    </div>
                  )}

                  {/* Sparkle effect for unlocked */}
                  {isUnlocked && (
                    <motion.div
                      className="absolute -top-1 -right-1 w-4 h-4 bg-white rounded-full"
                      animate={{
                        scale: [1, 1.2, 1],
                        opacity: [0.8, 1, 0.8],
                      }}
                      transition={{
                        duration: 2,
                        repeat: Infinity,
                        ease: 'easeInOut',
                      }}
                    >
                      <Star className="w-4 h-4 text-yellow-500 fill-yellow-500" />
                    </motion.div>
                  )}
                </div>

                {/* Tooltip on hover */}
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-popover border border-border rounded-lg shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none z-10 w-40">
                  <p className="text-xs font-medium text-foreground">{achievement.name}</p>
                  <p className="text-[10px] text-muted-foreground">{achievement.description}</p>
                </div>
              </motion.div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
