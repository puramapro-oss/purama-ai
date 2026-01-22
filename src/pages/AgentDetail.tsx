import { useParams, useNavigate, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { 
  ArrowLeft, 
  Zap, 
  Crown, 
  CheckCircle2, 
  Clock, 
  Star,
  Loader2,
  AlertCircle,
  Sparkles,
  Calendar
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { AgentUsageForm } from '@/components/agent/AgentUsageForm';
import { useAgent, useActivateAgent, useAgentUsage } from '@/hooks/useAgent';
import { useSubscription } from '@/hooks/useProfile';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';

export default function AgentDetail() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  
  const { data: agent, isLoading, error } = useAgent(slug || '');
  const { data: subscription } = useSubscription();
  const { data: usageHistory } = useAgentUsage(agent?.id);
  const activateAgent = useActivateAgent();

  const isPremium = subscription?.plan_type !== 'free';
  const isAgentPremium = agent?.is_premium;
  const canUse = !isAgentPremium || isPremium;
  
  const features = Array.isArray(agent?.features) ? agent.features : [];
  const lastUsed = usageHistory?.[0];

  const handleActivate = async () => {
    if (!user) {
      toast.error('Connexion requise', {
        description: 'Veuillez vous connecter pour utiliser cet agent.',
      });
      navigate('/login');
      return;
    }

    if (!canUse) {
      toast.error('Agent Premium', {
        description: 'Passez au plan Premium pour utiliser cet agent.',
      });
      return;
    }

    if (!agent) return;

    try {
      await activateAgent.mutateAsync({ agentId: agent.id });
      toast.success(`Agent "${agent.name}" activé !`, {
        description: 'Vous pouvez maintenant l\'utiliser.',
      });
    } catch (err) {
      toast.error('Erreur', {
        description: 'Impossible d\'activer l\'agent. Veuillez réessayer.',
      });
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <DashboardHeader />
        <div className="flex flex-col items-center justify-center py-32">
          <Loader2 className="w-12 h-12 text-primary animate-spin mb-4" />
          <p className="text-muted-foreground">Chargement de l'agent...</p>
        </div>
      </div>
    );
  }

  if (error || !agent) {
    return (
      <div className="min-h-screen bg-background">
        <DashboardHeader />
        <main className="container mx-auto px-4 py-8">
          <Link to="/dashboard">
            <Button variant="ghost" className="mb-6">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Retour au dashboard
            </Button>
          </Link>
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Agent introuvable</AlertTitle>
            <AlertDescription>
              Cet agent n'existe pas ou n'est plus disponible.
            </AlertDescription>
          </Alert>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <DashboardHeader />

      <main className="container mx-auto px-4 py-8">
        {/* Back button */}
        <Link to="/dashboard">
          <Button variant="ghost" className="mb-6 hover:bg-secondary">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Retour au dashboard
          </Button>
        </Link>

        <div className="grid lg:grid-cols-3 gap-8">
          {/* Main content */}
          <div className="lg:col-span-2 space-y-8">
            {/* Agent header */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="futuristic-card p-8"
            >
              <div className="flex items-start gap-6">
                <div
                  className="w-20 h-20 rounded-2xl flex items-center justify-center text-4xl shrink-0 bg-secondary border border-border"
                  style={agent.color ? {
                    backgroundColor: `${agent.color}20`,
                    borderColor: agent.color,
                    boxShadow: `0 0 30px ${agent.color}30`,
                  } : undefined}
                >
                  {agent.icon || '🤖'}
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <h1 className="text-3xl font-bold">{agent.name}</h1>
                    {agent.is_premium && (
                      <Badge className="bg-gradient-to-r from-amber-500 to-orange-500 text-white border-0">
                        <Crown className="w-3 h-3 mr-1" />
                        Premium
                      </Badge>
                    )}
                  </div>
                  <Badge variant="secondary" className="mb-4">
                    {agent.category}
                  </Badge>
                  <p className="text-muted-foreground text-lg">
                    {agent.description || 'Agent IA pour automatiser vos tâches professionnelles'}
                  </p>
                </div>
              </div>
            </motion.div>

            {/* Features section */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="futuristic-card p-8"
            >
              <h2 className="text-xl font-semibold mb-6 flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-accent-cyan" />
                Fonctionnalités
              </h2>
              {features.length > 0 ? (
                <ul className="space-y-4">
                  {features.map((feature, index) => (
                    <motion.li
                      key={index}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.15 + index * 0.05 }}
                      className="flex items-start gap-3"
                    >
                      <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0 mt-0.5" />
                      <span className="text-foreground">{String(feature)}</span>
                    </motion.li>
                  ))}
                </ul>
              ) : (
              <p className="text-muted-foreground">
                  Cet agent offre des capacités d'automatisation avancées pour votre entreprise.
                </p>
              )}
            </motion.div>

            {/* Agent Usage Form */}
            <AgentUsageForm agent={agent} />

            {/* Usage history */}
            {usageHistory && usageHistory.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                className="futuristic-card p-8"
              >
                <h2 className="text-xl font-semibold mb-6 flex items-center gap-2">
                  <Clock className="w-5 h-5 text-accent-purple" />
                  Historique d'utilisation
                </h2>
                <div className="space-y-3">
                  {usageHistory.slice(0, 5).map((usage, index) => (
                    <div
                      key={usage.id}
                      className="flex items-center justify-between py-3 border-b border-border last:border-0"
                    >
                      <div className="flex items-center gap-3">
                        <div className={`w-2 h-2 rounded-full ${
                          usage.status === 'active' ? 'bg-green-500' : 
                          usage.status === 'completed' ? 'bg-blue-500' : 'bg-muted'
                        }`} />
                        <span className="text-sm capitalize">{usage.action_type}</span>
                      </div>
                      <span className="text-sm text-muted-foreground">
                        {new Date(usage.created_at).toLocaleDateString('fr-FR', {
                          day: 'numeric',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Activation card */}
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.15 }}
              className="futuristic-card p-6 sticky top-24"
            >
              <div className="text-center mb-6">
                {isAgentPremium && !isPremium ? (
                  <>
                    <div className="w-16 h-16 rounded-full bg-amber-500/20 flex items-center justify-center mx-auto mb-4">
                      <Crown className="w-8 h-8 text-amber-500" />
                    </div>
                    <h3 className="text-lg font-semibold mb-2">Agent Premium</h3>
                    <p className="text-muted-foreground text-sm mb-4">
                      Passez au plan Premium pour débloquer cet agent et profiter de toutes ses fonctionnalités.
                    </p>
                  </>
                ) : (
                  <>
                    <div 
                      className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4"
                      style={{
                        backgroundColor: agent.color ? `${agent.color}20` : 'hsl(var(--primary) / 0.2)',
                      }}
                    >
                      <Zap className="w-8 h-8" style={{ color: agent.color || 'hsl(var(--primary))' }} />
                    </div>
                    <h3 className="text-lg font-semibold mb-2">Prêt à utiliser</h3>
                    <p className="text-muted-foreground text-sm mb-4">
                      Activez cet agent pour commencer à automatiser vos tâches.
                    </p>
                  </>
                )}
              </div>

              <Button
                onClick={handleActivate}
                disabled={activateAgent.isPending}
                className={`w-full ${
                  canUse 
                    ? 'bg-gradient-to-r from-primary to-accent hover:opacity-90' 
                    : 'bg-gradient-to-r from-amber-500 to-orange-500'
                }`}
                size="lg"
              >
                {activateAgent.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : canUse ? (
                  <Zap className="w-4 h-4 mr-2" />
                ) : (
                  <Crown className="w-4 h-4 mr-2" />
                )}
                {canUse ? 'Activer l\'agent' : 'Passer au Premium'}
              </Button>

              {/* Demo request button */}
              <Button
                variant="outline"
                className="w-full border-accent-cyan/50 text-accent-cyan hover:bg-accent-cyan/10"
                size="lg"
                onClick={() => {
                  const contactSection = document.getElementById('contact');
                  if (contactSection) {
                    contactSection.scrollIntoView({ behavior: 'smooth' });
                  } else {
                    navigate('/#contact');
                  }
                }}
              >
                <Calendar className="w-4 h-4 mr-2" />
                Demander une démo
              </Button>

              {lastUsed && (
                <p className="text-xs text-muted-foreground text-center mt-4">
                  Dernière utilisation: {new Date(lastUsed.created_at).toLocaleDateString('fr-FR')}
                </p>
              )}
            </motion.div>

            {/* Stats card */}
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.2 }}
              className="futuristic-card p-6"
            >
              <h3 className="text-sm font-medium text-muted-foreground mb-4">Statistiques</h3>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm">Catégorie</span>
                  <Badge variant="outline">{agent.category}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Fonctionnalités</span>
                  <span className="font-semibold">{features.length}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Utilisations</span>
                  <span className="font-semibold">{usageHistory?.length || 0}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Note</span>
                  <div className="flex items-center gap-1">
                    <Star className="w-4 h-4 text-amber-500 fill-amber-500" />
                    <span className="font-semibold">4.8</span>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        </div>
      </main>
    </div>
  );
}
