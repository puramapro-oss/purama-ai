import { useState } from 'react';
import { motion } from 'framer-motion';
import { Wallet as WalletIcon, ArrowDownRight, ArrowUpRight, Clock, CreditCard, Send, TrendingUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useWallet, useWalletTransactions, useWithdrawals, useRequestWithdrawal } from '@/hooks/useWallet';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';

const fadeUp = {
  hidden: { opacity: 0, y: 20 },
  visible: (i: number) => ({ opacity: 1, y: 0, transition: { delay: i * 0.08, duration: 0.5 } }),
};

export default function Wallet() {
  const { data: wallet } = useWallet();
  const { data: transactions = [] } = useWalletTransactions();
  const { data: withdrawals = [] } = useWithdrawals();
  const withdrawMutation = useRequestWithdrawal();

  const [showWithdraw, setShowWithdraw] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [iban, setIban] = useState('');
  const [beneficiary, setBeneficiary] = useState('');

  const balance = Number(wallet?.balance || 0);
  const totalEarned = Number(wallet?.total_earned || 0);
  const totalWithdrawn = Number(wallet?.total_withdrawn || 0);

  const handleWithdraw = () => {
    const amount = parseFloat(withdrawAmount);
    if (isNaN(amount) || amount < 5) return;
    if (!iban.trim() || !beneficiary.trim()) return;

    withdrawMutation.mutate(
      { amount, iban: iban.trim(), beneficiaryName: beneficiary.trim() },
      { onSuccess: () => { setShowWithdraw(false); setWithdrawAmount(''); setIban(''); setBeneficiary(''); } }
    );
  };

  const statusBadge = (status: string) => {
    const map: Record<string, { label: string; className: string }> = {
      pending: { label: 'En attente', className: 'bg-yellow-500/20 text-yellow-400' },
      processing: { label: 'En cours', className: 'bg-blue-500/20 text-blue-400' },
      completed: { label: 'Effectué', className: 'bg-green-500/20 text-green-400' },
      rejected: { label: 'Refusé', className: 'bg-red-500/20 text-red-400' },
    };
    const s = map[status] || map.pending;
    return <Badge className={s.className}>{s.label}</Badge>;
  };

  return (
    <div className="space-y-6">
      <motion.div initial="hidden" animate="visible" variants={fadeUp} custom={0}>
        <h1 className="text-2xl font-orbitron font-bold text-foreground flex items-center gap-3">
          <WalletIcon className="w-7 h-7 text-accent-cyan" />
          Mon Wallet
        </h1>
        <p className="text-muted-foreground mt-1">Gère tes gains et retraits</p>
      </motion.div>

      {/* Stats cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[
          { label: 'Solde disponible', value: `${balance.toFixed(2)}€`, icon: WalletIcon, color: 'text-accent-cyan', bg: 'bg-accent-cyan/10' },
          { label: 'Total gagné', value: `${totalEarned.toFixed(2)}€`, icon: TrendingUp, color: 'text-green-400', bg: 'bg-green-500/10' },
          { label: 'Total retiré', value: `${totalWithdrawn.toFixed(2)}€`, icon: Send, color: 'text-accent-purple', bg: 'bg-accent-purple/10' },
        ].map((stat, i) => (
          <motion.div key={stat.label} variants={fadeUp} initial="hidden" animate="visible" custom={i + 1}>
            <Card className="bg-card/50 backdrop-blur border-border">
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">{stat.label}</p>
                    <p className={`text-2xl font-bold font-orbitron ${stat.color}`}>{stat.value}</p>
                  </div>
                  <div className={`p-3 rounded-xl ${stat.bg}`}>
                    <stat.icon className={`w-6 h-6 ${stat.color}`} />
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* Withdraw section */}
      <motion.div variants={fadeUp} initial="hidden" animate="visible" custom={4}>
        <Card className="bg-card/50 backdrop-blur border-border">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-lg">Retirer mes gains</CardTitle>
            <Button
              onClick={() => setShowWithdraw(!showWithdraw)}
              disabled={balance < 5}
              className="bg-gradient-to-r from-accent-purple to-accent-cyan"
            >
              <Send className="w-4 h-4 mr-2" />
              Retirer
            </Button>
          </CardHeader>
          {balance < 5 && (
            <CardContent>
              <p className="text-sm text-muted-foreground">Minimum 5€ pour effectuer un retrait. Solde actuel : {balance.toFixed(2)}€</p>
            </CardContent>
          )}
          {showWithdraw && balance >= 5 && (
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="text-sm text-muted-foreground mb-1 block">Montant (€)</label>
                  <Input
                    type="number"
                    min="5"
                    max={balance}
                    value={withdrawAmount}
                    onChange={(e) => setWithdrawAmount(e.target.value)}
                    placeholder="5.00"
                  />
                </div>
                <div>
                  <label className="text-sm text-muted-foreground mb-1 block">IBAN</label>
                  <Input
                    value={iban}
                    onChange={(e) => setIban(e.target.value)}
                    placeholder="FR76 3000 1234 5678 9012 3456 789"
                  />
                </div>
                <div>
                  <label className="text-sm text-muted-foreground mb-1 block">Nom du bénéficiaire</label>
                  <Input
                    value={beneficiary}
                    onChange={(e) => setBeneficiary(e.target.value)}
                    placeholder="Jean Dupont"
                  />
                </div>
              </div>
              <Button
                onClick={handleWithdraw}
                disabled={withdrawMutation.isPending || !withdrawAmount || !iban || !beneficiary}
                className="bg-gradient-to-r from-green-500 to-emerald-500"
              >
                {withdrawMutation.isPending ? 'Envoi...' : 'Confirmer le retrait'}
              </Button>
            </CardContent>
          )}
        </Card>
      </motion.div>

      {/* Withdrawal history */}
      {withdrawals.length > 0 && (
        <motion.div variants={fadeUp} initial="hidden" animate="visible" custom={5}>
          <Card className="bg-card/50 backdrop-blur border-border">
            <CardHeader>
              <CardTitle className="text-lg">Historique des retraits</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {withdrawals.map((w) => (
                  <div key={w.id} className="flex items-center justify-between p-3 rounded-lg bg-secondary/30">
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-accent-purple/10">
                        <Send className="w-4 h-4 text-accent-purple" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-foreground">{Number(w.amount).toFixed(2)}€</p>
                        <p className="text-xs text-muted-foreground">
                          {w.requested_at ? format(new Date(w.requested_at), 'dd MMM yyyy', { locale: fr }) : ''}
                        </p>
                      </div>
                    </div>
                    {statusBadge(w.status)}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* Transaction history */}
      <motion.div variants={fadeUp} initial="hidden" animate="visible" custom={6}>
        <Card className="bg-card/50 backdrop-blur border-border">
          <CardHeader>
            <CardTitle className="text-lg">Historique des transactions</CardTitle>
          </CardHeader>
          <CardContent>
            {transactions.length === 0 ? (
              <div className="text-center py-8">
                <Clock className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
                <p className="text-muted-foreground">Aucune transaction pour le moment</p>
                <p className="text-sm text-muted-foreground/60">Tes gains de parrainage et concours apparaîtront ici</p>
              </div>
            ) : (
              <div className="space-y-2">
                {transactions.map((tx) => (
                  <div key={tx.id} className="flex items-center justify-between p-3 rounded-lg bg-secondary/20 hover:bg-secondary/30 transition-colors">
                    <div className="flex items-center gap-3">
                      <div className={`p-2 rounded-lg ${tx.type === 'credit' ? 'bg-green-500/10' : 'bg-red-500/10'}`}>
                        {tx.type === 'credit' ? (
                          <ArrowDownRight className="w-4 h-4 text-green-400" />
                        ) : (
                          <ArrowUpRight className="w-4 h-4 text-red-400" />
                        )}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-foreground">{tx.description || tx.source}</p>
                        <p className="text-xs text-muted-foreground">
                          {tx.created_at ? format(new Date(tx.created_at), 'dd MMM yyyy HH:mm', { locale: fr }) : ''}
                        </p>
                      </div>
                    </div>
                    <span className={`font-mono font-medium ${tx.type === 'credit' ? 'text-green-400' : 'text-red-400'}`}>
                      {tx.type === 'credit' ? '+' : '-'}{Math.abs(Number(tx.amount)).toFixed(2)}€
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
