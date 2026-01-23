'use client'

import { motion } from 'framer-motion'
import { Crown, Award, Medal } from 'lucide-react'
import { COMMISSION_TIERS } from '@/hooks/useInfluencer'

interface TierBadgeProps {
  tier: 'bronze' | 'silver' | 'gold'
  commissionRate: number
  size?: 'sm' | 'md' | 'lg'
}

export function TierBadge({ tier, commissionRate, size = 'md' }: TierBadgeProps) {
  const tierConfig = COMMISSION_TIERS[tier]
  
  const sizeClasses = {
    sm: 'px-2 py-1 text-xs gap-1',
    md: 'px-3 py-1.5 text-sm gap-1.5',
    lg: 'px-4 py-2 text-base gap-2',
  }
  
  const iconSizes = {
    sm: 'w-3 h-3',
    md: 'w-4 h-4',
    lg: 'w-5 h-5',
  }
  
  const TierIcon = tier === 'gold' ? Crown : tier === 'silver' ? Award : Medal
  
  const isGold = tier === 'gold'
  
  return (
    <motion.div
      initial={{ scale: 0.9, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      className="relative"
    >
      {/* Gold glow effect */}
      {isGold && (
        <>
          <motion.div
            className="absolute inset-0 rounded-full bg-gradient-to-r from-yellow-400 via-amber-300 to-yellow-500 blur-lg opacity-50"
            animate={{
              scale: [1, 1.2, 1],
              opacity: [0.4, 0.6, 0.4],
            }}
            transition={{
              duration: 2,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          />
          <motion.div
            className="absolute -inset-1 rounded-full bg-gradient-to-r from-yellow-400/30 via-amber-300/30 to-yellow-500/30 blur-sm"
            animate={{
              rotate: [0, 360],
            }}
            transition={{
              duration: 8,
              repeat: Infinity,
              ease: "linear",
            }}
          />
        </>
      )}
      
      <motion.div
        className={`
          relative flex items-center rounded-full font-semibold
          ${sizeClasses[size]}
          ${isGold 
            ? 'bg-gradient-to-r from-yellow-500 via-amber-400 to-yellow-600 text-yellow-950 shadow-lg shadow-yellow-500/30' 
            : tier === 'silver'
              ? 'bg-gradient-to-r from-slate-300 via-slate-200 to-slate-400 text-slate-800 shadow-md'
              : 'bg-gradient-to-r from-amber-600 via-amber-500 to-amber-700 text-amber-950 shadow-md'
          }
        `}
        whileHover={{ scale: 1.05 }}
        animate={isGold ? {
          boxShadow: [
            '0 0 20px rgba(234, 179, 8, 0.3)',
            '0 0 30px rgba(234, 179, 8, 0.5)',
            '0 0 20px rgba(234, 179, 8, 0.3)',
          ],
        } : undefined}
        transition={isGold ? {
          duration: 1.5,
          repeat: Infinity,
          ease: "easeInOut",
        } : undefined}
      >
        <motion.span
          animate={isGold ? { 
            rotate: [0, -10, 10, -5, 5, 0],
          } : undefined}
          transition={isGold ? {
            duration: 2,
            repeat: Infinity,
            repeatDelay: 3,
          } : undefined}
        >
          <TierIcon className={iconSizes[size]} />
        </motion.span>
        
        <span className="font-bold">{tierConfig.name}</span>
        <span className="opacity-80">•</span>
        <span>{commissionRate}%</span>
        
        {/* Sparkle effects for Gold */}
        {isGold && (
          <>
            {[...Array(4)].map((_, i) => (
              <motion.span
                key={i}
                className="absolute text-yellow-200 pointer-events-none"
                style={{
                  top: `${20 + Math.random() * 60}%`,
                  left: `${10 + Math.random() * 80}%`,
                  fontSize: '8px',
                }}
                initial={{ opacity: 0, scale: 0 }}
                animate={{
                  opacity: [0, 1, 0],
                  scale: [0, 1, 0],
                }}
                transition={{
                  duration: 1.5,
                  repeat: Infinity,
                  delay: i * 0.4,
                  repeatDelay: 1,
                }}
              >
                ✦
              </motion.span>
            ))}
          </>
        )}
      </motion.div>
    </motion.div>
  )
}
