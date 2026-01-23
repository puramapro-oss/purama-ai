'use client'

import { motion } from 'framer-motion'
import { Trophy, ArrowRight } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { COMMISSION_TIERS, getTierProgress } from '@/hooks/useInfluencer'

interface TierProgressProps {
  currentTier: 'bronze' | 'silver' | 'gold'
  totalSales: number
  commissionRate: number
}

export function TierProgress({ currentTier, totalSales, commissionRate }: TierProgressProps) {
  const tierConfig = COMMISSION_TIERS[currentTier]
  const { progress, nextTier, salesNeeded } = getTierProgress(totalSales, currentTier)
  const nextTierConfig = nextTier ? COMMISSION_TIERS[nextTier as keyof typeof COMMISSION_TIERS] : null

  return (
    <Card className="glass-effect overflow-hidden">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Trophy className="w-5 h-5" />
            Palier de commission
          </CardTitle>
          <Badge className={`${tierConfig.bgColor} ${tierConfig.color} border ${tierConfig.borderColor}`}>
            {tierConfig.icon} {tierConfig.name}
          </Badge>
        </div>
        <CardDescription>
          Augmentez votre taux de commission en générant plus de ventes
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Current Tier Display */}
        <div className="flex items-center justify-center gap-4 py-4">
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="text-center"
          >
            <div className={`text-5xl mb-2`}>{tierConfig.icon}</div>
            <p className={`text-2xl font-bold ${tierConfig.color}`}>
              {commissionRate}%
            </p>
            <p className="text-sm text-muted-foreground">Commission actuelle</p>
          </motion.div>
        </div>

        {/* Progress to Next Tier */}
        {nextTierConfig && (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                <span className={tierConfig.color}>{tierConfig.icon} {tierConfig.name}</span>
                <ArrowRight className="w-4 h-4 text-muted-foreground" />
                <span className={nextTierConfig.color}>{nextTierConfig.icon} {nextTierConfig.name}</span>
              </div>
              <span className="text-muted-foreground">
                {salesNeeded} vente{salesNeeded > 1 ? 's' : ''} restante{salesNeeded > 1 ? 's' : ''}
              </span>
            </div>
            <Progress value={progress} className="h-3" />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{totalSales} ventes</span>
              <span>{nextTierConfig.minSales} ventes pour {nextTierConfig.name}</span>
            </div>
          </div>
        )}

        {/* All Tiers Overview */}
        <div className="grid grid-cols-3 gap-3 pt-4 border-t border-border">
          {Object.entries(COMMISSION_TIERS).map(([key, tier]) => {
            const isActive = key === currentTier
            const isCompleted = 
              (key === 'bronze' && (currentTier === 'silver' || currentTier === 'gold')) ||
              (key === 'silver' && currentTier === 'gold')
            
            return (
              <motion.div
                key={key}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Object.keys(COMMISSION_TIERS).indexOf(key) * 0.1 }}
                className={`
                  relative p-4 rounded-xl text-center transition-all
                  ${isActive ? `${tier.bgColor} ${tier.borderColor} border-2` : 'bg-secondary/30 border border-border'}
                  ${isCompleted ? 'opacity-60' : ''}
                `}
              >
                {isActive && (
                  <div className="absolute -top-2 left-1/2 -translate-x-1/2">
                    <Badge variant="default" className="text-xs px-2 py-0">
                      Actuel
                    </Badge>
                  </div>
                )}
                <div className="text-2xl mb-1">{tier.icon}</div>
                <p className={`font-bold ${isActive ? tier.color : 'text-foreground'}`}>
                  {tier.rate}%
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {tier.minSales === 0 ? '0-19' : tier.minSales === 20 ? '20-49' : '50+'} ventes
                </p>
              </motion.div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
