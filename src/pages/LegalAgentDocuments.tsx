import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Loader2, Plus, Trash2, FileText, Sparkles, Eye, Send } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
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
import {
  listDocuments, generateDocument, deleteDocument, sendDocumentForSignature,
  DOCUMENT_TYPES, CATEGORIES,
  type LegalDocument,
} from '@/lib/legal';

export default function LegalAgentDocuments() {
  const { user } = useAuth();
  const [docs, setDocs] = useState<LegalDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [genType, setGenType] = useState('cdi');
  const [genBrief, setGenBrief] = useState('');
  const [generating, setGenerating] = useState(false);
  const [selected, setSelected] = useState<LegalDocument | null>(null);
  const [sending, setSending] = useState(false);
  const [signerName, setSignerName] = useState('');
  const [signerEmail, setSignerEmail] = useState('');

  const refresh = async () => {
    if (!user) return;
    setLoading(true);
    try { setDocs(await listDocuments(user.id)); }
    catch (e) { toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setLoading(false); }
  };
  useEffect(() => { refresh(); /* eslint-disable-line */ }, [user?.id]);

  const handleGenerate = async () => {
    if (!genBrief.trim()) {
      toast.error('Décris ce que tu veux');
      return;
    }
    setGenerating(true);
    try {
      const doc = await generateDocument({ type: genType, brief: genBrief });
      toast.success('✅ Document généré', { description: doc.title });
      setGenerateOpen(false);
      setGenBrief('');
      refresh();
      setSelected(doc);
    } catch (e) {
      toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
    } finally { setGenerating(false); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Supprimer ce document ?')) return;
    try { await deleteDocument(id); toast.success('Supprimé'); refresh(); }
    catch (e) { toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) }); }
  };

  const handleSendSignature = async () => {
    if (!selected || !signerName.trim() || !signerEmail.trim()) return;
    setSending(true);
    try {
      await sendDocumentForSignature(selected.id, [{ name: signerName, email: signerEmail }]);
      toast.success('✅ Envoyé pour signature DocuSeal');
      setSignerName('');
      setSignerEmail('');
      setSelected(null);
      refresh();
    } catch (e) {
      toast.error('Erreur DocuSeal', { description: e instanceof Error ? e.message : String(e) });
    } finally { setSending(false); }
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between">
        <div>
          <Link to="/dashboard/legal-agent" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-1">
            <ArrowLeft className="w-3 h-3" /> Retour
          </Link>
          <h1 className="text-2xl font-orbitron font-bold text-foreground flex items-center gap-2">
            <FileText className="w-6 h-6 text-accent-cyan" /> Documents juridiques
          </h1>
        </div>
        <Button onClick={() => setGenerateOpen(true)}>
          <Sparkles className="w-4 h-4 mr-2" /> Générer un document
        </Button>
      </motion.div>

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-accent-cyan" /></div>
      ) : docs.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            Aucun document. Clique « Générer un document » pour créer ton premier contrat.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {docs.map(d => {
            const cat = CATEGORIES.find(c => c.value === d.category);
            return (
              <Card key={d.id} className="bg-card border-border">
                <CardContent className="p-4 flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-accent-cyan/10 flex items-center justify-center flex-shrink-0">
                    {cat ? <span className="text-lg">{cat.emoji}</span> : <FileText className="w-5 h-5 text-accent-cyan" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-foreground truncate">{d.title}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {d.type} · {new Date(d.created_at).toLocaleDateString('fr-FR')}
                      {d.related_contact && ` · ${d.related_contact}`}
                    </p>
                  </div>
                  <Badge variant="outline" className="text-[10px]">{d.status}</Badge>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="icon" onClick={() => setSelected(d)}><Eye className="w-4 h-4" /></Button>
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(d.id)} className="text-red-400"><Trash2 className="w-4 h-4" /></Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Generate dialog */}
      <Dialog open={generateOpen} onOpenChange={setGenerateOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-accent-purple" /> Générer un document juridique
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Type de document</Label>
              <Select value={genType} onValueChange={setGenType}>
                <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-72">
                  {CATEGORIES.map(c => (
                    <div key={c.value}>
                      <div className="px-2 py-1 text-[10px] text-muted-foreground">{c.emoji} {c.label}</div>
                      {DOCUMENT_TYPES.filter(t => t.category === c.value).map(t => (
                        <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                      ))}
                    </div>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Décris ce que tu veux</Label>
              <Textarea
                rows={5}
                value={genBrief}
                onChange={e => setGenBrief(e.target.value)}
                className="mt-1.5"
                placeholder="Ex : Contrat de prestation pour un développeur freelance, 500€/jour, mission de 3 mois, clause de non-concurrence 6 mois, paiement 30 jours fin de mois…"
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                L'IA génère un document complet, conforme au droit français, prêt à signer.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGenerateOpen(false)}>Annuler</Button>
            <Button onClick={handleGenerate} disabled={generating || !genBrief.trim()}>
              {generating && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Générer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Document viewer + send-for-signature */}
      {selected && (
        <div className="fixed inset-0 z-[10000] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setSelected(null)}>
          <div className="bg-card border border-border rounded-2xl max-w-3xl w-full max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="p-5 border-b border-border flex items-start justify-between gap-3">
              <div>
                <p className="text-xs text-muted-foreground mb-1">{selected.type}</p>
                <h3 className="text-lg font-semibold text-foreground">{selected.title}</h3>
              </div>
              <Badge variant="outline">{selected.status}</Badge>
            </div>
            <div className="p-5 prose prose-sm prose-invert max-w-none">
              <ReactMarkdown>{selected.content_html}</ReactMarkdown>
            </div>
            {selected.ai_analysis && (
              <div className="px-5 pb-5">
                <div className="rounded-lg bg-accent-purple/5 border border-accent-purple/20 p-3">
                  <p className="text-[10px] uppercase text-muted-foreground mb-1">Analyse IA</p>
                  <p className="text-xs text-foreground/80 italic">{selected.ai_analysis}</p>
                </div>
              </div>
            )}
            <div className="border-t border-border p-5 space-y-3">
              <p className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Send className="w-4 h-4 text-accent-purple" /> Envoyer pour signature DocuSeal
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Input placeholder="Nom du signataire" value={signerName} onChange={e => setSignerName(e.target.value)} />
                <Input type="email" placeholder="Email" value={signerEmail} onChange={e => setSignerEmail(e.target.value)} />
              </div>
              <Button onClick={handleSendSignature} disabled={sending || !signerName.trim() || !signerEmail.trim()} className="w-full">
                {sending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Envoyer pour signature
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
