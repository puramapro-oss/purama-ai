import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft, Loader2, Receipt, Check, X, Send, Download, AlertTriangle,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import {
  listDeclarations, approveDeclaration, rejectDeclaration,
  formatEUR, nextDeadlineLabel, DECLARATION_META, STATUS_META,
  type ComptaDeclaration,
} from '@/lib/compta';

export default function ComptaAgentDeclarations() {
  const { user } = useAuth();
  const [decls, setDecls] = useState<ComptaDeclaration[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<ComptaDeclaration | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    if (!user) return;
    setLoading(true);
    try { setDecls(await listDeclarations(user.id)); }
    catch (e) { toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setLoading(false); }
  };
  useEffect(() => { refresh(); /* eslint-disable-line */ }, [user?.id]);

  const handleApprove = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await approveDeclaration(selected.id);
      toast.success('✅ Déclaration approuvée — l\'agent va l\'envoyer');
      setSelected(null);
      refresh();
    } catch (e) {
      toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  };

  const handleReject = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await rejectDeclaration(selected.id, reason || 'Sans raison');
      toast.success('Rejetée');
      setSelected(null);
      setReason('');
      refresh();
    } catch (e) {
      toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}>
        <Link to="/dashboard/compta-agent" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-1">
          <ArrowLeft className="w-3 h-3" /> Retour
        </Link>
        <h1 className="text-2xl font-orbitron font-bold text-foreground flex items-center gap-2">
          <Receipt className="w-6 h-6 text-accent-purple" /> Déclarations fiscales
        </h1>
        <p className="text-sm text-muted-foreground">L'agent prépare 7 jours avant deadline. Tu valides en 1 tap.</p>
      </motion.div>

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-accent-cyan" /></div>
      ) : decls.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            Aucune déclaration pour l'instant. L'agent va les générer automatiquement à l'approche des deadlines.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {decls.map(d => {
            const meta = DECLARATION_META[d.type];
            const st = STATUS_META[d.status];
            const isPending = d.status === 'ready' || d.status === 'pending_approval';
            const days = Math.ceil((new Date(d.deadline).getTime() - Date.now()) / 86400000);
            const urgent = days <= 3 && isPending;
            return (
              <button
                key={d.id}
                onClick={() => setSelected(d)}
                className={`w-full text-left flex items-center gap-3 p-4 rounded-lg border transition-all ${
                  urgent
                    ? 'border-red-500/40 bg-red-500/5 hover:bg-red-500/10'
                    : isPending
                    ? 'border-yellow-500/30 bg-yellow-500/5 hover:bg-yellow-500/10'
                    : 'border-border bg-card hover:bg-secondary/30'
                }`}
              >
                <div className="text-3xl flex-shrink-0">{meta.emoji}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-foreground">{meta.label}</span>
                    <Badge variant="outline" className="text-[10px] py-0 h-4">{d.period}</Badge>
                    {urgent && <Badge className="bg-red-500/15 text-red-400 border-red-500/30 text-[10px]"><AlertTriangle className="w-2.5 h-2.5 mr-0.5" /> URGENT</Badge>}
                  </div>
                  <p className={`text-[11px] ${st.color} mt-0.5`}>{st.label}</p>
                  {d.ai_optimizations.length > 0 && (
                    <p className="text-[10px] text-accent-purple mt-0.5">✨ {d.ai_optimizations.length} optimisation(s) appliquée(s)</p>
                  )}
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-xs font-medium text-foreground">{nextDeadlineLabel(d.deadline)}</p>
                  <p className="text-[10px] text-muted-foreground">{new Date(d.deadline).toLocaleDateString('fr-FR')}</p>
                </div>
              </button>
            );
          })}
        </div>
      )}

      <Dialog open={!!selected} onOpenChange={o => !o && setSelected(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <span className="text-2xl">{DECLARATION_META[selected.type].emoji}</span>
                  {DECLARATION_META[selected.type].label} — {selected.period}
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="flex items-center justify-between text-xs">
                  <span className={STATUS_META[selected.status].color}>{STATUS_META[selected.status].label}</span>
                  <span className="text-muted-foreground">Deadline : {new Date(selected.deadline).toLocaleDateString('fr-FR')}</span>
                </div>

                {/* Calculated data */}
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Montants calculés</p>
                  <div className="rounded-lg bg-secondary/30 border border-border p-3 text-xs space-y-1">
                    {Object.entries(selected.calculated_data).slice(0, 12).map(([k, v]) => (
                      <div key={k} className="flex justify-between">
                        <span className="text-muted-foreground">{k}</span>
                        <span className="font-mono text-foreground">
                          {typeof v === 'number' ? formatEUR(v) : String(v)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {selected.ai_notes && (
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Notes de l'IA</p>
                    <div className="rounded-lg bg-accent-purple/5 border border-accent-purple/20 p-3 text-xs italic text-foreground/80">
                      {selected.ai_notes}
                    </div>
                  </div>
                )}

                {selected.ai_optimizations.length > 0 && (
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Optimisations détectées</p>
                    <ul className="text-xs text-emerald-400 space-y-0.5">
                      {selected.ai_optimizations.map((o, i) => <li key={i}>✨ {o}</li>)}
                    </ul>
                  </div>
                )}

                {selected.pdf_url && (
                  <a href={selected.pdf_url} target="_blank" rel="noreferrer">
                    <Button variant="outline" className="w-full"><Download className="w-4 h-4 mr-2" /> Télécharger le PDF</Button>
                  </a>
                )}

                {(selected.status === 'ready' || selected.status === 'pending_approval') && (
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Raison du rejet (si tu rejettes)</p>
                    <Textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} placeholder="Optionnel…" />
                  </div>
                )}

                {selected.confirmation_number && (
                  <div className="rounded-lg bg-emerald-500/5 border border-emerald-500/20 p-3 text-xs">
                    <p className="text-emerald-400 font-medium">✅ Confirmé par la DGFiP</p>
                    <p className="font-mono text-foreground mt-1">N° {selected.confirmation_number}</p>
                  </div>
                )}
              </div>
              <DialogFooter className="gap-2">
                {(selected.status === 'ready' || selected.status === 'pending_approval') && (
                  <>
                    <Button variant="outline" onClick={handleReject} disabled={busy} className="text-red-400 hover:text-red-300">
                      <X className="w-4 h-4 mr-2" /> Rejeter
                    </Button>
                    <Button onClick={handleApprove} disabled={busy}>
                      {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Check className="w-4 h-4 mr-2" />}
                      Approuver & envoyer
                    </Button>
                  </>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
