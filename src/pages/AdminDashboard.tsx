import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Link, useNavigate } from 'react-router-dom';
import {
  Users, DollarSign, ArrowLeft, Bot, CreditCard, RefreshCw, Shield,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { unavailableLiveDataLabel } from '@/lib/presentationSafety';

const ADMIN_EMAIL = 'matiss.frasne@gmail.com';

export default function AdminDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [stats, setStats] = useState({
    totalUsers: 0,
    totalSubscriptions: 0,
    activeAgents: 0,
  });
  const [recentUsers, setRecentUsers] = useState<Array<{ id: string; email?: string | null; full_name?: string | null; created_at?: string }>>([]);
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
            Les métriques ci-dessous proviennent uniquement des sources réellement connectées.
          </p>
        </motion.div>

        {/* Main stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {[
            {
              label: 'Utilisateurs',
              value: stats.totalUsers.toString(),
              detail: 'Valeur Supabase',
              icon: Users,
              color: 'text-accent-cyan',
              bg: 'bg-accent-cyan/10'
            },
            {
              label: 'Abonnés payants',
              value: stats.totalSubscriptions.toString(),
              detail: `${stats.totalUsers > 0 ? Math.round((stats.totalSubscriptions / stats.totalUsers) * 100) : 0}% des utilisateurs`,
              icon: CreditCard,
              color: 'text-accent-purple',
              bg: 'bg-accent-purple/10'
            },
            {
              label: 'Agents actifs',
              value: stats.activeAgents.toString(),
              detail: 'Valeur Supabase',
              icon: Bot,
              color: 'text-accent-emerald',
              bg: 'bg-accent-emerald/10'
            },
            {
              label: 'Revenus',
              value: '—',
              detail: unavailableLiveDataLabel('Stripe'),
              icon: DollarSign,
              color: 'text-muted-foreground',
              bg: 'bg-secondary/50'
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
                  </div>
                  <p className="text-2xl font-orbitron font-bold text-foreground">{stat.value}</p>
                  <p className="text-xs text-muted-foreground mt-1">{stat.label}</p>
                  <p className="text-[10px] text-muted-foreground/70 mt-1">{stat.detail}</p>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>

        {/* Sources not connected: never substitute sample values for live metrics. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
            <Card className="bg-card border-border">
              <CardContent className="p-5 min-h-[220px] flex flex-col items-center justify-center text-center">
                <DollarSign className="w-8 h-8 text-muted-foreground mb-3" />
                <h3 className="font-orbitron font-bold text-sm text-foreground">Revenus et dépenses</h3>
                <p className="text-sm text-muted-foreground mt-2">{unavailableLiveDataLabel('Stripe')}</p>
              </CardContent>
            </Card>
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}>
            <Card className="bg-card border-border">
              <CardContent className="p-5 min-h-[220px] flex flex-col items-center justify-center text-center">
                <Users className="w-8 h-8 text-muted-foreground mb-3" />
                <h3 className="font-orbitron font-bold text-sm text-foreground">Trafic et inscriptions</h3>
                <p className="text-sm text-muted-foreground mt-2">{unavailableLiveDataLabel('analytics')}</p>
              </CardContent>
            </Card>
          </motion.div>
        </div>

        {/* Bottom row */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Plan distribution is unavailable until a billing source is connected. */}
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }}>
            <Card className="bg-card border-border">
              <CardContent className="p-5 min-h-[260px] flex flex-col items-center justify-center text-center">
                <CreditCard className="w-8 h-8 text-muted-foreground mb-3" />
                <h3 className="font-orbitron font-bold text-sm text-foreground mb-4">Répartition des plans</h3>
                <p className="text-sm text-muted-foreground">{unavailableLiveDataLabel('Stripe')}</p>
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

      </main>
    </div>
  );
}
