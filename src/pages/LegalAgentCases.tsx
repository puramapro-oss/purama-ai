import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Loader2, Plus, Briefcase, Sparkles, AlertTriangle, Trash2 } from 'lucide-react';
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
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { listCases, buildCase, deleteCase, formatEUR, type LegalCase } from '@/lib/legal';

const CASE_TYPES = [
  { value: 'creation_entreprise', label: 'Création d\'entreprise' },
  { value: 'contentieux_commercial', label: 'Contentieux commercial' },
  { value: 'litige_travail', label: 'Litige travail' },
  { value: 'recouvrement', label: 'Recouvrement' },
  { value: 'propriete_intellectuelle', label: 'Propriété intellectuelle' },
  { value: 'rgpd_conformite', label: 'RGPD / Conformité' },
  { value: 'redressement_fiscal', label: 'Redressement fiscal' },
  { value: 'controle_urssaf', label: 'Contrôle URSSAF' },
  { value: 'bail', label: 'Bail / Immobilier' },
  { value: 'divorce', label: 'Divorce / Famille' },
  { value: 'succession', label: 'Succession' },
  { value: 'custom', label: 'Autre' },
];

const COLUMNS: { id: 'open' | 'in_progress' | 'waiting' | 'closed'; label: string }[] = [
  { id: 'open', label: 'Ouvert' },
  { id: 'in_progress', label: 'En cours' },
  { id: 'waiting', label: 'En attente' },
  { id: 'closed', label: 'Résolu' },
];

