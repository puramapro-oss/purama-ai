import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Link, useNavigate } from 'react-router-dom';
import {
  Users, DollarSign, TrendingUp, Eye, ArrowLeft, Bot,
  BarChart3, CreditCard, Activity, Globe, UserPlus,
  ArrowUpRight, ArrowDownRight, RefreshCw, Shield, Calendar
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell } from 'recharts';

const ADMIN_EMAIL = 'matiss.frasne@gmail.com';

// Revenue data (simulated — to be replaced with real Stripe data)
const revenueData = [
  { month: 'Jan', revenue: 0, expenses: 120 },
  { month: 'Fév', revenue: 198, expenses: 120 },
  { month: 'Mar', revenue: 462, expenses: 135 },
  { month: 'Avr', revenue: 726, expenses: 135 },
  { month: 'Mai', revenue: 1188, expenses: 150 },
  { month: 'Jun', revenue: 1650, expenses: 150 },
  { month: 'Jul', revenue: 2310, expenses: 165 },
  { month: 'Aoû', revenue: 2970, expenses: 165 },
  { month: 'Sep', revenue: 3630, expenses: 180 },
  { month: 'Oct', revenue: 4290, expenses: 180 },
  { month: 'Nov', revenue: 5280, expenses: 195 },
  { month: 'Déc', revenue: 6270, expenses: 195 },
];

const planDistribution = [
  { name: 'Gratuit', value: 45, color: '#6b7280' },
  { name: 'Starter', value: 30, color: '#00f0ff' },
  { name: 'Premium', value: 25, color: '#7c3aed' },
];

const trafficData = [
  { day: 'Lun', visitors: 120, signups: 8 },
  { day: 'Mar', visitors: 145, signups: 12 },
  { day: 'Mer', visitors: 98, signups: 5 },
  { day: 'Jeu', visitors: 178, signups: 15 },
  { day: 'Ven', visitors: 203, signups: 18 },
  { day: 'Sam', visitors: 87, signups: 6 },
  { day: 'Dim', visitors: 65, signups: 3 },
];

