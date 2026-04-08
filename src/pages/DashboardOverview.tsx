import { motion } from 'framer-motion';
import {
  Brain,
  Zap,
  ArrowRight,
  Settings,
  TrendingUp,
  Clock,
  BarChart3,
  Loader2,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useAgents } from '@/hooks/useAgents';
import { useAgentSelections } from '@/hooks/useAgentSelections';
import { useAgentStats } from '@/hooks/useAgentStats';
import { useSubscription } from '@/hooks/useSubscription';
import { Card, CardContent } from '@/components/ui/card';

const quickActions = [
  {
    icon: Brain,
    label: 'Mes Agents',
    description: 'Gérer vos agents actifs',
    to: '/dashboard/agents',
    color: 'text-accent-purple',
    bg: 'bg-accent-purple/10',
  },
  {
    icon: BarChart3,
    label: 'Analytics',
    description: 'Voir les performances',
    to: '/dashboard/analytics',
    color: 'text-accent-cyan',
    bg: 'bg-accent-cyan/10',
  },
  {
    icon: Settings,
    label: 'Paramètres',
    description: 'Configurer votre compte',
    to: '/dashboard/settings',
    color: 'text-accent-pink',
    bg: 'bg-accent-pink/10',
  },
];

export default function DashboardOverview() {
  const { user } = useAuth();
  const { data: profile } = useProfile();
  const { data: agents = [], isLoading: agentsLoading } = useAgents();
  const { selectedAgentIds, isLoading: selectionsLoading, maxSelections } =
    useAgentSelections();
  const { statsByAgent, totalThisMonth, isLoading: statsLoading } = useAgentStats();
  const { isStarter, isPremium } = useSubscription();

  const firstName = profile?.full_name?.split(' ')[0] || user?.email?.split('@')[0] || 'Utilisateur';

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Bonjour' : hour < 18 ? 'Bon après-midi' : 'Bonsoir';

  const isLoading = agentsLoading || selectionsLoading || statsLoading;

  // Selected agents (real)
  const myAgents = agents.filter((a) => selectedAgentIds.includes(a.id));
  const activeCount = myAgents.length;
  const planCap = isPremium ? agents.length : isStarter ? maxSelections : 0;

  // Time saved heuristic: each execution ≈ 5 min saved
  const timeSavedHours = Math.round((totalThisMonth * 5) / 60);

  const stats = [
    {
      label: 'Agents actifs',
      value: String(activeCount),
      icon: Brain,
      color: 'text-accent-purple',
      bg: 'bg-accent-purple/10',
      sub: planCap > 0 ? `sur ${planCap} disponibles` : 'aucun plan actif',
    },
    {
      label: 'Tâches ce mois',
      value: String(totalThisMonth),
      icon: Zap,
      color: 'text-accent-cyan',
      bg: 'bg-accent-cyan/10',
      sub: totalThisMonth === 0 ? 'aucune exécution' : 'exécutions enregistrées',
    },
    {
      label: 'Temps gagné',
      value: `${timeSavedHours}h`,
      icon: Clock,
      color: 'text-accent-emerald',
      bg: 'bg-accent-emerald/10',
      sub: 'estimé ce mois-ci',
    },
  ];

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      {/* Welcome */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4"
      >
        <div>
          <h1 className="text-2xl sm:text-3xl font-orbitron font-bold text-foreground">
            {greeting}, {firstName}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {new Date().toLocaleDateString('fr-FR', {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            })}
          </p>
        </div>
      </motion.div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {stats.map((stat, i) => (
          <motion.div
            key={stat.label}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.1 }}
          >
            <Card className="bg-card border-border hover:border-accent-cyan/20 transition-all">
              <CardContent className="p-5">
                <div className="flex items-center gap-3 mb-3">
                  <div
                    className={`w-10 h-10 rounded-xl ${stat.bg} flex items-center justify-center`}
                  >
                    <stat.icon className={`w-5 h-5 ${stat.color}`} />
                  </div>
                  <p className="text-sm text-muted-foreground">{stat.label}</p>
                </div>
                <p className="text-3xl font-orbitron font-bold text-foreground">
                  {isLoading ? <Loader2 className="w-6 h-6 animate-spin" /> : stat.value}
                </p>
                <p className="text-xs text-muted-foreground mt-1">{stat.sub}</p>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* Mes Agents */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
      >
        <div className="flex justify-between items-center mb-4">
          <h2 className="font-orbitron font-bold text-lg text-foreground">Mes Agents</h2>
          <Link
            to="/dashboard/agents"
            className="text-accent-cyan text-sm font-semibold hover:underline flex items-center gap-1"
          >
            Voir tout <ArrowRight className="w-3 h-3" />
          </Link>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        ) : myAgents.length === 0 ? (
          <Card className="bg-card border-border">
            <CardContent className="p-8 text-center">
              <Brain className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground mb-4">
                Aucun agent sélectionné pour le moment.
              </p>
              <Link
                to="/my-agents"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30 text-sm font-semibold hover:bg-accent-cyan/30 transition-colors"
              >
                Choisir mes agents <ArrowRight className="w-3 h-3" />
              </Link>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {myAgents.slice(0, 5).map((agent, i) => {
              const stat = statsByAgent.get(agent.id);
              return (
                <motion.div
                  key={agent.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.4 + i * 0.1 }}
                >
                  <Link to={`/dashboard/${agent.slug}`}>
                    <Card className="bg-card border-border hover:border-accent-cyan/20 transition-all cursor-pointer">
                      <CardContent className="p-4">
                        <div className="flex items-center gap-4">
                          <div
                            className="w-12 h-12 rounded-xl flex items-center justify-center text-xl flex-shrink-0"
                            style={{
                              backgroundColor: agent.color
                                ? `${agent.color}20`
                                : 'hsl(var(--primary) / 0.2)',
                            }}
                          >
                            {agent.icon || '🤖'}
                          </div>

                          <div className="flex-1 min-w-0">
                            <p className="font-semibold text-foreground text-sm">
                              {agent.name}
                            </p>
                            <p className="text-xs text-muted-foreground capitalize">
                              {agent.category}
                            </p>
                          </div>

                          <div className="text-right hidden sm:block">
                            <p className="text-sm font-semibold text-foreground">
                              {stat?.thisMonth ?? 0} ce mois
                            </p>
                            <p className="text-xs text-muted-foreground flex items-center justify-end gap-1">
                              <TrendingUp className="w-3 h-3" /> {stat?.total ?? 0} total
                            </p>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                </motion.div>
              );
            })}
          </div>
        )}
      </motion.div>

      {/* Actions rapides */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.6 }}
      >
        <h2 className="font-orbitron font-bold text-lg text-foreground mb-4">
          Actions rapides
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {quickActions.map((action) => (
            <Link key={action.to} to={action.to}>
              <Card className="bg-card border-border hover:border-accent-cyan/20 transition-all cursor-pointer group">
                <CardContent className="p-5 flex items-center gap-4">
                  <div
                    className={`w-10 h-10 rounded-xl ${action.bg} flex items-center justify-center group-hover:scale-110 transition-transform`}
                  >
                    <action.icon className={`w-5 h-5 ${action.color}`} />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">{action.label}</p>
                    <p className="text-xs text-muted-foreground">{action.description}</p>
                  </div>
                  <ArrowRight className="w-4 h-4 text-muted-foreground ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </motion.div>
    </div>
  );
}
