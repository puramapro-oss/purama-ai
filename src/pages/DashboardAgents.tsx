import { motion } from 'framer-motion';
import { Card, CardContent } from '@/components/ui/card';
import { Link } from 'react-router-dom';
import {
  Search,
  Zap,
  MessageSquare,
  BarChart3,
  Pencil,
  Loader2,
  Brain,
  Trash2,
} from 'lucide-react';
import { useState, useMemo } from 'react';
import { useAgents } from '@/hooks/useAgents';
import { useAgentSelections } from '@/hooks/useAgentSelections';
import { useAgentStats } from '@/hooks/useAgentStats';
import { useSubscription } from '@/hooks/useSubscription';

const formatRelative = (iso: string | null) => {
  if (!iso) return 'jamais';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "à l'instant";
  if (mins < 60) return `il y a ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.floor(hours / 24);
  return `il y a ${days} j`;
};

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

export default function DashboardAgents() {
  const [filter, setFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [search, setSearch] = useState('');

  const { data: allAgents = [], isLoading: agentsLoading } = useAgents();
  const {
    selectedAgentIds,
    isLoading: selectionsLoading,
    maxSelections,
    removeAgent,
  } = useAgentSelections();
  const { statsByAgent, isLoading: statsLoading } = useAgentStats();
  const { isPro, isUltime, isStarter } = useSubscription();

  const isLoading = agentsLoading || selectionsLoading || statsLoading;

  const myAgents = useMemo(
    () => allAgents.filter((a) => selectedAgentIds.includes(a.id)),
    [allAgents, selectedAgentIds],
  );

  const filtered = useMemo(() => {
    return myAgents.filter((a) => {
      const stat = statsByAgent.get(a.id);
      const isActive = (stat?.total ?? 0) > 0;
      if (filter === 'active' && !isActive) return false;
      if (filter === 'inactive' && isActive) return false;
      if (search && !a.name.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [myAgents, statsByAgent, filter, search]);

  const planCap = isPro || isUltime ? allAgents.length : isStarter ? maxSelections : 0;

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-orbitron font-bold text-foreground">Mes Agents IA</h1>
          <p className="text-muted-foreground text-sm">
            {myAgents.length} agent{myAgents.length > 1 ? 's' : ''} sélectionné
            {myAgents.length > 1 ? 's' : ''} sur {planCap} disponibles
          </p>
        </div>
        <Link
          to="/my-agents"
          className="btn-primary flex items-center gap-2 text-sm px-4 py-2.5"
        >
          <Zap className="w-4 h-4" /> Choisir des agents
        </Link>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex gap-2">
          {[
            { label: 'Tous', value: 'all' as const },
            { label: 'Utilisés', value: 'active' as const },
            { label: 'Inactifs', value: 'inactive' as const },
          ].map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                filter === f.value
                  ? 'bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30'
                  : 'bg-secondary/50 text-muted-foreground'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher un agent..."
            className="w-full pl-9 pr-3 py-2 bg-secondary/50 border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:border-accent-cyan/50"
          />
        </div>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Empty */}
      {!isLoading && myAgents.length === 0 && (
        <Card className="bg-card border-border">
          <CardContent className="p-10 text-center">
            <Brain className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="font-orbitron font-bold text-foreground mb-2">
              Aucun agent sélectionné
            </h3>
            <p className="text-sm text-muted-foreground mb-5">
              Choisissez vos agents pour commencer à les utiliser.
            </p>
            <Link
              to="/my-agents"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30 text-sm font-semibold"
            >
              <Zap className="w-4 h-4" /> Sélectionner mes agents
            </Link>
          </CardContent>
        </Card>
      )}

      {/* Agent cards */}
      {!isLoading && filtered.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {filtered.map((agent, i) => {
            const stat = statsByAgent.get(agent.id);
            const isActive = (stat?.total ?? 0) > 0;
            const features = Array.isArray(agent.features)
              ? (agent.features as string[])
              : [];

            return (
              <motion.div
                key={agent.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i * 0.05, 0.4) }}
              >
                <Card className="bg-card border-border hover:border-accent-cyan/30 transition-all">
                  <CardContent className="p-5">
                    {/* Header */}
                    <div className="flex items-center gap-3 mb-4">
                      <div
                        className={`w-14 h-14 rounded-full flex items-center justify-center text-xl font-bold ${
                          isActive
                            ? 'ring-2 ring-accent-emerald ring-offset-2 ring-offset-card'
                            : 'ring-2 ring-yellow-500 ring-offset-2 ring-offset-card'
                        }`}
                        style={{
                          backgroundColor: agent.color
                            ? `${agent.color}30`
                            : 'hsl(var(--primary) / 0.2)',
                        }}
                      >
                        {agent.icon || agent.name[0]}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-orbitron font-bold text-foreground truncate">
                          {agent.name}
                        </p>
                        <p className="text-xs text-muted-foreground capitalize">
                          {agent.category}
                        </p>
                      </div>
                      <span
                        className={`text-xs font-medium ${
                          isActive ? 'text-accent-emerald' : 'text-yellow-500'
                        }`}
                      >
                        {isActive ? '🟢 Actif' : '🟠 Jamais utilisé'}
                      </span>
                    </div>

                    {/* Stats */}
                    <div className="grid grid-cols-3 gap-3 mb-4">
                      <div className="text-center">
                        <p className="text-sm font-semibold text-foreground">
                          {stat?.total ?? 0}
                        </p>
                        <p className="text-[10px] text-muted-foreground">Total</p>
                      </div>
                      <div className="text-center">
                        <p className="text-sm font-semibold text-foreground">
                          {stat?.thisMonth ?? 0}
                        </p>
                        <p className="text-[10px] text-muted-foreground">Ce mois</p>
                      </div>
                      <div className="text-center">
                        <p className="text-sm font-semibold text-foreground">
                          {agent.is_premium ? 'Premium' : 'Inclus'}
                        </p>
                        <p className="text-[10px] text-muted-foreground">Plan</p>
                      </div>
                    </div>

                    {/* Description */}
                    {agent.description && (
                      <p className="text-xs text-muted-foreground/80 mb-4 line-clamp-2">
                        {agent.description}
                      </p>
                    )}

                    {/* Features */}
                    {features.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mb-4">
                        {features.slice(0, 4).map((s) => (
                          <span
                            key={s}
                            className="px-2 py-0.5 rounded text-[11px] bg-accent-purple/10 text-accent-purple border border-accent-purple/20"
                          >
                            {s}
                          </span>
                        ))}
                        {features.length > 4 && (
                          <span className="px-2 py-0.5 rounded text-[11px] text-muted-foreground">
                            +{features.length - 4} autres
                          </span>
                        )}
                      </div>
                    )}

                    {/* Actions */}
                    <div className="flex flex-wrap gap-2 mb-3">
                      <Link
                        to={`/dashboard/${agent.slug}`}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs bg-secondary/50 text-foreground/80 hover:bg-secondary transition-colors"
                      >
                        <MessageSquare className="w-3 h-3" /> Utiliser
                      </Link>
                      <Link
                        to="/dashboard/analytics"
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs bg-secondary/50 text-foreground/80 hover:bg-secondary transition-colors"
                      >
                        <BarChart3 className="w-3 h-3" /> Analytics
                      </Link>
                      <Link
                        to="/my-agents"
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs bg-secondary/50 text-foreground/80 hover:bg-secondary transition-colors"
                      >
                        <Pencil className="w-3 h-3" /> Gérer
                      </Link>
                      <button
                        onClick={() => removeAgent(agent.id)}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
                      >
                        <Trash2 className="w-3 h-3" /> Retirer
                      </button>
                    </div>

                    {/* Footer */}
                    <div className="flex justify-between items-center text-[11px] text-muted-foreground pt-3 border-t border-border/50">
                      <span>Créé le {formatDate(agent.created_at)}</span>
                      <span>Dernière utilisation : {formatRelative(stat?.lastUsedAt ?? null)}</span>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            );
          })}
        </div>
      )}

      {/* No results */}
      {!isLoading && myAgents.length > 0 && filtered.length === 0 && (
        <Card className="bg-card border-border">
          <CardContent className="p-8 text-center">
            <p className="text-sm text-muted-foreground">
              Aucun agent ne correspond à votre recherche.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
