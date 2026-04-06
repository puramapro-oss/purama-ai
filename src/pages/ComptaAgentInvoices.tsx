import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Loader2, Plus, Trash2, FileText, Pencil, Send, FileCheck2, Download } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Tabs, TabsList, TabsTrigger,
} from '@/components/ui/tabs';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import {
  listInvoices, createInvoice, updateInvoice, deleteInvoice,
  computeInvoiceTotals, formatEUR, generateFacturX,
  type ComptaInvoice, type InvoiceLine, type InvoiceType, type InvoiceStatus,
} from '@/lib/compta';

const STATUS_LABEL: Record<InvoiceStatus, { label: string; cls: string }> = {
  draft: { label: 'Brouillon', cls: 'bg-secondary text-foreground' },
  sent: { label: 'Envoyée', cls: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30' },
  paid: { label: 'Payée', cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
  overdue: { label: 'En retard', cls: 'bg-red-500/15 text-red-400 border-red-500/30' },
  cancelled: { label: 'Annulée', cls: 'bg-secondary text-muted-foreground' },
};

const newLine = (): InvoiceLine => ({
  description: '',
  quantity: 1,
  unit_price: 0,
  tva_rate: 20,
  total_ht: 0,
});

const newInvoice = (): Partial<ComptaInvoice> => ({
  type: 'emise',
  status: 'draft',
  counterpart_name: '',
  counterpart_email: '',
  counterpart_address: '',
  counterpart_siren: '',
  lines: [newLine()],
  total_ht: 0,
  total_tva: 0,
  total_ttc: 0,
  issue_date: new Date().toISOString().slice(0, 10),
  due_date: new Date(Date.now() + 30 * 86400 * 1000).toISOString().slice(0, 10),
  payment_method: 'virement',
  notes: '',
});

export default function ComptaAgentInvoices() {
  const { user } = useAuth();
  const [invoices, setInvoices] = useState<ComptaInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'emise' | 'recue'>('emise');
  const [editing, setEditing] = useState<Partial<ComptaInvoice> | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    if (!user) return;
    setLoading(true);
    try { setInvoices(await listInvoices(user.id, { type: tab })); }
    catch (e) { toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setLoading(false); }
  };
  useEffect(() => { refresh(); /* eslint-disable-line */ }, [user?.id, tab]);

  const handleSave = async () => {
    if (!user || !editing || !editing.counterpart_name?.trim()) {
      toast.error('Renseigne au moins le nom du client');
      return;
    }
    setBusy(true);
    try {
      const lines = (editing.lines ?? []).map(l => ({
        ...l,
        total_ht: Number(l.quantity) * Number(l.unit_price),
      }));
      const totals = computeInvoiceTotals(lines);
      const payload = { ...editing, lines, ...totals, type: tab };
      if (editing.id) {
        const { id, user_id, created_at, updated_at, invoice_number, ...patch } = payload as ComptaInvoice;
        void user_id; void created_at; void updated_at; void invoice_number;
        await updateInvoice(id, patch);
      } else {
        const { id, user_id, created_at, updated_at, invoice_number, ...rest } = payload as ComptaInvoice;
        void id; void user_id; void created_at; void updated_at; void invoice_number;
        await createInvoice(user.id, rest);
      }
      toast.success('✅ Facture enregistrée');
      setEditing(null);
      refresh();
    } catch (e) {
      toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Supprimer cette facture ?')) return;
    try { await deleteInvoice(id); toast.success('Supprimée'); refresh(); }
    catch (e) { toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) }); }
  };

  const [facturxBusy, setFacturxBusy] = useState<string | null>(null);

  const handleFacturX = async (inv: ComptaInvoice) => {
    setFacturxBusy(inv.id);
    try {
      const { url } = await generateFacturX(inv.id);
      toast.success('✅ Factur-X généré', {
        description: 'PDF/A-3 avec XML EN 16931 intégré',
        action: { label: 'Ouvrir', onClick: () => window.open(url, '_blank') },
      });
      refresh();
    } catch (e) {
      toast.error('Erreur Factur-X', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setFacturxBusy(null);
    }
  };

  const markStatus = async (inv: ComptaInvoice, status: InvoiceStatus) => {
    try {
      await updateInvoice(inv.id, { status, payment_date: status === 'paid' ? new Date().toISOString().slice(0, 10) : null });
      refresh();
    } catch (e) { toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) }); }
  };

  const totals = editing ? computeInvoiceTotals((editing.lines ?? []).map(l => ({ ...l, total_ht: Number(l.quantity) * Number(l.unit_price) }))) : null;

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between">
        <div>
          <Link to="/dashboard/compta-agent" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-1">
            <ArrowLeft className="w-3 h-3" /> Retour
          </Link>
          <h1 className="text-2xl font-orbitron font-bold text-foreground flex items-center gap-2">
            <FileText className="w-6 h-6 text-accent-cyan" /> Factures
          </h1>
        </div>
        <Button onClick={() => setEditing(newInvoice())}>
          <Plus className="w-4 h-4 mr-2" /> Nouvelle facture
        </Button>
      </motion.div>

      <Tabs value={tab} onValueChange={v => setTab(v as 'emise' | 'recue')}>
        <TabsList>
          <TabsTrigger value="emise">Émises (ventes)</TabsTrigger>
          <TabsTrigger value="recue">Reçues (achats)</TabsTrigger>
        </TabsList>
      </Tabs>

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-accent-cyan" /></div>
      ) : invoices.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            Aucune facture {tab === 'emise' ? 'émise' : 'reçue'}.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {invoices.map(inv => {
            const st = STATUS_LABEL[inv.status];
            return (
              <Card key={inv.id} className="bg-card border-border">
                <CardContent className="p-4 flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-accent-cyan/10 flex items-center justify-center flex-shrink-0">
                    <FileText className="w-5 h-5 text-accent-cyan" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium text-foreground">{inv.invoice_number}</p>
                      <Badge className={`text-[10px] ${st.cls}`}>{st.label}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground truncate">{inv.counterpart_name}</p>
                    <p className="text-[10px] text-muted-foreground/70">{new Date(inv.issue_date).toLocaleDateString('fr-FR')}{inv.due_date && ` · échéance ${new Date(inv.due_date).toLocaleDateString('fr-FR')}`}</p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-sm font-orbitron font-bold text-foreground">{formatEUR(inv.total_ttc)}</p>
                    <p className="text-[10px] text-muted-foreground">HT {formatEUR(inv.total_ht)}</p>
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    {inv.facturx_pdf_url ? (
                      <a href={inv.facturx_pdf_url} target="_blank" rel="noreferrer">
                        <Button variant="ghost" size="icon" title="Télécharger PDF Factur-X"><Download className="w-4 h-4 text-emerald-400" /></Button>
                      </a>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleFacturX(inv)}
                        disabled={facturxBusy === inv.id}
                        title="Générer Factur-X"
                      >
                        {facturxBusy === inv.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileCheck2 className="w-4 h-4 text-accent-purple" />}
                      </Button>
                    )}
                    {inv.status === 'draft' && (
                      <Button variant="ghost" size="icon" onClick={() => markStatus(inv, 'sent')} title="Marquer envoyée"><Send className="w-4 h-4 text-cyan-400" /></Button>
                    )}
                    {inv.status === 'sent' && (
                      <Button variant="ghost" size="icon" onClick={() => markStatus(inv, 'paid')} title="Marquer payée">💰</Button>
                    )}
                    <Button variant="ghost" size="icon" onClick={() => setEditing(inv)}><Pencil className="w-4 h-4" /></Button>
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(inv.id)} className="text-red-400"><Trash2 className="w-4 h-4" /></Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Editor */}
      <Dialog open={!!editing} onOpenChange={o => !o && setEditing(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing?.id ? `Modifier ${editing.invoice_number}` : 'Nouvelle facture'}</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Client / Fournisseur</Label>
                  <Input value={editing.counterpart_name ?? ''} onChange={e => setEditing({ ...editing, counterpart_name: e.target.value })} className="mt-1.5" />
                </div>
                <div>
                  <Label className="text-xs">Email</Label>
                  <Input type="email" value={editing.counterpart_email ?? ''} onChange={e => setEditing({ ...editing, counterpart_email: e.target.value })} className="mt-1.5" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">SIREN</Label>
                  <Input value={editing.counterpart_siren ?? ''} onChange={e => setEditing({ ...editing, counterpart_siren: e.target.value })} className="mt-1.5" />
                </div>
                <div>
                  <Label className="text-xs">Adresse</Label>
                  <Input value={editing.counterpart_address ?? ''} onChange={e => setEditing({ ...editing, counterpart_address: e.target.value })} className="mt-1.5" />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label className="text-xs">Date d'émission</Label>
                  <Input type="date" value={editing.issue_date ?? ''} onChange={e => setEditing({ ...editing, issue_date: e.target.value })} className="mt-1.5" />
                </div>
                <div>
                  <Label className="text-xs">Échéance</Label>
                  <Input type="date" value={editing.due_date ?? ''} onChange={e => setEditing({ ...editing, due_date: e.target.value })} className="mt-1.5" />
                </div>
                <div>
                  <Label className="text-xs">Mode paiement</Label>
                  <Select value={editing.payment_method ?? 'virement'} onValueChange={v => setEditing({ ...editing, payment_method: v })}>
                    <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="virement">Virement</SelectItem>
                      <SelectItem value="carte">Carte</SelectItem>
                      <SelectItem value="cheque">Chèque</SelectItem>
                      <SelectItem value="especes">Espèces</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Lines */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label className="text-xs">Lignes</Label>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setEditing({ ...editing, lines: [...(editing.lines ?? []), newLine()] })}>
                    <Plus className="w-3 h-3 mr-1" /> Ajouter
                  </Button>
                </div>
                <div className="space-y-2">
                  {(editing.lines ?? []).map((line, i) => (
                    <div key={i} className="grid grid-cols-12 gap-2 items-end p-2 rounded-lg border border-border bg-secondary/20">
                      <div className="col-span-5">
                        <Label className="text-[10px]">Description</Label>
                        <Input value={line.description} onChange={e => {
                          const lines = [...(editing.lines ?? [])];
                          lines[i] = { ...line, description: e.target.value };
                          setEditing({ ...editing, lines });
                        }} className="mt-1 h-8 text-xs" />
                      </div>
                      <div className="col-span-2">
                        <Label className="text-[10px]">Qté</Label>
                        <Input type="number" min={0} step="0.01" value={line.quantity} onChange={e => {
                          const lines = [...(editing.lines ?? [])];
                          lines[i] = { ...line, quantity: parseFloat(e.target.value || '0') };
                          setEditing({ ...editing, lines });
                        }} className="mt-1 h-8 text-xs" />
                      </div>
                      <div className="col-span-2">
                        <Label className="text-[10px]">PU HT</Label>
                        <Input type="number" min={0} step="0.01" value={line.unit_price} onChange={e => {
                          const lines = [...(editing.lines ?? [])];
                          lines[i] = { ...line, unit_price: parseFloat(e.target.value || '0') };
                          setEditing({ ...editing, lines });
                        }} className="mt-1 h-8 text-xs" />
                      </div>
                      <div className="col-span-2">
                        <Label className="text-[10px]">TVA</Label>
                        <Select value={String(line.tva_rate)} onValueChange={v => {
                          const lines = [...(editing.lines ?? [])];
                          lines[i] = { ...line, tva_rate: parseFloat(v) };
                          setEditing({ ...editing, lines });
                        }}>
                          <SelectTrigger className="mt-1 h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {[0, 2.1, 5.5, 10, 20].map(r => <SelectItem key={r} value={String(r)}>{r}%</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="col-span-1 flex justify-end">
                        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-red-400" onClick={() => {
                          const lines = (editing.lines ?? []).filter((_, j) => j !== i);
                          setEditing({ ...editing, lines: lines.length ? lines : [newLine()] });
                        }}><Trash2 className="w-3 h-3" /></Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {totals && (
                <div className="rounded-lg bg-secondary/30 border border-border p-3 text-xs space-y-1">
                  <div className="flex justify-between"><span className="text-muted-foreground">Total HT</span><span className="font-medium text-foreground">{formatEUR(totals.total_ht)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">TVA</span><span className="font-medium text-foreground">{formatEUR(totals.total_tva)}</span></div>
                  <div className="flex justify-between text-sm pt-1 border-t border-border"><span className="font-semibold text-foreground">Total TTC</span><span className="font-orbitron font-bold text-accent-cyan">{formatEUR(totals.total_ttc)}</span></div>
                </div>
              )}

              <div>
                <Label className="text-xs">Notes</Label>
                <Textarea rows={2} value={editing.notes ?? ''} onChange={e => setEditing({ ...editing, notes: e.target.value })} className="mt-1.5" />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Annuler</Button>
            <Button onClick={handleSave} disabled={busy || !editing?.counterpart_name?.trim()}>
              {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Enregistrer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
