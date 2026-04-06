import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft, Loader2, Check, X, Filter, Send, MessageSquare,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import {
  listLogs, approveLog, rejectLog, sendDraft,
  ACTION_META, CATEGORY_META,
  type EmailAgentLog, type EmailAction,
} from '@/lib/email-agent';

export default function EmailAgentLogs() {
  const { user } = useAuth();
  const [logs, setLogs] = useState<EmailAgentLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'pending' | EmailAction>('all');
  const [selected, setSelected] = useState<EmailAgentLog | null>(null);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const opts: { limit: number; pendingOnly?: boolean; action?: EmailAction } = { limit: 200 };
      if (filter === 'pending') opts.pendingOnly = true;
      else if (filter !== 'all') opts.action = filter;
      setLogs(await listLogs(user.id, opts));
    } catch (e) {
      toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); /* eslint-disable-line */ }, [user?.id, filter]);

  const handleApprove = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await approveLog(selected.id, feedback || undefined);
      if (selected.action_taken === 'draft') {
        await sendDraft(selected.id);
      }
      toast.success('✅ Approuvé et envoyé');
      setSelected(null);
      setFeedback('');
      refresh();
    } catch (e) {
      toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await rejectLog(selected.id, feedback || undefined);
      toast.success('Rejeté — l\'agent va apprendre');
      setSelected(null);
      setFeedback('');
      refresh();
    } catch (e) {
      toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <Link to="/dashboard/email-agent" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-1">
            <ArrowLeft className="w-3 h-3" /> Retour
          </Link>
          <h1 className="text-2xl font-orbitron font-bold text-foreground">Activité de l'agent</h1>
        </div>
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-muted-foreground" />
          <Select value={filter} onValueChange={v => setFilter(v as typeof filter)}>
            <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tout</SelectItem>
              <SelectItem value="pending">À valider</SelectItem>
              <SelectItem value="auto_reply">Réponses auto</SelectItem>
              <SelectItem value="draft">Brouillons</SelectItem>
              <SelectItem value="notify">Notifiés</SelectItem>
              <SelectItem value="archive">Archivés</SelectItem>
              <SelectItem value="ignore">Ignorés</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </motion.div>

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-accent-cyan" /></div>
      ) : logs.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            Aucun élément à afficher.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {logs.map(log => {
            const action = ACTION_META[log.action_taken] ?? ACTION_META.ignore;
            const cat = CATEGORY_META[log.category] ?? CATEGORY_META.normal;
            const isPending = log.action_taken === 'draft' && log.user_approved === null;
            return (
              <button
                key={log.id}
                onClick={() => setSelected(log)}
                className={`w-full text-left flex items-start gap-3 p-4 rounded-lg border transition-all ${
                  isPending
                    ? 'border-yellow-500/30 bg-yellow-500/5 hover:bg-yellow-500/10'
                    : 'border-border bg-card hover:bg-secondary/30'
                }`}
              >
                <div className="text-2xl flex-shrink-0">{action.emoji}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-foreground truncate">
                      {log.from_name || log.from_email}
                    </span>
                    <Badge variant="outline" className="text-[10px] py-0 h-4">
                      {cat.emoji} {cat.label}
                    </Badge>
                    {isPending && (
                      <Badge className="bg-yellow-500/15 text-yellow-400 border-yellow-500/30 text-[10px]">
                        À valider
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-foreground/80 truncate mt-0.5">
                    {log.subject || '(sans objet)'}
                  </p>
                  <p className="text-[11px] text-muted-foreground truncate mt-0.5 italic">
                    {log.ai_reasoning || log.snippet}
                  </p>
                </div>
                <div className="flex flex-col items-end flex-shrink-0">
                  <span className={`text-[11px] ${action.color}`}>{action.label}</span>
                  <span className="text-[10px] text-muted-foreground mt-1">
                    {new Date(log.created_at).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Detail dialog */}
      <Dialog open={!!selected} onOpenChange={o => !o && setSelected(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <MessageSquare className="w-5 h-5 text-accent-cyan" />
                  {selected.subject || '(sans objet)'}
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="text-xs text-muted-foreground">
                  De <span className="text-foreground font-medium">{selected.from_name || selected.from_email}</span>
                  {' — '}
                  {new Date(selected.created_at).toLocaleString('fr-FR')}
                </div>

                {selected.body_preview && (
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Email reçu</p>
                    <div className="rounded-lg bg-secondary/30 border border-border p-3 text-xs whitespace-pre-wrap text-foreground/90 max-h-48 overflow-y-auto">
                      {selected.body_preview}
                    </div>
                  </div>
                )}

                {selected.ai_reasoning && (
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Raisonnement de l'agent</p>
                    <div className="rounded-lg bg-accent-purple/5 border border-accent-purple/20 p-3 text-xs italic text-foreground/80">
                      {selected.ai_reasoning}
                      {selected.confidence_score !== null && (
                        <span className="block mt-1 text-[10px] text-accent-purple">
                          Confiance : {Math.round((selected.confidence_score ?? 0) * 100)}%
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {selected.ai_response && (
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Réponse proposée</p>
                    <div className="rounded-lg bg-emerald-500/5 border border-emerald-500/20 p-3 text-xs whitespace-pre-wrap text-foreground/90 max-h-64 overflow-y-auto">
                      {selected.ai_response}
                    </div>
                  </div>
                )}

                {selected.action_taken === 'draft' && selected.user_approved === null && (
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Feedback (optionnel)</p>
                    <Textarea
                      rows={2}
                      placeholder="Ce qui était bien ou ce qu'il faut améliorer…"
                      value={feedback}
                      onChange={e => setFeedback(e.target.value)}
                    />
                  </div>
                )}
              </div>
              <DialogFooter className="gap-2">
                {selected.action_taken === 'draft' && selected.user_approved === null && (
                  <>
                    <Button variant="outline" onClick={handleReject} disabled={busy} className="text-red-400 hover:text-red-300">
                      <X className="w-4 h-4 mr-2" /> Rejeter
                    </Button>
                    <Button onClick={handleApprove} disabled={busy}>
                      {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Send className="w-4 h-4 mr-2" />}
                      Approuver & envoyer
                    </Button>
                  </>
                )}
                {selected.user_approved !== null && (
                  <Badge variant={selected.user_approved ? 'default' : 'secondary'}>
                    {selected.user_approved ? <><Check className="w-3 h-3 mr-1" /> Approuvé</> : <><X className="w-3 h-3 mr-1" /> Rejeté</>}
                  </Badge>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
