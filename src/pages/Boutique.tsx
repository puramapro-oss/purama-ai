import { motion } from 'framer-motion';
import { ShoppingBag, Star, Ticket, CreditCard, Coins, Gift, Zap } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { usePoints, usePointTransactions, useShopItems, usePurchaseItem, getStreakMultiplier } from '@/hooks/usePoints';

const fadeUp = {
  hidden: { opacity: 0, y: 20 },
  visible: (i: number) => ({ opacity: 1, y: 0, transition: { delay: i * 0.08, duration: 0.5 } }),
};

const categoryIcons: Record<string, typeof Star> = {
  reductions: Zap,
  abonnements: CreditCard,
  tickets: Ticket,
  cash: Coins,
};

const categoryLabels: Record<string, string> = {
  reductions: 'Réductions',
  abonnements: 'Abonnements gratuits',
  tickets: 'Tickets tirage',
  cash: 'Argent réel',
};

export default function Boutique() {
  const { data: points } = usePoints();
  const { data: transactions = [] } = usePointTransactions();
  const { data: items = [] } = useShopItems();
  const purchaseMutation = usePurchaseItem();

  const balance = points?.balance || 0;
  const lifetime = points?.lifetime_earned || 0;
  const streakDays = points?.streak_days || 0;
  const multiplier = getStreakMultiplier(streakDays);

  const categories = [...new Set(items.map((i) => i.category))];

  const handlePurchase = (itemId: string, cost: number) => {
    if (balance < cost) return;
    purchaseMutation.mutate({ itemId, pointsCost: cost });
  };

  // Next conversion milestone
  const milestones = [
    { points: 25000, euros: 2.5 },
    { points: 50000, euros: 5 },
    { points: 100000, euros: 10 },
  ];
  const nextMilestone = milestones.find((m) => m.points > balance) || milestones[milestones.length - 1];
  const milestoneProgress = Math.min((balance / nextMilestone.points) * 100, 100);

  return (
    <div className="space-y-6">
      <motion.div initial="hidden" animate="visible" variants={fadeUp} custom={0}>
        <h1 className="text-2xl font-orbitron font-bold text-foreground flex items-center gap-3">
          <ShoppingBag className="w-7 h-7 text-accent-purple" />
          Boutique Points
        </h1>
        <p className="text-muted-foreground mt-1">Échange tes points contre des récompenses</p>
      </motion.div>

      {/* Points stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {[
          { label: 'Solde points', value: balance.toLocaleString('fr-FR'), icon: Star, color: 'text-accent-purple', bg: 'bg-accent-purple/10' },
          { label: 'Valeur', value: `${(balance * 0.01).toFixed(2)}€`, icon: Coins, color: 'text-yellow-400', bg: 'bg-yellow-500/10' },
          { label: 'Streak', value: `${streakDays}j`, icon: Zap, color: 'text-accent-cyan', bg: 'bg-accent-cyan/10' },
          { label: 'Multiplicateur', value: `x${multiplier}`, icon: Gift, color: 'text-green-400', bg: 'bg-green-500/10' },
        ].map((stat, i) => (
          <motion.div key={stat.label} variants={fadeUp} initial="hidden" animate="visible" custom={i + 1}>
            <Card className="bg-card/50 backdrop-blur border-border">
              <CardContent className="pt-5 pb-4">
                <div className="flex items-center gap-3">
                  <div className={`p-2.5 rounded-xl ${stat.bg}`}>
                    <stat.icon className={`w-5 h-5 ${stat.color}`} />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{stat.label}</p>
                    <p className={`text-xl font-bold font-orbitron ${stat.color}`}>{stat.value}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* Conversion milestone */}
      <motion.div variants={fadeUp} initial="hidden" animate="visible" custom={5}>
        <Card className="bg-card/50 backdrop-blur border-border">
          <CardContent className="pt-5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-muted-foreground">Prochaine conversion auto</span>
              <span className="text-sm font-medium text-accent-cyan">
                {balance.toLocaleString('fr-FR')} / {nextMilestone.points.toLocaleString('fr-FR')} pts = {nextMilestone.euros}€
              </span>
            </div>
            <Progress value={milestoneProgress} className="h-2" />
          </CardContent>
        </Card>
      </motion.div>

      {/* Shop items by category */}
      {categories.map((cat, catIdx) => (
        <motion.div key={cat} variants={fadeUp} initial="hidden" animate="visible" custom={catIdx + 6}>
          <h2 className="text-lg font-bold text-foreground flex items-center gap-2 mb-3">
            {(() => { const Icon = categoryIcons[cat] || Star; return <Icon className="w-5 h-5 text-accent-cyan" />; })()}
            {categoryLabels[cat] || cat}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {items.filter((i) => i.category === cat).map((item) => (
              <Card key={item.id} className="bg-card/50 backdrop-blur border-border hover:border-accent-purple/30 transition-all">
                <CardContent className="pt-5 space-y-3">
                  <h3 className="font-semibold text-foreground">{item.name}</h3>
                  <p className="text-sm text-muted-foreground">{item.description}</p>
                  <div className="flex items-center justify-between pt-2">
                    <Badge className="bg-accent-purple/20 text-accent-purple">
                      {item.cost_points.toLocaleString('fr-FR')} pts
                    </Badge>
                    <Button
                      size="sm"
                      onClick={() => handlePurchase(item.id, item.cost_points)}
                      disabled={balance < item.cost_points || purchaseMutation.isPending}
                      className="bg-gradient-to-r from-accent-purple to-accent-cyan text-xs"
                    >
                      Échanger
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </motion.div>
      ))}

      {/* Recent point transactions */}
      <motion.div variants={fadeUp} initial="hidden" animate="visible" custom={10}>
        <Card className="bg-card/50 backdrop-blur border-border">
          <CardHeader>
            <CardTitle className="text-lg">Historique des points</CardTitle>
          </CardHeader>
          <CardContent>
            {transactions.length === 0 ? (
              <p className="text-center text-muted-foreground py-6">Aucune transaction de points</p>
            ) : (
              <div className="space-y-2">
                {transactions.slice(0, 20).map((tx) => (
                  <div key={tx.id} className="flex items-center justify-between p-2 rounded-lg hover:bg-secondary/20">
                    <div>
                      <p className="text-sm font-medium text-foreground">{tx.description || tx.source}</p>
                      <p className="text-xs text-muted-foreground">{tx.type}</p>
                    </div>
                    <span className={`font-mono text-sm font-medium ${tx.amount > 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {tx.amount > 0 ? '+' : ''}{tx.amount} pts
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