export default function LegalAgentCases() {
  const { user } = useAuth();
  const [cases, setCases] = useState<LegalCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [building, setBuilding] = useState(false);
  const [selected, setSelected] = useState<LegalCase | null>(null);
  const [newCase, setNewCase] = useState({
    title: '',
    type: 'contentieux_commercial',
    facts: '',
    parties: [{ name: '', role: 'demandeur', email: '' }],
  });

  const refresh = async () => {
    if (!user) return;
    setLoading(true);
    try { setCases(await listCases(user.id)); }
    catch (e) { toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setLoading(false); }
  };
  useEffect(() => { refresh(); /* eslint-disable-line */ }, [user?.id]);

  const handleBuild = async () => {
    if (!newCase.title.trim() || !newCase.facts.trim()) {
      toast.error('Renseigne le titre et les faits');
      return;
    }
    setBuilding(true);
    try {
      const c = await buildCase(newCase);
      toast.success('✅ Dossier monté par l\'IA');
      setOpen(false);
      setNewCase({ title: '', type: 'contentieux_commercial', facts: '', parties: [{ name: '', role: 'demandeur', email: '' }] });
      refresh();
      setSelected(c);
    } catch (e) {
      toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
    } finally { setBuilding(false); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Supprimer ce dossier ?')) return;
    try { await deleteCase(id); toast.success('Supprimé'); refresh(); }
    catch (e) { toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) }); }
  };

  const grouped: Record<string, LegalCase[]> = { open: [], in_progress: [], waiting: [], closed: [] };
  for (const c of cases) {
    const col = c.status === 'won' || c.status === 'lost' || c.status === 'settled' || c.status === 'closed'
      ? 'closed' : c.status;
    if (grouped[col]) grouped[col].push(c);
  }

  return (
    <div className="space-y-6 max-w-6xl mx-auto pb-12">
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between">
        <div>
          <Link to="/dashboard/legal-agent" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-1">
            <ArrowLeft className="w-3 h-3" /> Retour
          </Link>
          <h1 className="text-2xl font-orbitron font-bold text-foreground flex items-center gap-2">
            <Briefcase className="w-6 h-6 text-accent-purple" /> Dossiers
          </h1>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="w-4 h-4 mr-2" /> Nouveau dossier
        </Button>
      </motion.div>

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-accent-cyan" /></div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          {COLUMNS.map(col => (
            <div key={col.id} className="rounded-lg bg-secondary/20 border border-border p-3">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-foreground">{col.label}</p>
                <span className="text-[10px] text-muted-foreground">{grouped[col.id]?.length ?? 0}</span>
              </div>
              <div className="space-y-2 max-h-[60vh] overflow-y-auto">
                {(grouped[col.id] ?? []).length === 0 ? (
                  <p className="text-[10px] text-muted-foreground/60 italic">Vide</p>
                ) : grouped[col.id].map(c => (
                  <button
                    key={c.id}
                    onClick={() => setSelected(c)}
                    className="w-full text-left p-2.5 rounded-lg bg-card border border-border hover:border-accent-purple/30 transition-colors"
                  >
                    <div className="flex items-start gap-2">
                      <Briefcase className="w-3 h-3 text-accent-purple flex-shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-foreground truncate">{c.title}</p>
                        <p className="text-[10px] text-muted-foreground">{c.type}</p>
                        {c.priority === 'urgent' && <Badge className="text-[9px] mt-1 bg-red-500/15 text-red-400 border-red-500/30">URGENT</Badge>}
                        {c.ai_success_probability !== null && (
                          <p className="text-[10px] text-accent-purple mt-0.5">{c.ai_success_probability}% succès</p>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Build dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-accent-purple" /> Monter un dossier avec l'IA
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Titre</Label>
              <Input value={newCase.title} onChange={e => setNewCase({ ...newCase, title: e.target.value })} className="mt-1.5" />
            </div>
            <div>
              <Label className="text-xs">Type</Label>
              <Select value={newCase.type} onValueChange={v => setNewCase({ ...newCase, type: v })}>
                <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CASE_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Faits (sois précis)</Label>
              <Textarea
                rows={5}
                value={newCase.facts}
                onChange={e => setNewCase({ ...newCase, facts: e.target.value })}
                className="mt-1.5"
                placeholder="Décris la situation: dates, montants, ce qui s'est passé, ce que tu attends de l'autre partie…"
              />
            </div>
            <div className="rounded-lg bg-secondary/30 border border-border p-3 text-[11px] text-muted-foreground">
              <strong className="text-foreground">L'IA va générer:</strong> analyse complète, stratégie, arguments, jurisprudence pertinente, probabilité de succès, deadlines, prescription, risques.
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Annuler</Button>
            <Button onClick={handleBuild} disabled={building || !newCase.title.trim() || !newCase.facts.trim()}>
              {building && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Monter le dossier
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail */}
      {selected && (
        <div className="fixed inset-0 z-[10000] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setSelected(null)}>
          <div className="bg-card border border-border rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="p-5 border-b border-border flex items-start justify-between">
              <div>
                <h3 className="text-lg font-semibold text-foreground">{selected.title}</h3>
                <p className="text-xs text-muted-foreground">{selected.type} · {selected.status}</p>
              </div>
              <Button variant="ghost" size="icon" onClick={() => handleDelete(selected.id)} className="text-red-400">
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
            <div className="p-5 space-y-4">
              {selected.ai_success_probability !== null && (
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <p className="text-[10px] uppercase text-muted-foreground">Probabilité de succès</p>
                    <div className="h-2 bg-secondary rounded-full overflow-hidden mt-1">
                      <div className="h-full bg-gradient-to-r from-red-400 via-yellow-400 to-emerald-400" style={{ width: `${selected.ai_success_probability}%` }} />
                    </div>
                  </div>
                  <span className="text-2xl font-orbitron font-bold text-accent-purple">{selected.ai_success_probability}%</span>
                </div>
              )}
              {selected.ai_estimated_amount && (
                <div className="rounded-lg bg-emerald-500/5 border border-emerald-500/20 p-3">
                  <p className="text-[10px] uppercase text-muted-foreground">Montant estimé</p>
                  <p className="text-xl font-orbitron font-bold text-emerald-400">{formatEUR(Number(selected.ai_estimated_amount))}</p>
                </div>
              )}
              {selected.ai_analysis && (
                <div>
                  <p className="text-[10px] uppercase text-muted-foreground mb-1">Analyse</p>
                  <p className="text-xs text-foreground/80 whitespace-pre-wrap">{selected.ai_analysis}</p>
                </div>
              )}
              {selected.ai_strategy && (
                <div className="rounded-lg bg-accent-purple/5 border border-accent-purple/20 p-3">
                  <p className="text-[10px] uppercase text-muted-foreground mb-1">Stratégie recommandée</p>
                  <p className="text-xs text-foreground/80 whitespace-pre-wrap">{selected.ai_strategy}</p>
                </div>
              )}
              {selected.ai_arguments?.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase text-muted-foreground mb-1">Arguments</p>
                  <ul className="text-xs text-foreground/80 space-y-1">
                    {selected.ai_arguments.map((a, i) => <li key={i}>✓ {a}</li>)}
                  </ul>
                </div>
              )}
              {selected.ai_risks?.length > 0 && (
                <div className="rounded-lg bg-yellow-500/5 border border-yellow-500/20 p-3">
                  <p className="text-[10px] uppercase text-muted-foreground mb-1 flex items-center gap-1">
                    <AlertTriangle className="w-2.5 h-2.5" /> Risques
                  </p>
                  <ul className="text-xs text-foreground/80 space-y-1">
                    {selected.ai_risks.map((r, i) => <li key={i}>⚠️ {r}</li>)}
                  </ul>
                </div>
              )}
              {selected.ai_jurisprudence?.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase text-muted-foreground mb-1">Jurisprudence pertinente</p>
                  <div className="space-y-2">
                    {selected.ai_jurisprudence.map((j, i) => (
                      <div key={i} className="rounded-lg bg-secondary/30 border border-border p-2 text-xs">
                        <p className="font-medium text-foreground">{j.reference} — {j.court} ({j.date})</p>
                        <p className="text-muted-foreground mt-0.5">{j.summary}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {selected.prescription_date && (
                <div className="rounded-lg bg-red-500/5 border border-red-500/20 p-3 text-xs">
                  <p className="text-red-400 font-medium">⚖️ Prescription : {new Date(selected.prescription_date).toLocaleDateString('fr-FR')}</p>
                  {selected.prescription_type && <p className="text-muted-foreground mt-0.5">{selected.prescription_type}</p>}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
