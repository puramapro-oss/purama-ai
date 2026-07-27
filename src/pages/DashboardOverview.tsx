import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
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
  Wallet,
  Star,
  Gift,
  BookOpen,
  Share2,
  ExternalLink,
  Sparkles,
  Coins,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useAgents } from '@/hooks/useAgents';
import { useAgentSelections } from '@/hooks/useAgentSelections';
import { useAgentStats } from '@/hooks/useAgentStats';
import { useSubscription } from '@/hooks/useSubscription';
import { getUsageSnapshot } from '@/lib/usage';
import { useWallet } from '@/hooks/useWallet';
import { usePoints } from '@/hooks/usePoints';
import { useTodaysGift } from '@/hooks/useDailyGift';
import { useCrossPromos } from '@/hooks/useFaq';
import { useHasAnyEmployeeHired } from '@/hooks/useKartaEmployees';
import { HireFirstEmployeeModal } from '@/components/onboarding/HireFirstEmployeeModal';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

const quickActions = [
  { icon: Brain, label: 'Mes Agents', description: 'Gérer vos agents actifs', to: '/dashboard/agents', color: 'text-accent-purple', bg: 'bg-accent-purple/10' },
  { icon: Wallet, label: 'Wallet', description: 'Voir tes gains', to: '/dashboard/wallet', color: 'text-green-400', bg: 'bg-green-500/10' },
  { icon: Star, label: 'Points & Boutique', description: 'Échanger tes points', to: '/dashboard/boutique', color: 'text-yellow-400', bg: 'bg-yellow-500/10' },
  { icon: Gift, label: 'Coffre du jour', description: 'Ouvre ton coffre', to: '/dashboard/daily-gift', color: 'text-orange-400', bg: 'bg-orange-500/10' },
  { icon: Share2, label: 'Parrainage', description: 'Invite et gagne', to: '/parrainage', color: 'text-accent-pink', bg: 'bg-accent-pink/10' },
  { icon: BookOpen, label: 'Guide', description: 'Apprendre Purama AI', to: '/dashboard/guide', color: 'text-accent-cyan', bg: 'bg-accent-cyan/10' },
];

