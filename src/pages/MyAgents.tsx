import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { 
  ArrowLeft, 
  Check, 
  Crown, 
  Loader2, 
  Plus, 
  Trash2,
  Zap,
  Search
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { useAgents } from '@/hooks/useAgents';
import { useAgentSelections } from '@/hooks/useAgentSelections';
import { useSubscription } from '@/hooks/useSubscription';

export default function MyAgents() {
  const navigate = useNavigate();
  const { data: agents = [], isLoading: agentsLoading } = useAgents();
  const { 
    selectedAgentIds, 
    addAgent, 
    removeAgent, 
    isLoading: selectionsLoading,
    remainingSlots,
    maxSelections
  } = useAgentSelections();
  const { isStarter, isPremium, isLoading: subLoading } = useSubscription();
  const [search, setSearch] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const isLoading = agentsLoading || selectionsLoading || subLoading;

  // Filter agents by search
  const filteredAgents = agents.filter(agent => 
    agent.name.toLowerCase().includes(search.toLowerCase()) ||
    agent.category.toLowerCase().includes(search.toLowerCase())
  );

  // Separate selected and available agents
  const selectedAgents = filteredAgents.filter(a => selectedAgentIds.includes(a.id));
  const availableAgents = filteredAgents.filter(a => !selectedAgentIds.includes(a.id));

  const handleAdd = async (agentId: string) => {
    setActionLoading(agentId);
    await addAgent(agentId);
    setActionLoading(null);
  };

  const handleRemove = async (agentId: string) => {
    setActionLoading(agentId);
    await removeAgent(agentId);
    setActionLoading(null);
  };

  // If user is Premium, redirect to dashboard
  if (!subLoading && isPremium) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <Crown className="w-16 h-16 text-amber-500 mx-auto mb-4" />
          <h1 className="text-2xl font-bold mb-2">Vous êtes Premium</h1>
          <p className="text-muted-foreground mb-6">
            Vous avez accès à tous les 45 agents !
          </p>
          <Button onClick={() => navigate('/dashboard')}>
            Aller au Dashboard
          </Button>
        </div>
      </div>
    );
  }

  // If user has no subscription
  if (!subLoading && !isStarter && !isPremium) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center max-w-md">
          <Zap className="w-16 h-16 text-primary mx-auto mb-4" />
          <h1 className="text-2xl font-bold mb-2">Abonnement requis</h1>
          <p className="text-muted-foreground mb-6">
            Souscrivez à un abonnement pour accéder aux agents IA.
          </p>
          <Button onClick={() => navigate('/pricing')} className="bg-gradient-to-r from-primary to-accent">
            Voir les plans
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-background/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <Link to="/dashboard">
            <Button variant="ghost">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Retour au Dashboard
            </Button>
          </Link>
          <Badge variant="outline" className="text-sm">
            {remainingSlots} place{remainingSlots !== 1 ? 's' : ''} restante{remainingSlots !== 1 ? 's' : ''}
          </Badge>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <h1 className="text-3xl font-bold mb-2">Mes Agents</h1>
          <p className="text-muted-foreground">
            Sélectionnez {maxSelections} agents parmi les 45 disponibles.
            <Link to="/pricing" className="text-primary hover:underline ml-2">
              Passez au Premium pour tous les débloquer →
            </Link>
          </p>
        </motion.div>

        {/* Search */}
        <div className="relative mb-8 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Rechercher un agent..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : (
          <>
            {/* Selected Agents */}
            <section className="mb-12">
              <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
                <Check className="w-5 h-5 text-green-500" />
                Agents sélectionnés ({selectedAgents.length}/{maxSelections})
              </h2>
              
              {selectedAgents.length === 0 ? (
                <div className="futuristic-card p-8 text-center text-muted-foreground">
                  Aucun agent sélectionné. Choisissez {maxSelections} agents ci-dessous.
                </div>
              ) : (
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {selectedAgents.map((agent) => (
                    <motion.div
                      key={agent.id}
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="futuristic-card p-4 ring-2 ring-green-500/50"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-3">
                          <div
                            className="w-10 h-10 rounded-lg flex items-center justify-center text-xl"
                            style={{ backgroundColor: agent.color ? `${agent.color}20` : 'hsl(var(--primary) / 0.2)' }}
                          >
                            {agent.icon}
                          </div>
                          <div>
                            <h3 className="font-medium">{agent.name}</h3>
                            <p className="text-xs text-muted-foreground capitalize">{agent.category}</p>
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleRemove(agent.id)}
                          disabled={actionLoading === agent.id}
                          className="text-destructive hover:text-destructive hover:bg-destructive/10"
                        >
                          {actionLoading === agent.id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Trash2 className="w-4 h-4" />
                          )}
                        </Button>
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}
            </section>

            {/* Available Agents */}
            <section>
              <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
                <Plus className="w-5 h-5" />
                Agents disponibles ({availableAgents.length})
              </h2>
              
              <div className="grid md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {availableAgents.map((agent) => (
                  <motion.div
                    key={agent.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="futuristic-card p-4 hover:ring-1 hover:ring-primary/50 transition-all"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div
                          className="w-10 h-10 rounded-lg flex items-center justify-center text-xl"
                          style={{ backgroundColor: agent.color ? `${agent.color}20` : 'hsl(var(--primary) / 0.2)' }}
                        >
                          {agent.icon}
                        </div>
                        <div>
                          <h3 className="font-medium text-sm">{agent.name}</h3>
                          <p className="text-xs text-muted-foreground capitalize">{agent.category}</p>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleAdd(agent.id)}
                        disabled={actionLoading === agent.id || remainingSlots === 0}
                        className="text-primary hover:text-primary hover:bg-primary/10"
                      >
                        {actionLoading === agent.id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Plus className="w-4 h-4" />
                        )}
                      </Button>
                    </div>
                  </motion.div>
                ))}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
