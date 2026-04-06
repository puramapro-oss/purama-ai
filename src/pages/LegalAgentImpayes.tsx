import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Loader2, Plus, DollarSign, Trash2, CheckCircle2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import {
  listImpayes, createImpaye, updateImpaye, deleteImpaye,
  formatEUR, IMPAYE_STATUS_META,
  type LegalImpaye,
} from '@/lib/legal';

const blank = (): Partial<LegalImpaye> => ({
  debtor_name: '',
  debtor_email: '',
  debtor_address: '',
  debtor_siren: '',
  invoice_number: '',
  invoice_date: '',
  due_date: '',
  amount: 0,
  interest_rate: 11.62,
  status: 'overdue',
  notes: '',
});

export default function LegalAgentImpayes() {
  const { user } = useAuth();
  const [impayes, setImpayes] = useState<LegalImpaye[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<LegalImpaye> | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    if (!user) return;
    setLoading(true);
    try { setImpayes(await listImpayes(user.id)); }
    catch (e) { toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setLoading(false); }
  };
  useEffect(() => { refresh(); /* eslint-disable-line */ }, [user?.id]);

  const handleSave = async () => {
    if (!user || !editing || !editing.debtor_name?.trim() || !editing.amount) return;
    setBusy(true);
    try {
      if (editing.id) {
        const { id, user_id, created_at, updated_at, ...patch } = editing as LegalImpaye;
        void user_id; void created_at; void updated_at;
        await updateImpaye(id, patch);
      } else {
        await createImpaye(user.id, editing);
      }
      toast.success('✅ Enregistré');
      setEditing(null);
      refresh();
    } catch (e) {
      toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  };

  const handleMarkPaid = async (id: string) => {
    try {
      await updateImpaye(id, { status: 'paid', paid_at: new Date().toISOString(), settled: true });
      toast.success('Marqué payé');
      refresh();
    } catch (e) { toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) }); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Supprimer cet impayé ?')) return;
    try { await deleteImpaye(id); toast.success('Supprimé'); refresh(); }
    catch (e) { toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) }); }
  };

  const total = impayes.filter(i => !['paid', 'closed'].includes(i.status)).reduce((s, i) => s + Number(i.amount), 0);

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between">
        <div>
          <Link to="/dashboard/legal-agent" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-1">
            <ArrowLeft className="w-3 h-3" /> Retour
          </Link>
          <h1 className="text-2xl font-orbitron font-bold text-foreground flex items-center gap-2">
            <DollarSign className="w-6 h-6 text-yellow-400" /> Impayés
          </h1>
          <p className="text-sm text-muted-foreground">Total à recouvrer : <span className="text-foreground font-semibold">{formatEUR(total)}</span></p>
        </div>
        <Button onClick={() => setEditing(blank())}>
          <Plus className="w-4 h-4 mr-2" /> Nouvel impayé
        </Button>
      </motion.div>

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-accent-cyan" /></div>
      ) : impayes.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            Aucun impayé. Bravo ✨
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {impayes.map(i => {
            const meta = IMPAYE_STATUS_META[i.status];
            return (
              <Card key={i.id} className="bg-card border-border">
                <CardContent className="p-4 flex items-center gap-3">
                  <div className="text-2xl flex-shrink-0">{meta.emoji}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium text-foreground truncate">{i.debtor_name}</p>
                      <Badge variant="outline" className={`text-[10px] ${meta.color}`}>{meta.label}</Badge>
                      {i.invoice_number && <span className="text-[11px] text-muted-foreground">{i.invoice_number}</span>}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      {i.due_date && `Dû le ${new Date(i.due_date).toLocaleDateString('fr-FR')}`}
                      {i.debtor_email && ` · ${i.debtor_email}`}
                    </p>
                    {(i.reminder_1_sent_at || i.mise_en_demeure_sent_at) && (
                      <div className="flex gap-1 mt-1">
                        {i.reminder_1_sent_at && <Badge variant="secondary" className="text-[9px]">Relance 1 ✓</Badge>}
                        {i.reminder_2_sent_at && <Badge variant="secondary" className="text-[9px]">Relance 2 ✓</Badge>}
                        {i.mise_en_demeure_sent_at && <Badge variant="secondary" className="text-[9px]">MED ✓</Badge>}
                      </div>
                    )}
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-lg font-orbitron font-bold text-foreground">{formatEUR(Number(i.amount))}</p>
                    {i.interest_rate > 0 && <p className="text-[10px] text-muted-foreground">{i.interest_rate}% pénalités</p>}
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    {i.status !== 'paid' && (
                      <Button variant="ghost" size="icon" onClick={() => handleMarkPaid(i.id)} title="Marquer payé"><CheckCircle2 className="w-4 h-4 text-emerald-400" /></Button>
                    )}
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(i.id)} className="text-red-400"><Trash2 className="w-4 h-4" /></Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Editor */}
      <Dialog open={!!editing} onOpenChange={o => !o && setEditing(null)}>
        <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing?.id ? 'Modifier' : 'Nouvel impayé'}</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-3">
              <div>
                <Label className="text-xs">Débiteur (raison sociale ou nom)</Label>
                <Input value={editing.debtor_name ?? ''} onChange={e => setEditing({ ...editing, debtor_name: e.target.value })} className="mt-1.5" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Email</Label>
                  <Input type="email" value={editing.debtor_email ?? ''} onChange={e => setEditing({ ...editing, debtor_email: e.target.value })} className="mt-1.5" />
                </div>
                <div>
                  <Label className="text-xs">SIREN</Label>
                  <Input value={editing.debtor_siren ?? ''} onChange={e => setEditing({ ...editing, debtor_siren: e.target.value })} className="mt-1.5" />
                </div>
              </div>
              <div>
                <Label className="text-xs">Adresse</Label>
                <Input value={editing.debtor_address ?? ''} onChange={e => setEditing({ ...editing, debtor_address: e.target.value })} className="mt-1.5" />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label className="text-xs">N° facture</Label>
                  <Input value={editing.invoice_number ?? ''} onChange={e => setEditing({ ...editing, invoice_number: e.target.value })} className="mt-1.5" />
                </div>
                <div>
                  <Label className="text-xs">Date facture</Label>
                  <Input type="date" value={editing.invoice_date ?? ''} onChange={e => setEditing({ ...editing, invoice_date: e.target.value })} className="mt-1.5" />
                </div>
                <div>
                  <Label className="text-xs">Date d'échéance</Label>
                  <Input type="date" value={editing.due_date ?? ''} onChange={e => setEditing({ ...editing, due_date: e.target.value })} className="mt-1.5" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Montant (€)</Label>
                  <Input type="number" step="0.01" value={editing.amount ?? 0} onChange={e => setEditing({ ...editing, amount: parseFloat(e.target.value || '0') })} className="mt-1.5" />
                </div>
                <div>
                  <Label className="text-xs">Taux pénalités (%)</Label>
                  <Input type="number" step="0.01" value={editing.interest_rate ?? 11.62} onChange={e => setEditing({ ...editing, interest_rate: parseFloat(e.target.value || '11.62') })} className="mt-1.5" />
                </div>
              </div>
              <div>
                <Label className="text-xs">Notes</Label>
                <Textarea rows={2} value={editing.notes ?? ''} onChange={e => setEditing({ ...editing, notes: e.target.value })} className="mt-1.5" />
              </div>
              <div className="rounded-lg bg-accent-purple/5 border border-accent-purple/20 p-3 text-[11px] text-muted-foreground">
                <strong className="text-accent-purple">Recouvrement automatique :</strong> Si activé dans les paramètres, l'agent enverra J+7 relance amiable, J+15 relance ferme, J+30 mise en demeure (LRAR via DocuSeal), J+45 préparation injonction de payer.
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Annuler</Button>
            <Button onClick={handleSave} disabled={busy || !editing?.debtor_name?.trim() || !editing?.amount}>
              {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Enregistrer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
