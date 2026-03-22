import { motion } from 'framer-motion';
import { Brain, MessageSquare, Zap, ArrowRight, Play, Pause, Settings, TrendingUp, Clock, Sparkles, BarChart3 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { Card, CardContent } from '@/components/ui/card';

const quickActions = [
  { icon: Brain, label: 'Mes Agents', description: 'Gérer vos agents actifs', to: '/dashboard/agents', color: 'text-accent-purple', bg: 'bg-accent-purple/10' },
  { icon: BarChart3, label: 'Analytics', description: 'Voir les performances', to: '/dashboard/analytics', color: 'text-accent-cyan', bg: 'bg-accent-cyan/10' },
  { icon: Settings, label: 'Paramètres', description: 'Configurer votre compte', to: '/dashboard/settings', color: 'text-accent-pink', bg: 'bg-accent-pink/10' },
];

const myAgents = [
  { name: 'ShopAssist', category: 'E-Commerce', status: 'active', icon: '🛍️', tasks: 342, trend: '+12%' },
  { name: 'LegalBot', category: 'Juridique', status: 'active', icon: '⚖️', tasks: 156, trend: '+8%' },
  { name: 'SupportPro', category: 'Support', status: 'paused', icon: '🎧', tasks: 0, trend: '-' },
];

export default function DashboardOverview() {
  const { user } = useAuth();
  const { data: profile } = useProfile();
  const firstName = profile?.full_name?.split(' ')[0] || 'Utilisateur';

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Bonjour' : hour < 18 ? 'Bon après-midi' : 'Bonsoir';

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
            {new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
        </div>
      </motion.div>

      {/* Stats simples - 3 cartes */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { label: 'Agents actifs', value: '2', icon: Brain, color: 'text-accent-purple', bg: 'bg-accent-purple/10', sub: 'sur 5 disponibles' },
          { label: 'Tâches ce mois', value: '498', icon: Zap, color: 'text-accent-cyan', bg: 'bg-accent-cyan/10', sub: '+23% vs mois dernier' },
          { label: 'Temps gagné', value: '38h', icon: Clock, color: 'text-accent-emerald', bg: 'bg-accent-emerald/10', sub: 'ce mois-ci' },
        ].map((stat, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.1 }}
          >
            <Card className="bg-card border-border hover:border-accent-cyan/20 transition-all">
              <CardContent className="p-5">
                <div className="flex items-center gap-3 mb-3">
                  <div className={`w-10 h-10 rounded-xl ${stat.bg} flex items-center justify-center`}>
                    <stat.icon className={`w-5 h-5 ${stat.color}`} />
                  </div>
                  <p className="text-sm text-muted-foreground">{stat.label}</p>
                </div>
                <p className="text-3xl font-orbitron font-bold text-foreground">{stat.value}</p>
                <p className="text-xs text-muted-foreground mt-1">{stat.sub}</p>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* Mes Agents - Ultra simple */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
      >
        <div className="flex justify-between items-center mb-4">
          <h2 className="font-orbitron font-bold text-lg text-foreground">Mes Agents</h2>
          <Link to="/dashboard/agents" className="text-accent-cyan text-sm font-semibold hover:underline flex items-center gap-1">
            Voir tout <ArrowRight className="w-3 h-3" />
          </Link>
        </div>

        <div className="space-y-3">
          {myAgents.map((agent, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.4 + i * 0.1 }}
            >
              <Card className="bg-card border-border hover:border-accent-cyan/20 transition-all cursor-pointer">
                <CardContent className="p-4">
                  <div className="flex items-center gap-4">
                    {/* Icon */}
                    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-accent-purple/20 to-accent-cyan/20 flex items-center justify-center text-xl flex-shrink-0">
                      {agent.icon}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-foreground text-sm">{agent.name}</p>
                        <span className={`w-2 h-2 rounded-full ${agent.status === 'active' ? 'bg-accent-emerald' : 'bg-yellow-500'}`} />
                      </div>
                      <p className="text-xs text-muted-foreground">{agent.category}</p>
                    </div>

                    {/* Stats */}
                    <div className="text-right hidden sm:block">
                      <p className="text-sm font-semibold text-foreground">{agent.tasks} tâches</p>
                      {agent.trend !== '-' && (
                        <p className="text-xs text-accent-emerald flex items-center justify-end gap-1">
                          <TrendingUp className="w-3 h-3" /> {agent.trend}
                        </p>
                      )}
                    </div>

                    {/* Status */}
                    <div className="flex-shrink-0">
                      {agent.status === 'active' ? (
                        <div className="w-8 h-8 rounded-full bg-accent-emerald/10 flex items-center justify-center">
                          <Play className="w-3.5 h-3.5 text-accent-emerald fill-accent-emerald" />
                        </div>
                      ) : (
                        <div className="w-8 h-8 rounded-full bg-yellow-500/10 flex items-center justify-center">
                          <Pause className="w-3.5 h-3.5 text-yellow-500" />
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      </motion.div>

      {/* Actions rapides */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.6 }}
      >
        <h2 className="font-orbitron font-bold text-lg text-foreground mb-4">Actions rapides</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {quickActions.map((action, i) => (
            <Link key={i} to={action.to}>
              <Card className="bg-card border-border hover:border-accent-cyan/20 transition-all cursor-pointer group">
                <CardContent className="p-5 flex items-center gap-4">
                  <div className={`w-10 h-10 rounded-xl ${action.bg} flex items-center justify-center group-hover:scale-110 transition-transform`}>
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
