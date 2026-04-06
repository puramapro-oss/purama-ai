import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft, Loader2, BarChart3, TrendingUp, TrendingDown,
  PieChart as PieIcon, Receipt, Wallet,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import {
  Tabs, TabsContent, TabsList, TabsTrigger,
} from '@/components/ui/tabs';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import {
  listTransactions, formatEUR, type ComptaTransaction,
} from '@/lib/compta';

interface CategoryAggregate {
  pcg: string;
  label: string;
  total: number;
  count: number;
}

export default function ComptaAgentReports() {
  const { user } = useAuth();
  const [txs, setTxs] = useState<ComptaTransaction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        // Fetch the current fiscal year (start = January)
        const start = `${new Date().getFullYear()}-01-01`;
        setTxs(await listTransactions(user.id, { from: start, limit: 5000 }));
      } catch (e) {
        toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
      } finally {
        setLoading(false);
      }
    })();
  }, [user?.id]);

  if (loading) {
    return <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-accent-cyan" /></div>;
  }

  // Aggregate
  const credits = txs.filter(t => t.type === 'credit' || t.amount > 0);
  const debits = txs.filter(t => t.type === 'debit' || t.amount < 0);

  const totalRevenue = credits.reduce((s, t) => s + Math.abs(Number(t.amount)), 0);
  const totalExpenses = debits.reduce((s, t) => s + Math.abs(Number(t.amount)), 0);
  const result = totalRevenue - totalExpenses;
  const tvaCollectee = credits.reduce((s, t) => s + Number(t.tva_amount ?? 0), 0);
  const tvaDeductible = debits.reduce((s, t) => s + Number(t.tva_amount ?? 0), 0);
  const tvaNet = tvaCollectee - tvaDeductible;

  // Group expenses by PCG account
  const expensesByCategory = new Map<string, CategoryAggregate>();
  for (const t of debits) {
    const key = t.pcg_account || 'autres';
    const cur = expensesByCategory.get(key) ?? { pcg: key, label: t.pcg_label || 'Non catégorisé', total: 0, count: 0 };
    cur.total += Math.abs(Number(t.amount));
    cur.count++;
    expensesByCategory.set(key, cur);
  }
  const topCategories = [...expensesByCategory.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  // Group revenue by month
  const revenueByMonth = new Map<string, number>();
  for (const t of credits) {
    const m = t.date.slice(0, 7);
    revenueByMonth.set(m, (revenueByMonth.get(m) ?? 0) + Math.abs(Number(t.amount)));
  }
  const monthlyRevenue = [...revenueByMonth.entries()].sort();

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}>
        <Link to="/dashboard/compta-agent" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-1">
          <ArrowLeft className="w-3 h-3" /> Retour
        </Link>
        <h1 className="text-2xl font-orbitron font-bold text-foreground flex items-center gap-2">
          <BarChart3 className="w-6 h-6 text-emerald-400" /> Rapports — exercice {new Date().getFullYear()}
        </h1>
      </motion.div>

      <Tabs defaultValue="resultat">
        <TabsList>
          <TabsTrigger value="resultat">Compte de résultat</TabsTrigger>
          <TabsTrigger value="tva">TVA</TabsTrigger>
          <TabsTrigger value="categories">Par catégorie</TabsTrigger>
          <TabsTrigger value="evolution">Évolution</TabsTrigger>
        </TabsList>

        <TabsContent value="resultat" className="space-y-3">
          <Card className="bg-card border-border">
            <CardContent className="p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <TrendingUp className="w-5 h-5 text-emerald-400" />
                  <span className="text-sm text-foreground">Produits (CA)</span>
                </div>
                <span className="font-orbitron font-bold text-emerald-400">{formatEUR(totalRevenue)}</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <TrendingDown className="w-5 h-5 text-red-400" />
                  <span className="text-sm text-foreground">Charges</span>
                </div>
                <span className="font-orbitron font-bold text-red-400">−{formatEUR(totalExpenses)}</span>
              </div>
              <div className="border-t border-border pt-3 flex items-center justify-between">
                <span className="text-sm font-semibold text-foreground">Résultat</span>
                <span className={`text-2xl font-orbitron font-bold ${result >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {result >= 0 ? '+' : ''}{formatEUR(result)}
                </span>
              </div>
            </CardContent>
          </Card>
          <p className="text-[11px] text-muted-foreground text-center">
            Vue simplifiée · {txs.length} transactions analysées
          </p>
        </TabsContent>

        <TabsContent value="tva" className="space-y-3">
          <Card className="bg-card border-border">
            <CardContent className="p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2"><Receipt className="w-4 h-4 text-accent-cyan" /><span className="text-sm">TVA collectée (sur ventes)</span></div>
                <span className="font-orbitron font-semibold text-foreground">{formatEUR(tvaCollectee)}</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2"><Receipt className="w-4 h-4 text-accent-purple" /><span className="text-sm">TVA déductible (sur achats)</span></div>
                <span className="font-orbitron font-semibold text-foreground">−{formatEUR(tvaDeductible)}</span>
              </div>
              <div className="border-t border-border pt-3 flex items-center justify-between">
                <span className="text-sm font-semibold text-foreground">TVA nette à payer</span>
                <span className={`text-2xl font-orbitron font-bold ${tvaNet >= 0 ? 'text-yellow-400' : 'text-emerald-400'}`}>
                  {formatEUR(tvaNet)}
                </span>
              </div>
              {tvaNet < 0 && <p className="text-[11px] text-emerald-400">Crédit de TVA en ta faveur 🎉</p>}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="categories" className="space-y-2">
          {topCategories.length === 0 ? (
            <Card className="bg-card border-border">
              <CardContent className="p-10 text-center text-sm text-muted-foreground">Aucune dépense.</CardContent>
            </Card>
          ) : (
            topCategories.map(c => {
              const pct = totalExpenses > 0 ? (c.total / totalExpenses) * 100 : 0;
              return (
                <Card key={c.pcg} className="bg-card border-border">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <PieIcon className="w-4 h-4 text-accent-purple flex-shrink-0" />
                        <span className="text-sm font-medium text-foreground truncate">{c.label}</span>
                        <span className="text-[10px] font-mono text-muted-foreground">{c.pcg}</span>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-sm font-orbitron font-bold text-foreground">{formatEUR(c.total)}</p>
                        <p className="text-[10px] text-muted-foreground">{c.count} tx · {pct.toFixed(1)}%</p>
                      </div>
                    </div>
                    <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-accent-purple to-accent-cyan"
                        style={{ width: `${Math.min(100, pct)}%` }}
                      />
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </TabsContent>

        <TabsContent value="evolution" className="space-y-2">
          {monthlyRevenue.length === 0 ? (
            <Card className="bg-card border-border">
              <CardContent className="p-10 text-center text-sm text-muted-foreground">Pas de données.</CardContent>
            </Card>
          ) : (
            <Card className="bg-card border-border">
              <CardContent className="p-5">
                <div className="flex items-end gap-2 h-48">
                  {monthlyRevenue.map(([m, v]) => {
                    const max = Math.max(...monthlyRevenue.map(([, x]) => x));
                    const h = max > 0 ? (v / max) * 100 : 0;
                    return (
                      <div key={m} className="flex-1 flex flex-col items-center gap-1">
                        <div className="w-full bg-gradient-to-t from-accent-cyan to-accent-purple rounded-t" style={{ height: `${h}%` }} />
                        <span className="text-[9px] text-muted-foreground">{m.slice(5)}</span>
                        <span className="text-[10px] font-mono text-foreground">{formatEUR(v)}</span>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      <Card className="bg-card border-border">
        <CardContent className="p-4 flex items-center gap-2 text-xs text-muted-foreground">
          <Wallet className="w-4 h-4" />
          Bilan complet et liasse fiscale (2050-2059) générés automatiquement par l'IA en fin d'exercice.
        </CardContent>
      </Card>
    </div>
  );
}
