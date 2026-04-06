import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Sparkles, Plus, Loader2, Bot, Activity, ArrowRight,
  Store, History, Brain,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { TutorialOverlay, type TutorialStep } from '@/components/shared/TutorialOverlay';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import {
  listMyAgents, listTemplates, listRuns,
  CATEGORIES,
  type CreatorAgent, type CreatorAgentRun,
} from '@/lib/creator-agent';

export default function CreatorAgentPage() {
  const { user } = useAuth();
  const [myAgents, setMyAgents] = useState<CreatorAgent[]>([]);
  const [templates, setTemplates] = useState<CreatorAgent[]>([]);
  const [recentRuns, setRecentRuns] = useState<CreatorAgentRun[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const [m, t, r] = await Promise.all([
          listMyAgents(user.id),
          listTemplates(),
          listRuns(user.id, { limit: 8 }),
        ]);
        setMyAgents(m);
        setTemplates(t);
        setRecentRuns(r);
      } catch (e) {
        toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
      } finally {
        setLoading(false);
      }
    })();
  }, [user?.id]);

  if (loading) {
    return <div className="flex items-center justify-center min-h-[60vh]"><Loader2 className="w-8 h-8 text-accent-cyan animate-spin" /></div>;
  }

  const totalRuns = myAgents.reduce((s, a) => s + a.total_runs, 0);
  const totalTokens = myAgents.reduce((s, a) => s + a.total_tokens, 0);

  const tutorialSteps: TutorialStep[] = [
    { selector: null, title: 'Bienvenue dans le Créateur d\'agents 🧬', body: 'Crée tes propres agents IA personnalisés en décrivant ce que tu veux en français. Pas de code.' },
    { selector: null, title: 'Mode IA en 30 secondes', body: 'Tape « Je veux un agent qui... » et l\'IA génère nom, emoji, prompt système et config complète.' },
    { selector: null, title: '10 templates prêts à cloner', body: 'Sales Closer, Content Writer, Daily Recap... Clone-les en 1 clic depuis la marketplace.' },
    { selector: null, title: 'Chat ou cron', body: 'Discute avec ton agent OU active le mode autonome cron pour qu\'il tourne tout seul.' },
    { selector: null, title: 'Suis tes runs', body: 'Historique complet des exécutions, tokens consommés, durée, status.' },
  ];

  return (
    <div className="space-y-8 max-w-6xl mx-auto pb-12">
      <TutorialOverlay storageKey="creator-agent" steps={tutorialSteps} />
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col sm:flex-row sm:items-center gap-4 sm:justify-between"
      >
        <div>
          <h1 className="text-2xl sm:text-3xl font-orbitron font-bold text-foreground flex items-center gap-3">
            <Sparkles className="w-7 h-7 text-accent-purple" />
            Créateur d'agents
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Crée tes propres agents IA en décrivant ce que tu veux. Pas de code.
          </p>
        </div>
        <Link to="/dashboard/creator-agent/new">
          <Button size="lg">
            <Plus className="w-4 h-4 mr-2" /> Créer un agent
          </Button>
        </Link>
      </motion.div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'Mes agents', value: myAgents.length, icon: Bot, color: 'text-accent-purple', bg: 'bg-accent-purple/10' },
          { label: 'Exécutions', value: totalRuns, icon: Activity, color: 'text-accent-cyan', bg: 'bg-accent-cyan/10' },
          { label: 'Tokens', value: totalTokens.toLocaleString('fr-FR'), icon: Brain, color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
          { label: 'Templates dispo', value: templates.length, icon: Store, color: 'text-yellow-400', bg: 'bg-yellow-500/10' },
        ].map((s, i) => (
          <motion.div key={s.label} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
            <Card className="bg-card border-border">
              <CardContent className="p-4">
                <div className={`w-9 h-9 rounded-xl ${s.bg} flex items-center justify-center mb-2`}>
                  <s.icon className={`w-4 h-4 ${s.color}`} />
                </div>
                <p className="text-xl font-orbitron font-bold text-foreground truncate">{s.value}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">{s.label}</p>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* Quick links */}
      <div className="grid grid-cols-3 gap-3">
        <Link to="/dashboard/creator-agent/templates">
          <Card className="bg-card border-border hover:border-accent-purple/30 transition-all h-full">
            <CardContent className="p-4 flex items-center gap-3">
              <Store className="w-5 h-5 text-accent-purple" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">Marketplace</p>
                <p className="text-[11px] text-muted-foreground">{templates.length} templates</p>
              </div>
            </CardContent>
          </Card>
        </Link>
        <Link to="/dashboard/creator-agent/runs">
          <Card className="bg-card border-border hover:border-accent-purple/30 transition-all h-full">
            <CardContent className="p-4 flex items-center gap-3">
              <History className="w-5 h-5 text-accent-cyan" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">Historique</p>
                <p className="text-[11px] text-muted-foreground">{recentRuns.length} runs récents</p>
              </div>
            </CardContent>
          </Card>
        </Link>
        <Link to="/dashboard/creator-agent/new">
          <Card className="bg-gradient-to-br from-accent-purple/10 to-accent-cyan/10 border-accent-purple/30 hover:border-accent-purple/50 transition-all h-full">
            <CardContent className="p-4 flex items-center gap-3">
              <Sparkles className="w-5 h-5 text-accent-purple" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">Nouveau via IA</p>
                <p className="text-[11px] text-muted-foreground">Décris en français</p>
              </div>
            </CardContent>
          </Card>
        </Link>
      </div>

      {/* Mes agents */}
      <Card className="bg-card border-border">
        <CardContent className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-orbitron font-bold text-foreground flex items-center gap-2">
              <Bot className="w-5 h-5 text-accent-purple" /> Mes agents
            </h2>
            {myAgents.length > 0 && (
              <Link to="/dashboard/creator-agent/new" className="text-xs text-accent-purple hover:underline flex items-center gap-1">
                + Nouveau <ArrowRight className="w-3 h-3" />
              </Link>
            )}
          </div>
          {myAgents.length === 0 ? (
            <div className="text-center py-12">
              <div className="text-5xl mb-3">🤖</div>
              <p className="text-sm font-medium text-foreground">Aucun agent pour l'instant</p>
              <p className="text-[11px] text-muted-foreground mt-1 mb-4">
                Crée ton premier agent en 30 secondes via l'assistant IA
              </p>
              <Link to="/dashboard/creator-agent/new">
                <Button><Sparkles className="w-4 h-4 mr-2" /> Créer mon premier agent</Button>
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {myAgents.map(a => (
                <AgentCard key={a.id} agent={a} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Templates highlights */}
      {templates.length > 0 && (
        <Card className="bg-card border-border">
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-orbitron font-bold text-foreground flex items-center gap-2">
                <Store className="w-5 h-5 text-yellow-400" /> Templates Purama
              </h2>
              <Link to="/dashboard/creator-agent/templates" className="text-xs text-accent-cyan hover:underline flex items-center gap-1">
                Voir tout <ArrowRight className="w-3 h-3" />
              </Link>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {templates.slice(0, 6).map(t => <AgentCard key={t.id} agent={t} isTemplate />)}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function AgentCard({ agent, isTemplate }: { agent: CreatorAgent; isTemplate?: boolean }) {
  const cat = CATEGORIES.find(c => c.value === agent.category);
  return (
    <Link to={isTemplate ? `/dashboard/creator-agent/templates` : `/dashboard/creator-agent/${agent.id}`}>
      <Card
        className="bg-secondary/20 border-border hover:border-accent-purple/40 transition-all h-full"
        style={{ borderLeftWidth: 3, borderLeftColor: agent.color }}
      >
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <div className="text-3xl flex-shrink-0">{agent.emoji}</div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-foreground truncate">{agent.name}</p>
              {agent.description && (
                <p className="text-[11px] text-muted-foreground line-clamp-2 mt-0.5">{agent.description}</p>
              )}
              <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                {cat && <Badge variant="outline" className="text-[10px] py-0 h-4">{cat.emoji} {cat.label}</Badge>}
                {agent.schedule_enabled && <Badge variant="secondary" className="text-[10px] py-0 h-4">⏰ Auto</Badge>}
                {agent.total_runs > 0 && <span className="text-[10px] text-muted-foreground">{agent.total_runs} runs</span>}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
