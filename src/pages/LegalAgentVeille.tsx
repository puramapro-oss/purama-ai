import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Loader2, Bell, CheckCircle2, ExternalLink, AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { listVeille, markVeilleRead, type LegalVeille, type VeilleSeverity } from '@/lib/legal';

const SEVERITY_META: Record<VeilleSeverity, { label: string; color: string; emoji: string }> = {
  info: { label: 'Info', color: 'text-cyan-400', emoji: 'ℹ️' },
  warning: { label: 'Attention', color: 'text-yellow-400', emoji: '⚠️' },
  action_required: { label: 'Action requise', color: 'text-orange-400', emoji: '⚡' },
  urgent: { label: 'URGENT', color: 'text-red-400', emoji: '🚨' },
};

export default function LegalAgentVeille() {
  const { user } = useAuth();
  const [veille, setVeille] = useState<LegalVeille[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'unread' | 'urgent'>('all');

  const refresh = async () => {
    if (!user) return;
    setLoading(true);
    try { setVeille(await listVeille(user.id)); }
    catch (e) { toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setLoading(false); }
  };
  useEffect(() => { refresh(); /* eslint-disable-line */ }, [user?.id]);

  const handleRead = async (id: string) => {
    try { await markVeilleRead(id); refresh(); }
    catch (e) { toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) }); }
  };

  const filtered = veille.filter(v => {
    if (filter === 'unread') return !v.is_read;
    if (filter === 'urgent') return v.severity === 'urgent' || v.severity === 'action_required';
    return true;
  });

  return (
    <div className="space-y-6 max-w-4xl mx-auto pb-12">
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}>
        <Link to="/dashboard/legal-agent" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-1">
          <ArrowLeft className="w-3 h-3" /> Retour
        </Link>
        <h1 className="text-2xl font-orbitron font-bold text-foreground flex items-center gap-2">
          <Bell className="w-6 h-6 text-accent-purple" /> Veille juridique
        </h1>
        <p className="text-sm text-muted-foreground">Mises à jour de loi, jurisprudences et obligations qui te concernent.</p>
      </motion.div>

      <div className="flex gap-2">
        {(['all', 'unread', 'urgent'] as const).map(f => (
          <Button
            key={f}
            variant={filter === f ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? 'Tout' : f === 'unread' ? 'Non lus' : 'Urgents'}
          </Button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-accent-cyan" /></div>
      ) : filtered.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            Aucune alerte. L'agent surveille en continu et te préviendra dès qu'une loi te concerne.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map(v => {
            const meta = SEVERITY_META[v.severity];
            return (
              <Card key={v.id} className={`bg-card border-border ${!v.is_read ? 'border-accent-purple/30' : ''}`}>
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <div className="text-2xl flex-shrink-0">{meta.emoji}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-semibold text-foreground">{v.title}</p>
                        <Badge variant="outline" className={`text-[10px] ${meta.color}`}>{meta.label}</Badge>
                        {v.category && <Badge variant="secondary" className="text-[10px]">{v.category}</Badge>}
                        {!v.is_read && <span className="w-2 h-2 rounded-full bg-accent-purple" />}
                      </div>
                      <p className="text-xs text-foreground/80 mt-1">{v.summary}</p>
                      {v.impact && (
                        <p className="text-[11px] text-muted-foreground mt-1.5">
                          <strong className="text-accent-purple">Impact :</strong> {v.impact}
                        </p>
                      )}
                      {v.action_required && (
                        <div className="mt-2 rounded-lg bg-accent-purple/5 border border-accent-purple/20 p-2">
                          <p className="text-[11px] text-foreground/90">
                            <strong className="text-accent-purple">⚡ À faire :</strong> {v.action_required}
                          </p>
                        </div>
                      )}
                      <div className="flex items-center gap-3 mt-2 text-[10px] text-muted-foreground">
                        {v.reference && <span>{v.reference}</span>}
                        {v.source_name && <span>· {v.source_name}</span>}
                        {v.effective_date && <span>· Effet {new Date(v.effective_date).toLocaleDateString('fr-FR')}</span>}
                        {v.deadline && <span className="text-red-400">· Deadline {new Date(v.deadline).toLocaleDateString('fr-FR')}</span>}
                      </div>
                    </div>
                    <div className="flex flex-col gap-1 flex-shrink-0">
                      {v.source_url && (
                        <a href={v.source_url} target="_blank" rel="noreferrer">
                          <Button variant="ghost" size="icon"><ExternalLink className="w-3 h-3" /></Button>
                        </a>
                      )}
                      {!v.is_read && (
                        <Button variant="ghost" size="icon" onClick={() => handleRead(v.id)} title="Marquer lu">
                          <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
