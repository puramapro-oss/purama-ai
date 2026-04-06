import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft, Loader2, Filter, TrendingUp, TrendingDown, Search,
  CheckCircle2, AlertTriangle, Edit3,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import {
  listTransactions, updateTransaction, formatEUR,
  type ComptaTransaction,
} from '@/lib/compta';

const PCG_QUICK = [
  { code: '601000', label: 'Achats matières premières' },
  { code: '604000', label: 'Sous-traitance' },
  { code: '606100', label: 'Énergie (eau, élec, gaz)' },
  { code: '606300', label: 'Petit équipement' },
  { code: '606400', label: 'Fournitures de bureau' },
  { code: '613200', label: 'Loyer' },
  { code: '613500', label: 'Locations mobilières' },
  { code: '615500', label: 'Entretien et réparations' },
  { code: '616000', label: 'Assurances' },
  { code: '622600', label: 'Honoraires' },
  { code: '623000', label: 'Publicité, communication' },
  { code: '625100', label: 'Voyages, déplacements' },
  { code: '626000', label: 'Frais postaux et télécoms' },
  { code: '627000', label: 'Services bancaires' },
  { code: '641000', label: 'Rémunérations du personnel' },
  { code: '645000', label: 'Cotisations sociales' },
  { code: '706000', label: 'Prestations de services (vente)' },
  { code: '707000', label: 'Ventes de marchandises' },
  { code: '455000', label: 'Compte courant associé' },
];

const TVA_RATES = [0, 2.1, 5.5, 10, 20];

