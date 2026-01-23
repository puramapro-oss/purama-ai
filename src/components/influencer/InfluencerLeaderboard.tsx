'use client'

import { motion } from 'framer-motion'
import { Trophy, Medal, Crown, TrendingUp, Star } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Skeleton } from '@/components/ui/skeleton'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/integrations/supabase/client'
import { useAuth } from '@/hooks/useAuth'
import { COMMISSION_TIERS } from '@/hooks/useInfluencer'

interface LeaderboardEntry {
  id: string
  beneficiary_name: string | null
  total_sales: number
  total_revenue: number
  commission_tier: 'bronze' | 'silver' | 'gold'
  commission_rate: number
  rank: number
}

export function InfluencerLeaderboard() {
  const { user } = useAuth()

  const { data: leaderboard, isLoading } = useQuery({
    queryKey: ['influencer-leaderboard'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('influencer_leaderboard')
        .select('*')
        .limit(10)

      if (error) throw error
      return data as LeaderboardEntry[]
    },
    enabled: !!user,
  })

  const { data: currentInfluencer } = useQuery({
    queryKey: ['current-influencer-rank', user?.id],
    queryFn: async () => {
      if (!user?.id) return null
      
      const { data: influencer } = await supabase
        .from('influencers')
        .select('id')
        .eq('user_id', user.id)
        .maybeSingle()
      
      if (!influencer) return null

      const { data } = await supabase
        .from('influencer_leaderboard')
        .select('*')
        .eq('id', influencer.id)
        .maybeSingle()

      return data as LeaderboardEntry | null
    },
    enabled: !!user,
  })

  const getRankIcon = (rank: number) => {
    switch (rank) {
      case 1:
        return <Crown className="w-5 h-5 text-yellow-500" />
      case 2:
        return <Medal className="w-5 h-5 text-slate-400" />
      case 3:
        return <Medal className="w-5 h-5 text-amber-600" />
      default:
        return <span className="text-sm font-bold text-muted-foreground">#{rank}</span>
    }
  }

  const getRankStyle = (rank: number) => {
    switch (rank) {
      case 1:
        return 'bg-gradient-to-r from-yellow-500/20 to-amber-500/10 border-yellow-500/30'
      case 2:
        return 'bg-gradient-to-r from-slate-400/20 to-slate-500/10 border-slate-400/30'
      case 3:
        return 'bg-gradient-to-r from-amber-600/20 to-orange-500/10 border-amber-600/30'
      default:
        return 'bg-secondary/30 border-border'
    }
  }

  const getInitials = (name: string | null) => {
    if (!name) return '?'
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
  }

  if (isLoading) {
    return (
      <Card className="glass-effect">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Trophy className="w-5 h-5" />
            Classement
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="glass-effect overflow-hidden">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Trophy className="w-5 h-5 text-yellow-500" />
            Classement Top 10
          </CardTitle>
          {currentInfluencer && (
            <Badge variant="outline" className="bg-primary/10">
              Vous êtes #{currentInfluencer.rank}
            </Badge>
          )}
        </div>
        <CardDescription>
          Les influenceurs avec le plus de ventes
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {!leaderboard || leaderboard.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Trophy className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>Aucun influenceur dans le classement</p>
            <p className="text-sm">Soyez le premier à faire une vente !</p>
          </div>
        ) : (
          leaderboard.map((entry, index) => {
            const isCurrentUser = currentInfluencer?.id === entry.id
            const tierConfig = COMMISSION_TIERS[entry.commission_tier || 'bronze']
            
            return (
              <motion.div
                key={entry.id}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.05 }}
                className={`
                  relative flex items-center gap-3 p-3 rounded-xl border transition-all
                  ${getRankStyle(entry.rank)}
                  ${isCurrentUser ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''}
                `}
              >
                {/* Rank */}
                <div className="flex-shrink-0 w-8 h-8 flex items-center justify-center">
                  {getRankIcon(entry.rank)}
                </div>

                {/* Avatar */}
                <Avatar className="w-10 h-10 border-2 border-background">
                  <AvatarFallback className={`${tierConfig.bgColor} ${tierConfig.color} font-bold`}>
                    {getInitials(entry.beneficiary_name)}
                  </AvatarFallback>
                </Avatar>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-foreground truncate">
                      {entry.beneficiary_name || 'Influenceur'}
                    </p>
                    {isCurrentUser && (
                      <Badge variant="secondary" className="text-xs">
                        <Star className="w-3 h-3 mr-1" />
                        Vous
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <span className={tierConfig.color}>{tierConfig.icon}</span>
                    <span>{tierConfig.name}</span>
                    <span>•</span>
                    <span>{entry.commission_rate}%</span>
                  </div>
                </div>

                {/* Stats */}
                <div className="text-right flex-shrink-0">
                  <div className="flex items-center gap-1 text-foreground font-bold">
                    <TrendingUp className="w-4 h-4 text-primary" />
                    {entry.total_sales}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {Number(entry.total_revenue).toFixed(0)}€
                  </p>
                </div>

                {/* Special effects for top 3 */}
                {entry.rank === 1 && (
                  <motion.div
                    className="absolute inset-0 rounded-xl pointer-events-none"
                    style={{
                      background: 'linear-gradient(90deg, transparent, rgba(234, 179, 8, 0.1), transparent)',
                    }}
                    animate={{
                      x: ['-100%', '100%'],
                    }}
                    transition={{
                      duration: 3,
                      repeat: Infinity,
                      repeatDelay: 2,
                    }}
                  />
                )}
              </motion.div>
            )
          })
        )}

        {/* Show current user if not in top 10 */}
        {currentInfluencer && currentInfluencer.rank > 10 && (
          <>
            <div className="flex items-center justify-center gap-2 py-2 text-muted-foreground">
              <span>•••</span>
            </div>
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex items-center gap-3 p-3 rounded-xl border border-primary/30 bg-primary/10 ring-2 ring-primary ring-offset-2 ring-offset-background"
            >
              <div className="flex-shrink-0 w-8 h-8 flex items-center justify-center">
                <span className="text-sm font-bold text-primary">#{currentInfluencer.rank}</span>
              </div>
              <Avatar className="w-10 h-10 border-2 border-primary">
                <AvatarFallback className="bg-primary/20 text-primary font-bold">
                  {getInitials(currentInfluencer.beneficiary_name)}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-medium text-foreground truncate">
                    {currentInfluencer.beneficiary_name || 'Vous'}
                  </p>
                  <Badge variant="secondary" className="text-xs">
                    <Star className="w-3 h-3 mr-1" />
                    Vous
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  {COMMISSION_TIERS[currentInfluencer.commission_tier || 'bronze'].icon} {COMMISSION_TIERS[currentInfluencer.commission_tier || 'bronze'].name}
                </p>
              </div>
              <div className="text-right flex-shrink-0">
                <div className="flex items-center gap-1 text-foreground font-bold">
                  <TrendingUp className="w-4 h-4 text-primary" />
                  {currentInfluencer.total_sales}
                </div>
                <p className="text-xs text-muted-foreground">
                  {Number(currentInfluencer.total_revenue).toFixed(0)}€
                </p>
              </div>
            </motion.div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
