import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Loader2, History, Filter } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import {
  listRuns, listMyAgents,
  type CreatorAgentRun, type CreatorAgent, type RunStatus,
} from '@/lib/creator-agent';

export default function CreatorAgentRuns() {
  const { user } = useAuth();
  const [runs, setRuns] = useState<CreatorAgentRun[]>([]);
  const [agents, setAgents] = useState<CreatorAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'all' | RunStatus>('all');
  const [agentFilter, setAgentFilter] = useState<string>('all');

  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const [r, a] = await Promise.all([
          listRuns(user.id, { limit: 200 }),
          listMyAgents(user.id),
        ]);
        setRuns(r);
        setAgents(a);
      } catch (e) {
        toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
      } finally {
        setLoading(false);
      }
    })();
  }, [user?.id]);

  const filtered = runs.filter(r => {
    if (statusFilter !== 'all' && r.status !== statusFilter) return false;
    if (agentFilter !== 'all' && r.agent_id !== agentFilter) return false;
    return true;
  });

  const agentName = (id: string) => agents.find(a => a.id === id)?.name ?? 'Agent supprimé';
  const agentEmoji = (id: string) => agents.find(a => a.id === id)?.emoji ?? '🤖';

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}>
        <Link to="/dashboard/creator-agent" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-1">
          <ArrowLeft className="w-3 h-3" /> Retour
        </Link>
        <h1 className="text-2xl font-orbitron font-bold text-foreground flex items-center gap-2">
          <History className="w-6 h-6 text-accent-cyan" /> Historique des runs
        </h1>
      </motion.div>

      <div className="flex items-center gap-2 flex-wrap">
        <Filter className="w-4 h-4 text-muted-foreground" />
        <Select value={agentFilter} onValueChange={setAgentFilter}>
          <SelectTrigger className="w-[200px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tous les agents</SelectItem>
            {agents.map(a => <SelectItem key={a.id} value={a.id}>{a.emoji} {a.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={v => setStatusFilter(v as 'all' | RunStatus)}>
          <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tous statuts</SelectItem>
            <SelectItem value="success">Succès</SelectItem>
            <SelectItem value="error">Erreurs</SelectItem>
            <SelectItem value="running">En cours</SelectItem>
            <SelectItem value="pending">En attente</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-accent-cyan" /></div>
      ) : filtered.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            Aucun run pour ces filtres.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map(r => (
            <Card key={r.id} className="bg-card border-border">
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <div className="text-2xl flex-shrink-0">{agentEmoji(r.agent_id)}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link to={`/dashboard/creator-agent/${r.agent_id}`} className="text-sm font-medium text-foreground hover:underline truncate">
                        {agentName(r.agent_id)}
                      </Link>
                      <Badge variant="outline" className="text-[10px]">{r.trigger}</Badge>
                      <Badge className={`text-[10px] ${
                        r.status === 'success' ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                        : r.status === 'error' ? 'bg-red-500/15 text-red-400 border-red-500/30'
                        : 'bg-secondary'
                      }`}>{r.status}</Badge>
                      <span className="text-[10px] text-muted-foreground">
                        {new Date(r.created_at).toLocaleString('fr-FR')}
                        {r.duration_ms && ` · ${r.duration_ms}ms`}
                        {(r.tokens_input || r.tokens_output) && ` · ${(r.tokens_input ?? 0) + (r.tokens_output ?? 0)} tokens`}
                      </span>
                    </div>
                    {r.input && <p className="text-[11px] text-muted-foreground line-clamp-2 mt-1">→ {r.input}</p>}
                    {r.output && <p className="text-xs text-foreground/80 line-clamp-3 mt-1">{r.output}</p>}
                    {r.error_message && <p className="text-[11px] text-red-400 mt-1">⚠️ {r.error_message}</p>}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