export default function ComptaAgentTransactions() {
  const { user } = useAuth();
  const [txs, setTxs] = useState<ComptaTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'pending' | 'anomaly' | 'credit' | 'debit'>('all');
  const [editing, setEditing] = useState<ComptaTransaction | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    if (!user) return;
    setLoading(true);
    try { setTxs(await listTransactions(user.id, { limit: 300 })); }
    catch (e) { toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setLoading(false); }
  };
  useEffect(() => { refresh(); /* eslint-disable-line */ }, [user?.id]);

  const filtered = txs.filter(t => {
    if (search && !t.description.toLowerCase().includes(search.toLowerCase()) && !(t.counterpart_name ?? '').toLowerCase().includes(search.toLowerCase())) return false;
    if (filter === 'pending') return (t.ai_confidence ?? 0) < 0.6 || !t.user_validated;
    if (filter === 'anomaly') return t.is_anomaly;
    if (filter === 'credit') return t.type === 'credit' || t.amount > 0;
    if (filter === 'debit') return t.type === 'debit' || t.amount < 0;
    return true;
  });

  const handleSave = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await updateTransaction(editing.id, {
        pcg_account: editing.pcg_account,
        pcg_label: editing.pcg_label,
        tva_rate: editing.tva_rate,
        tva_amount: editing.tva_amount,
        ht_amount: editing.ht_amount,
        tva_deductible: editing.tva_deductible,
        notes: editing.notes,
        user_validated: true,
        user_category_override: editing.pcg_account,
      });
      toast.success('✅ Transaction validée');
      setEditing(null);
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
        <h1 className="text-2xl font-orbitron font-bold text-foreground">Transactions</h1>
        <p className="text-sm text-muted-foreground">Catégorisation automatique par l'IA. Clique pour valider ou corriger.</p>
      </motion.div>

      <div className="flex gap-2 items-center flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Rechercher…" value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
        </div>
        <Filter className="w-4 h-4 text-muted-foreground" />
        <Select value={filter} onValueChange={v => setFilter(v as typeof filter)}>
          <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tout</SelectItem>
            <SelectItem value="pending">À valider</SelectItem>
            <SelectItem value="anomaly">Anomalies</SelectItem>
            <SelectItem value="credit">Recettes</SelectItem>
            <SelectItem value="debit">Dépenses</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-accent-cyan" /></div>
      ) : filtered.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            Aucune transaction.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map(tx => {
            const isCredit = tx.type === 'credit' || tx.amount > 0;
            const lowConfidence = (tx.ai_confidence ?? 0) < 0.6;
            return (
              <button
                key={tx.id}
                onClick={() => setEditing({ ...tx })}
                className={`w-full text-left flex items-center gap-3 p-4 rounded-lg border transition-all ${
                  tx.is_anomaly
                    ? 'border-yellow-500/30 bg-yellow-500/5 hover:bg-yellow-500/10'
                    : lowConfidence
                    ? 'border-orange-500/20 bg-orange-500/5 hover:bg-orange-500/10'
                    : 'border-border bg-card hover:bg-secondary/30'
                }`}
              >
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${isCredit ? 'bg-emerald-500/10' : 'bg-red-500/10'}`}>
                  {isCredit ? <TrendingUp className="w-5 h-5 text-emerald-400" /> : <TrendingDown className="w-5 h-5 text-red-400" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{tx.description}</p>
                  <div className="flex items-center gap-2 flex-wrap mt-0.5">
                    {tx.pcg_label && <Badge variant="outline" className="text-[10px] py-0 h-4">{tx.pcg_account} — {tx.pcg_label}</Badge>}
                    {tx.tva_rate !== null && <span className="text-[10px] text-muted-foreground">TVA {tx.tva_rate}%</span>}
                    {tx.user_validated && <CheckCircle2 className="w-3 h-3 text-emerald-400" />}
                    {tx.is_anomaly && <Badge className="bg-yellow-500/15 text-yellow-400 border-yellow-500/30 text-[10px]"><AlertTriangle className="w-2.5 h-2.5 mr-0.5" /> Anomalie</Badge>}
                  </div>
                  {tx.ai_reasoning && <p className="text-[10px] text-muted-foreground/70 italic mt-0.5 truncate">{tx.ai_reasoning}</p>}
                </div>
                <div className="text-right flex-shrink-0">
                  <p className={`text-sm font-semibold ${isCredit ? 'text-emerald-400' : 'text-foreground'}`}>
                    {isCredit ? '+' : ''}{formatEUR(tx.amount)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">{new Date(tx.date).toLocaleDateString('fr-FR')}</p>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Edit dialog */}
      <Dialog open={!!editing} onOpenChange={o => !o && setEditing(null)}>
        <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
          {editing && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Edit3 className="w-4 h-4" /> Catégoriser
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <div className="rounded-lg bg-secondary/30 border border-border p-3">
                  <p className="text-sm font-medium text-foreground">{editing.description}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {new Date(editing.date).toLocaleDateString('fr-FR')} · {formatEUR(editing.amount)}
                  </p>
                  {editing.ai_reasoning && (
                    <p className="text-[11px] italic text-accent-purple mt-2">💭 {editing.ai_reasoning}</p>
                  )}
                </div>
                <div>
                  <Label className="text-xs">Compte PCG</Label>
                  <Select
                    value={editing.pcg_account ?? ''}
                    onValueChange={v => {
                      const found = PCG_QUICK.find(p => p.code === v);
                      setEditing({ ...editing, pcg_account: v, pcg_label: found?.label ?? null });
                    }}
                  >
                    <SelectTrigger className="mt-1.5"><SelectValue placeholder="Choisir…" /></SelectTrigger>
                    <SelectContent className="max-h-72">
                      {PCG_QUICK.map(p => (
                        <SelectItem key={p.code} value={p.code}>
                          <span className="font-mono text-xs mr-2">{p.code}</span>{p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <Label className="text-xs">Taux TVA</Label>
                    <Select
                      value={String(editing.tva_rate ?? '20')}
                      onValueChange={v => {
                        const rate = parseFloat(v);
                        const ttc = Math.abs(editing.amount);
                        const ht = rate > 0 ? ttc / (1 + rate / 100) : ttc;
                        const tva = ttc - ht;
                        setEditing({ ...editing, tva_rate: rate, ht_amount: Math.round(ht * 100) / 100, tva_amount: Math.round(tva * 100) / 100 });
                      }}
                    >
                      <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {TVA_RATES.map(r => <SelectItem key={r} value={String(r)}>{r}%</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs">HT</Label>
                    <Input type="number" step="0.01" value={editing.ht_amount ?? ''} onChange={e => setEditing({ ...editing, ht_amount: parseFloat(e.target.value || '0') })} className="mt-1.5" />
                  </div>
                  <div>
                    <Label className="text-xs">TVA</Label>
                    <Input type="number" step="0.01" value={editing.tva_amount ?? ''} onChange={e => setEditing({ ...editing, tva_amount: parseFloat(e.target.value || '0') })} className="mt-1.5" />
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Notes</Label>
                  <Input value={editing.notes ?? ''} onChange={e => setEditing({ ...editing, notes: e.target.value })} className="mt-1.5" />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setEditing(null)}>Annuler</Button>
                <Button onClick={handleSave} disabled={busy}>
                  {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Valider
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
