import { motion } from 'framer-motion';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Link } from 'react-router-dom';

const credits = [
  { date: '27 fév 2026', action: 'Création agent ShopAssist', used: 1, balance: 18 },
  { date: '25 fév 2026', action: 'Création agent LegalBot', used: 1, balance: 19 },
  { date: '20 fév 2026', action: 'Régénération SupportPro', used: 1, balance: 20 },
  { date: '15 fév 2026', action: 'Création agent RecruitHelper', used: 1, balance: 21 },
];

const packs = [
  { amount: 10, price: '4,90€', perCredit: '0,49€' },
  { amount: 50, price: '19,90€', perCredit: '0,40€' },
  { amount: 100, price: '34,90€', perCredit: '0,35€' },
  { amount: 500, price: '149€', perCredit: '0,30€' },
];

export default function DashboardBilling() {
  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-orbitron font-bold text-foreground">Abonnement & Crédits</h1>

      {/* Current Plan */}
      <Card className="bg-card border-accent-purple/30" style={{ boxShadow: '0 0 20px rgba(124,58,237,0.15)' }}>
        <CardContent className="p-6">
          <div className="flex flex-col sm:flex-row justify-between items-start gap-4">
            <div>
              <span className="px-3 py-1 rounded-full bg-gradient-to-r from-accent-cyan to-accent-purple text-primary-foreground text-xs font-bold">⭐ PROFESSIONNEL</span>
              <h2 className="text-3xl font-orbitron font-bold text-foreground mt-3">19€<span className="text-lg text-muted-foreground">/mois</span></h2>
              <p className="text-sm text-muted-foreground mt-1">Renouvellement le 15 mars 2026</p>
            </div>
            <Link to="/pricing" className="btn-secondary text-sm px-4 py-2">Changer de plan →</Link>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-6">
            <div>
              <p className="text-xs text-muted-foreground mb-1">Agents (3/5)</p>
              <Progress value={60} className="h-2" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Conversations (1 247/2 000)</p>
              <Progress value={62} className="h-2" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Crédits (18/30)</p>
              <Progress value={60} className="h-2" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Credit History */}
      <div>
        <h3 className="font-orbitron font-bold text-foreground mb-4">Historique des crédits</h3>
        <Card className="bg-card border-border">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-3 px-4 text-muted-foreground font-medium">Date</th>
                    <th className="text-left py-3 px-4 text-muted-foreground font-medium">Action</th>
                    <th className="text-center py-3 px-4 text-muted-foreground font-medium">Crédits</th>
                    <th className="text-center py-3 px-4 text-muted-foreground font-medium">Solde</th>
                  </tr>
                </thead>
                <tbody>
                  {credits.map((c, i) => (
                    <tr key={i} className="border-b border-border/30">
                      <td className="py-3 px-4 text-foreground/70">{c.date}</td>
                      <td className="py-3 px-4 text-foreground/80">{c.action}</td>
                      <td className="text-center py-3 px-4 text-destructive">-{c.used}</td>
                      <td className="text-center py-3 px-4 text-foreground">{c.balance}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Credit Packs */}
      <div>
        <h3 className="font-orbitron font-bold text-foreground mb-4">Packs de crédits</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {packs.map((pack, i) => (
            <motion.div key={i} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.1 }}>
              <Card className="bg-card border-border hover:border-accent-cyan/30 transition-all cursor-pointer">
                <CardContent className="p-5 text-center">
                  <p className="text-2xl font-orbitron font-bold text-foreground">{pack.amount}</p>
                  <p className="text-xs text-muted-foreground mb-2">crédits</p>
                  <p className="text-lg font-semibold text-accent-cyan">{pack.price}</p>
                  <p className="text-xs text-muted-foreground">{pack.perCredit}/crédit</p>
                  <button className="btn-secondary text-xs mt-3 px-3 py-1.5 w-full">Acheter</button>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}
