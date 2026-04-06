import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Loader2, Store, Copy, Filter } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import {
  listTemplates, listPublicAgents, cloneTemplate,
  CATEGORIES,
  type CreatorAgent, type AgentCategory,
} from '@/lib/creator-agent';

export default function CreatorAgentTemplates() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [templates, setTemplates] = useState<CreatorAgent[]>([]);
  const [publicAgents, setPublicAgents] = useState<CreatorAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | AgentCategory>('all');
  const [cloning, setCloning] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [t, p] = await Promise.all([listTemplates(), listPublicAgents()]);
        setTemplates(t);
        setPublicAgents(p);
      } catch (e) {
        toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleClone = async (tpl: CreatorAgent) => {
    if (!user) return;
    setCloning(tpl.id);
    try {
      const clone = await cloneTemplate(user.id, tpl.id);
      toast.success(`✅ ${clone.name} cloné`);
      nav(`/dashboard/creator-agent/${clone.id}`);
    } catch (e) {
      toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
    } finally { setCloning(null); }
  };

  const filtered = (list: CreatorAgent[]) =>
    filter === 'all' ? list : list.filter(a => a.category === filter);

  return (
    <div className="space-y-6 max-w-6xl mx-auto pb-12">
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}>
        <Link to="/dashboard/creator-agent" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-1">
          <ArrowLeft className="w-3 h-3" /> Retour
        </Link>
        <h1 className="text-2xl font-orbitron font-bold text-foreground flex items-center gap-2">
          <Store className="w-6 h-6 text-yellow-400" /> Marketplace
        </h1>
        <p className="text-sm text-muted-foreground">Templates Purama et agents partagés par la communauté.</p>
      </motion.div>

      <div className="flex items-center gap-2">
        <Filter className="w-4 h-4 text-muted-foreground" />
        <Select value={filter} onValueChange={v => setFilter(v as 'all' | AgentCategory)}>
          <SelectTrigger className="w-[200px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Toutes catégories</SelectItem>
            {CATEGORIES.map(c => <SelectItem key={c.value} value={c.value}>{c.emoji} {c.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-accent-purple" /></div>
      ) : (
        <>
          {/* Templates Purama */}
          <div>
            <h2 className="text-sm font-semibold text-foreground mb-3">⭐ Templates officiels Purama</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filtered(templates).map(t => (
                <TemplateCard key={t.id} agent={t} onClone={() => handleClone(t)} cloning={cloning === t.id} />
              ))}
              {filtered(templates).length === 0 && (
                <p className="text-sm text-muted-foreground col-span-full text-center py-8">Aucun template dans cette catégorie.</p>
              )}
            </div>
          </div>

          {/* Public agents */}
          {publicAgents.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-foreground mb-3 mt-8">🌍 Partagés par la communauté</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {filtered(publicAgents).map(a => (
                  <TemplateCard key={a.id} agent={a} onClone={() => handleClone(a)} cloning={cloning === a.id} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TemplateCard({
  agent, onClone, cloning,
}: {
  agent: CreatorAgent;
  onClone: () => void;
  cloning: boolean;
}) {
  const cat = CATEGORIES.find(c => c.value === agent.category);
  return (
    <Card
      className="bg-card border-border hover:border-accent-purple/40 transition-all"
      style={{ borderLeftWidth: 3, borderLeftColor: agent.color }}
    >
      <CardContent className="p-4">
        <div className="flex items-start gap-3 mb-3">
          <div className="text-3xl">{agent.emoji}</div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground">{agent.name}</p>
            {cat && <Badge variant="outline" className="text-[10px] mt-1">{cat.emoji} {cat.label}</Badge>}
          </div>
        </div>
        {agent.description && (
          <p className="text-[11px] text-muted-foreground line-clamp-3 mb-3">{agent.description}</p>
        )}
        <Button onClick={onClone} disabled={cloning} size="sm" className="w-full">
          {cloning ? <Loader2 className="w-3 h-3 mr-2 animate-spin" /> : <Copy className="w-3 h-3 mr-2" />}
          Cloner
        </Button>
      </CardContent>
    </Card>
  );
}