export default function AdminDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [stats, setStats] = useState({
    totalUsers: 0,
    totalSubscriptions: 0,
    activeAgents: 0,
  });
  const [recentUsers, setRecentUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Security check
  useEffect(() => {
    if (user && user.email !== ADMIN_EMAIL) {
      navigate('/dashboard');
    }
  }, [user, navigate]);

  useEffect(() => {
    if (!user || user.email !== ADMIN_EMAIL) return;

    async function fetchData() {
      setLoading(true);
      try {
        // Fetch profiles count
        const { count: usersCount } = await supabase
          .from('profiles')
          .select('*', { count: 'exact', head: true });

        // Fetch subscriptions
        const { count: subsCount } = await supabase
          .from('subscriptions')
          .select('*', { count: 'exact', head: true })
          .neq('plan_type', 'free');

        // Fetch active agents
        const { count: agentsCount } = await supabase
          .from('agents')
          .select('*', { count: 'exact', head: true })
          .eq('is_active', true);

        // Fetch recent users
        const { data: recent } = await supabase
          .from('profiles')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(10);

        setStats({
          totalUsers: usersCount || 0,
          totalSubscriptions: subsCount || 0,
          activeAgents: agentsCount || 0,
        });

        setRecentUsers(recent || []);
      } catch (err) {
        console.error('Admin fetch error:', err);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [user]);

  if (!user || user.email !== ADMIN_EMAIL) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <Shield className="w-16 h-16 text-red-500 mx-auto mb-4" />
          <h1 className="text-2xl font-orbitron font-bold text-foreground mb-2">Accès refusé</h1>
          <p className="text-muted-foreground mb-4">Vous n'avez pas les droits d'accès à cette page.</p>
          <Link to="/dashboard">
            <Button>Retour au Dashboard</Button>
          </Link>
        </div>
      </div>
    );
  }

  // Calculate key metrics
  const currentMonthRevenue = revenueData[revenueData.length - 1]?.revenue || 0;
  const lastMonthRevenue = revenueData[revenueData.length - 2]?.revenue || 0;
  const revenueGrowth = lastMonthRevenue > 0 ? Math.round(((currentMonthRevenue - lastMonthRevenue) / lastMonthRevenue) * 100) : 0;
  const currentExpenses = revenueData[revenueData.length - 1]?.expenses || 0;
  const profit = currentMonthRevenue - currentExpenses;
  const totalRevenue = revenueData.reduce((sum, d) => sum + d.revenue, 0);
  const totalExpenses = revenueData.reduce((sum, d) => sum + d.expenses, 0);

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card sticky top-0 z-50">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/dashboard">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Dashboard
              </Button>
            </Link>
            <div className="hidden sm:flex items-center gap-2">
              <Shield className="w-5 h-5 text-red-500" />
              <span className="font-orbitron font-bold text-sm text-foreground">Admin Panel</span>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <div className="w-2 h-2 rounded-full bg-accent-emerald animate-pulse" />
            {ADMIN_EMAIL}
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 max-w-7xl">
        {/* Title */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <h1 className="text-2xl font-orbitron font-bold text-foreground">Vue d'ensemble</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Toutes les données de PURAMA AI en temps réel
          </p>
        </motion.div>

        {/* Main stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {[
            {
              label: 'Revenus ce mois',
              value: `${currentMonthRevenue.toLocaleString('fr-FR')}€`,
              change: `${revenueGrowth > 0 ? '+' : ''}${revenueGrowth}%`,
              positive: revenueGrowth >= 0,
              icon: DollarSign,
              color: 'text-accent-emerald',
              bg: 'bg-accent-emerald/10'
            },
            {
              label: 'Utilisateurs',
              value: stats.totalUsers.toString(),
              change: '+12 cette semaine',
              positive: true,
              icon: Users,
              color: 'text-accent-cyan',
              bg: 'bg-accent-cyan/10'
            },
            {
              label: 'Abonnés payants',
              value: stats.totalSubscriptions.toString(),
              change: `${stats.totalUsers > 0 ? Math.round((stats.totalSubscriptions / stats.totalUsers) * 100) : 0}% conversion`,
              positive: true,
              icon: CreditCard,
              color: 'text-accent-purple',
              bg: 'bg-accent-purple/10'
            },
            {
              label: 'Dépenses ce mois',
              value: `${currentExpenses}€`,
              change: `Profit: ${profit}€`,
              positive: profit > 0,
              icon: TrendingUp,
              color: 'text-accent-pink',
              bg: 'bg-accent-pink/10'
            },
          ].map((stat, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.1 }}
            >
              <Card className="bg-card border-border">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className={`w-9 h-9 rounded-lg ${stat.bg} flex items-center justify-center`}>
                      <stat.icon className={`w-4 h-4 ${stat.color}`} />
                    </div>
                    <span className={`text-xs font-medium flex items-center gap-1 ${stat.positive ? 'text-accent-emerald' : 'text-red-400'}`}>
                      {stat.positive ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                      {stat.change}
                    </span>
                  </div>
                  <p className="text-2xl font-orbitron font-bold text-foreground">{stat.value}</p>
                  <p className="text-xs text-muted-foreground mt-1">{stat.label}</p>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>

        {/* Charts row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          {/* Revenue chart */}
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
            <Card className="bg-card border-border">
              <CardContent className="p-5">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="font-orbitron font-bold text-sm text-foreground">Revenus vs Dépenses</h3>
                  <span className="text-xs text-muted-foreground">12 derniers mois</span>
                </div>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={revenueData}>
                    <XAxis dataKey="month" stroke="var(--muted-foreground)" fontSize={11} />
                    <YAxis stroke="var(--muted-foreground)" fontSize={11} />
                    <Tooltip
                      contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '12px' }}
                      formatter={(value: number, name: string) => [`${value}€`, name === 'revenue' ? 'Revenus' : 'Dépenses']}
                    />
                    <Line type="monotone" dataKey="revenue" stroke="var(--accent-emerald)" strokeWidth={2.5} dot={false} />
                    <Line type="monotone" dataKey="expenses" stroke="var(--accent-pink)" strokeWidth={2} dot={false} strokeDasharray="5 5" />
                  </LineChart>
                </ResponsiveContainer>
                <div className="flex gap-6 mt-3 text-xs">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-0.5 bg-accent-emerald rounded" />
                    <span className="text-muted-foreground">Revenus total: <span className="text-foreground font-semibold">{totalRevenue.toLocaleString('fr-FR')}€</span></span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-0.5 bg-accent-pink rounded" style={{ borderStyle: 'dashed' }} />
                    <span className="text-muted-foreground">Dépenses total: <span className="text-foreground font-semibold">{totalExpenses.toLocaleString('fr-FR')}€</span></span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>

          {/* Traffic chart */}
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}>
            <Card className="bg-card border-border">
              <CardContent className="p-5">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="font-orbitron font-bold text-sm text-foreground">Trafic & Inscriptions</h3>
                  <span className="text-xs text-muted-foreground">Cette semaine</span>
                </div>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={trafficData}>
                    <XAxis dataKey="day" stroke="var(--muted-foreground)" fontSize={11} />
                    <YAxis stroke="var(--muted-foreground)" fontSize={11} />
                    <Tooltip
                      contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '12px' }}
                    />
                    <Bar dataKey="visitors" fill="var(--accent-cyan)" radius={[4, 4, 0, 0]} opacity={0.6} />
                    <Bar dataKey="signups" fill="var(--accent-purple)" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
                <div className="flex gap-6 mt-3 text-xs">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded bg-accent-cyan/60" />
                    <span className="text-muted-foreground">Visiteurs: <span className="text-foreground font-semibold">{trafficData.reduce((s, d) => s + d.visitors, 0)}</span></span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded bg-accent-purple" />
                    <span className="text-muted-foreground">Inscriptions: <span className="text-foreground font-semibold">{trafficData.reduce((s, d) => s + d.signups, 0)}</span></span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </div>

        {/* Bottom row */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Plan distribution */}
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }}>
            <Card className="bg-card border-border">
              <CardContent className="p-5">
                <h3 className="font-orbitron font-bold text-sm text-foreground mb-4">Répartition des plans</h3>
                <div className="flex items-center justify-center">
                  <ResponsiveContainer width={160} height={160}>
                    <PieChart>
                      <Pie
                        data={planDistribution}
                        cx="50%"
                        cy="50%"
                        innerRadius={45}
                        outerRadius={70}
                        dataKey="value"
                        strokeWidth={0}
                      >
                        {planDistribution.map((entry, i) => (
                          <Cell key={i} fill={entry.color} />
                        ))}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="space-y-2 mt-2">
                  {planDistribution.map((plan, i) => (
                    <div key={i} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full" style={{ background: plan.color }} />
                        <span className="text-foreground/80">{plan.name}</span>
                      </div>
                      <span className="text-foreground font-semibold">{plan.value}%</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </motion.div>

          {/* Recent users */}
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.6 }} className="lg:col-span-2">
            <Card className="bg-card border-border">
              <CardContent className="p-5">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="font-orbitron font-bold text-sm text-foreground">Derniers inscrits</h3>
                  <span className="text-xs text-muted-foreground">{stats.totalUsers} utilisateurs au total</span>
                </div>
                <div className="space-y-3">
                  {recentUsers.length === 0 && !loading && (
                    <p className="text-sm text-muted-foreground text-center py-4">Aucun utilisateur pour le moment</p>
                  )}
                  {loading && (
                    <div className="flex justify-center py-8">
                      <RefreshCw className="w-5 h-5 text-accent-cyan animate-spin" />
                    </div>
                  )}
                  {recentUsers.slice(0, 8).map((u, i) => (
                    <div key={i} className="flex items-center gap-3 py-2 border-b border-border/30 last:border-0">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-r from-accent-purple to-accent-cyan flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
                        {u.full_name?.[0]?.toUpperCase() || u.email?.[0]?.toUpperCase() || '?'}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{u.full_name || 'Sans nom'}</p>
                        <p className="text-xs text-muted-foreground truncate">{u.email}</p>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-xs text-muted-foreground">
                          {u.created_at ? new Date(u.created_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : '-'}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </div>

        {/* Financials summary */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.7 }}
          className="mt-8"
        >
          <Card className="bg-card border-border">
            <CardContent className="p-5">
              <h3 className="font-orbitron font-bold text-sm text-foreground mb-4">Résumé financier</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { label: 'Revenus totaux', value: `${totalRevenue.toLocaleString('fr-FR')}€`, color: 'text-accent-emerald' },
                  { label: 'Dépenses totales', value: `${totalExpenses.toLocaleString('fr-FR')}€`, color: 'text-accent-pink' },
                  { label: 'Bénéfice net', value: `${(totalRevenue - totalExpenses).toLocaleString('fr-FR')}€`, color: totalRevenue > totalExpenses ? 'text-accent-emerald' : 'text-red-400' },
                  { label: 'MRR estimé', value: `${currentMonthRevenue.toLocaleString('fr-FR')}€`, color: 'text-accent-cyan' },
                ].map((item, i) => (
                  <div key={i} className="text-center p-3 rounded-lg bg-secondary/20">
                    <p className="text-xs text-muted-foreground mb-1">{item.label}</p>
                    <p className={`text-xl font-orbitron font-bold ${item.color}`}>{item.value}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </main>
    </div>
  );
}
