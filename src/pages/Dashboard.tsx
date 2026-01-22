import { useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { AgentCard } from '@/components/dashboard/AgentCard';
import { AgentFilters } from '@/components/dashboard/AgentFilters';
import { useAgents, useAgentCategories, Agent } from '@/hooks/useAgents';
import { useSubscription } from '@/hooks/useProfile';
import { toast } from 'sonner';
import { Loader2, Bot, AlertCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

export default function Dashboard() {
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  const { data: agents, isLoading: agentsLoading, error: agentsError } = useAgents();
  const { data: categories = [] } = useAgentCategories();
  const { data: subscription } = useSubscription();

  const isPremium = subscription?.plan_type !== 'free';

  // Filter agents based on category and search
  const filteredAgents = useMemo(() => {
    if (!agents) return [];

    return agents.filter((agent) => {
      const matchesCategory = selectedCategory === 'all' || agent.category === selectedCategory;
      const matchesSearch = 
        !searchQuery ||
        agent.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        agent.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        agent.category.toLowerCase().includes(searchQuery.toLowerCase());

      return matchesCategory && matchesSearch;
    });
  }, [agents, selectedCategory, searchQuery]);

  const handleUseAgent = (agent: Agent) => {
    if (agent.is_premium && !isPremium) {
      toast.error('Agent Premium', {
        description: 'Passez au plan Premium pour utiliser cet agent.',
      });
      return;
    }

    toast.success(`Agent "${agent.name}" activé !`, {
      description: 'Vous pouvez maintenant l\'utiliser.',
    });
  };

  return (
    <div className="min-h-screen bg-background">
      <DashboardHeader />

      <main className="container mx-auto px-4 py-8">
        {/* Page header */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <h1 className="text-3xl font-bold gradient-text-cyan-purple mb-2">
            Mes Agents IA
          </h1>
          <p className="text-muted-foreground">
            {agents?.length || 0} agents disponibles pour automatiser votre business
          </p>
        </motion.div>

        {/* Filters */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="mb-8"
        >
          <AgentFilters
            categories={categories}
            selectedCategory={selectedCategory}
            onCategoryChange={setSelectedCategory}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
          />
        </motion.div>

        {/* Loading state */}
        {agentsLoading && (
          <div className="flex flex-col items-center justify-center py-20">
            <Loader2 className="w-12 h-12 text-primary animate-spin mb-4" />
            <p className="text-muted-foreground">Chargement des agents...</p>
          </div>
        )}

        {/* Error state */}
        {agentsError && (
          <Alert variant="destructive" className="mb-8">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Erreur</AlertTitle>
            <AlertDescription>
              Impossible de charger les agents. Veuillez réessayer.
            </AlertDescription>
          </Alert>
        )}

        {/* Empty state */}
        {!agentsLoading && !agentsError && filteredAgents.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20">
            <Bot className="w-16 h-16 text-muted-foreground mb-4" />
            <h3 className="text-xl font-semibold mb-2">Aucun agent trouvé</h3>
            <p className="text-muted-foreground text-center max-w-md">
              {searchQuery
                ? `Aucun agent ne correspond à "${searchQuery}"`
                : 'Aucun agent disponible dans cette catégorie'}
            </p>
          </div>
        )}

        {/* Agents grid */}
        {!agentsLoading && !agentsError && filteredAgents.length > 0 && (
          <div
            className={
              viewMode === 'grid'
                ? 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6'
                : 'flex flex-col gap-4'
            }
          >
            {filteredAgents.map((agent, index) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                index={index}
                onUse={handleUseAgent}
              />
            ))}
          </div>
        )}

        {/* Stats footer */}
        {!agentsLoading && agents && agents.length > 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5 }}
            className="mt-12 text-center text-muted-foreground text-sm"
          >
            Affichage de {filteredAgents.length} sur {agents.length} agents
          </motion.div>
        )}
      </main>
    </div>
  );
}