export default function DashboardOverview() {
  const [hireModalOpen, setHireModalOpen] = useState(false);
  const { user } = useAuth();
  const { data: profile } = useProfile();
  const { data: hasHiredEmployee, isLoading: hiredLoading } = useHasAnyEmployeeHired();
  const { data: agents = [], isLoading: agentsLoading } = useAgents();
  const { selectedAgentIds, isLoading: selectionsLoading, maxSelections } =
    useAgentSelections();
  const { statsByAgent, isLoading: statsLoading } = useAgentStats();
  const { isStarter, isPro, isUltime } = useSubscription();
  const { data: usage } = useQuery({
    queryKey: ['usage-snapshot', user?.id],
    enabled: !!user,
    queryFn: () => getUsageSnapshot(user!.id, user!.email),
    refetchInterval: 60_000,
  });
  const { data: wallet } = useWallet();
  const { data: points } = usePoints();
  const { data: todaysGift } = useTodaysGift();
  const { data: crossPromos = [] } = useCrossPromos();

  const firstName = profile?.full_name?.split(' ')[0] || user?.email?.split('@')[0] || 'Utilisateur';
  const walletBalance = Number(wallet?.balance || 0);
  const pointsBalance = points?.balance || 0;
  const giftAvailable = !todaysGift;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Bonjour' : hour < 18 ? 'Bon après-midi' : 'Bonsoir';

  const isLoading = agentsLoading || selectionsLoading || statsLoading;

  // Selected agents (real)
  const myAgents = agents.filter((a) => selectedAgentIds.includes(a.id));
  const activeCount = myAgents.length;
  const planCap = isPro || isUltime ? agents.length : isStarter ? maxSelections : 0;

  // used/hours_saved/money_recovered viennent de getUsageSnapshot (1 source de vérité, cf ERRORS.md
  // 2026-07-27) — inclut désormais karta_runs + agent_usage marketplace, plus l'historique legacy.
  const actionsThisMonth = usage?.used ?? 0;
  const timeSavedHours = usage?.hours_saved ?? 0;
  const moneyRecovered = usage?.money_recovered ?? 0;

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
      label: 'Actions ce mois',
      value: String(actionsThisMonth),
      icon: Zap,
      color: 'text-accent-cyan',
      bg: 'bg-accent-cyan/10',
      sub: actionsThisMonth === 0 ? 'aucune action' : 'actions enregistrées',
    },
    {
      label: 'Temps gagné',
      value: `${timeSavedHours}h`,
      icon: Clock,
      color: 'text-accent-emerald',
      bg: 'bg-accent-emerald/10',
      sub: 'estimé ce mois-ci',
    },
    {
      label: '€ récupérés',
      value: `${moneyRecovered.toLocaleString('fr-FR', { maximumFractionDigits: 0 })}€`,
      icon: Coins,
      color: 'text-amber-400',
      bg: 'bg-amber-500/10',
      sub: 'factures payées ce mois',
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

      {/* Onboarding : Embauche ton 1er employé IA */}
      {!hiredLoading && !hasHiredEmployee && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <Card className="bg-gradient-to-r from-accent-cyan/10 to-accent-purple/10 border-accent-cyan/30">
            <CardContent className="p-5 flex flex-col sm:flex-row items-start sm:items-center gap-4 justify-between">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-accent-cyan/20 flex items-center justify-center flex-shrink-0">
                  <Sparkles className="w-5 h-5 text-accent-cyan" />
                </div>
                <div>
                  <p className="font-orbitron font-bold text-foreground text-sm">
                    Embauche ton premier employé IA
                  </p>
                  <p className="text-xs text-muted-foreground">
                    2 minutes, 0 connexion requise — il travaille sous tes yeux dès l'activation.
                  </p>
                </div>
              </div>
              <button
                onClick={() => setHireModalOpen(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent-cyan text-background text-sm font-semibold hover:opacity-90 transition-opacity flex-shrink-0"
              >
                Commencer <ArrowRight className="w-4 h-4" />
              </button>
            </CardContent>
          </Card>
        </motion.div>
      )}
      <HireFirstEmployeeModal open={hireModalOpen} onOpenChange={setHireModalOpen} />

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
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

      {/* Wallet + Points + Gift quick bar */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5 }}
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Link to="/dashboard/wallet">
            <Card className="bg-card border-border hover:border-green-500/20 transition-all cursor-pointer">
              <CardContent className="p-4 flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-green-500/10 flex items-center justify-center">
                  <Wallet className="w-5 h-5 text-green-400" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Wallet</p>
                  <p className="text-lg font-bold font-orbitron text-green-400">{walletBalance.toFixed(2)}€</p>
                </div>
              </CardContent>
            </Card>
          </Link>
          <Link to="/dashboard/boutique">
            <Card className="bg-card border-border hover:border-yellow-500/20 transition-all cursor-pointer">
              <CardContent className="p-4 flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-yellow-500/10 flex items-center justify-center">
                  <Star className="w-5 h-5 text-yellow-400" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Points</p>
                  <p className="text-lg font-bold font-orbitron text-yellow-400">{pointsBalance.toLocaleString('fr-FR')}</p>
                </div>
              </CardContent>
            </Card>
          </Link>
          <Link to="/dashboard/daily-gift">
            <Card className={`bg-card border-border transition-all cursor-pointer ${giftAvailable ? 'hover:border-orange-500/20 animate-pulse' : 'hover:border-border'}`}>
              <CardContent className="p-4 flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-orange-500/10 flex items-center justify-center">
                  <Gift className="w-5 h-5 text-orange-400" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Coffre du jour</p>
                  <p className={`text-sm font-semibold ${giftAvailable ? 'text-orange-400' : 'text-muted-foreground'}`}>
                    {giftAvailable ? 'Disponible !' : 'Déjà ouvert'}
                  </p>
                </div>
                {giftAvailable && <Badge className="bg-orange-500/20 text-orange-400 ml-auto">Nouveau</Badge>}
              </CardContent>
            </Card>
          </Link>
        </div>
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
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          {quickActions.map((action) => (
            <Link key={action.to} to={action.to}>
              <Card className="bg-card border-border hover:border-accent-cyan/20 transition-all cursor-pointer group">
                <CardContent className="p-4 flex items-center gap-3">
                  <div
                    className={`w-9 h-9 rounded-xl ${action.bg} flex items-center justify-center group-hover:scale-110 transition-transform`}
                  >
                    <action.icon className={`w-4 h-4 ${action.color}`} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground truncate">{action.label}</p>
                    <p className="text-xs text-muted-foreground truncate">{action.description}</p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </motion.div>

      {/* Cross-promo */}
      {crossPromos.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.8 }}
        >
          <h2 className="font-orbitron font-bold text-lg text-foreground mb-4">
            Découvre l'écosystème Purama
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {crossPromos.slice(0, 2).map((promo) => (
              <a key={promo.id} href={promo.target_url} target="_blank" rel="noopener noreferrer">
                <Card className="bg-card border-border hover:border-white/10 transition-all cursor-pointer group">
                  <CardContent className="p-5 flex items-center gap-4">
                    <div
                      className="w-12 h-12 rounded-xl flex items-center justify-center font-orbitron font-bold text-lg shrink-0"
                      style={{ backgroundColor: `${promo.target_color}20`, color: promo.target_color || 'var(--accent-cyan)' }}
                    >
                      {promo.target_name?.[0]}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-foreground">{promo.target_name}</p>
                      <p className="text-xs text-muted-foreground truncate">{promo.target_description}</p>
                    </div>
                    <div className="shrink-0 flex flex-col items-end gap-1">
                      <Badge className="bg-green-500/20 text-green-400 text-xs">-50% CROSS50</Badge>
                      <ExternalLink className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                  </CardContent>
                </Card>
              </a>
            ))}
          </div>
        </motion.div>
      )}
    </div>
  );
}
