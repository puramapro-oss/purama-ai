import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Loader2, Users, Trash2, Pencil, Search } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import {
  listMemory, updateMemory, deleteMemory, type EmailAgentMemory,
} from '@/lib/email-agent';

const RELATIONS = ['client', 'partenaire', 'fournisseur', 'institution', 'ami', 'inconnu'];

export default function EmailAgentMemoryPage() {
  const { user } = useAuth();
  const [memory, setMemory] = useState<EmailAgentMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EmailAgentMemory | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    if (!user) return;
    setLoading(true);
    try { setMemory(await listMemory(user.id)); }
    catch (e) { toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setLoading(false); }
  };
  useEffect(() => { refresh(); /* eslint-disable-line */ }, [user?.id]);

  const filtered = memory.filter(m => {
    const q = search.toLowerCase();
    return !q || m.contact_email.toLowerCase().includes(q) || (m.contact_name ?? '').toLowerCase().includes(q);
  });

  const handleSave = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await updateMemory(editing.id, {
        contact_name: editing.contact_name,
        relationship: editing.relationship,
        preferred_tone: editing.preferred_tone,
        context_notes: editing.context_notes,
        auto_reply_ok: editing.auto_reply_ok,
        is_blocked: editing.is_blocked,
      });
      toast.success('✅ Contact mis à jour');
      setEditing(null);
      refresh();
    } catch (e) { toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Supprimer ce contact de la mémoire ?')) return;
    try { await deleteMemory(id); toast.success('Supprimé'); refresh(); }
    catch (e) { toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) }); }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto pb-12">
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}>
        <Link to="/dashboard/email-agent" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-1">
          <ArrowLeft className="w-3 h-3" /> Retour
        </Link>
        <h1 className="text-2xl font-orbitron font-bold text-foreground flex items-center gap-2">
          <Users className="w-6 h-6 text-accent-cyan" /> Mémoire des contacts
        </h1>
        <p className="text-sm text-muted-foreground">Ce que ton agent sait sur tes interlocuteurs.</p>
      </motion.div>

      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input placeholder="Rechercher un contact…" value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
      </div>

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-accent-cyan" /></div>
      ) : filtered.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            Aucun contact en mémoire.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map(m => (
            <Card key={m.id} className="bg-card border-border">
              <CardContent className="p-4 flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-gradient-to-r from-accent-purple to-accent-cyan flex items-center justify-center text-sm font-bold text-foreground flex-shrink-0">
                  {(m.contact_name || m.contact_email)[0].toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">
                    {m.contact_name || m.contact_email}
                  </p>
                  <p className="text-[11px] text-muted-foreground truncate">{m.contact_email}</p>
                  <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                    {m.relationship && <Badge variant="outline" className="text-[10px] py-0 h-4">{m.relationship}</Badge>}
                    <span className="text-[10px] text-muted-foreground">{m.interaction_count} échanges</span>
                    {m.is_blocked && <Badge className="bg-red-500/15 text-red-400 border-red-500/30 text-[10px]">Bloqué</Badge>}
                    {!m.auto_reply_ok && <Badge variant="secondary" className="text-[10px]">Pas d'auto-reply</Badge>}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" onClick={() => setEditing(m)}><Pencil className="w-4 h-4" /></Button>
                  <Button variant="ghost" size="icon" onClick={() => handleDelete(m.id)} className="text-red-400"><Trash2 className="w-4 h-4" /></Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!editing} onOpenChange={o => !o && setEditing(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Éditer le contact</DialogTitle></DialogHeader>
          {editing && (
            <div className="space-y-3">
              <div>
                <Label className="text-xs">Nom</Label>
                <Input value={editing.contact_name ?? ''} onChange={e => setEditing({ ...editing, contact_name: e.target.value })} className="mt-1.5" />
              </div>
              <div>
                <Label className="text-xs">Email</Label>
                <Input value={editing.contact_email} disabled className="mt-1.5" />
              </div>
              <div>
                <Label className="text-xs">Relation</Label>
                <Select value={editing.relationship ?? ''} onValueChange={v => setEditing({ ...editing, relationship: v })}>
                  <SelectTrigger className="mt-1.5"><SelectValue placeholder="Choisir…" /></SelectTrigger>
                  <SelectContent>
                    {RELATIONS.map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Notes</Label>
                <Textarea rows={3} value={editing.context_notes ?? ''} onChange={e => setEditing({ ...editing, context_notes: e.target.value })} className="mt-1.5" placeholder="Ce que l'agent doit savoir sur ce contact…" />
              </div>
              <div className="flex items-center justify-between pt-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Autoriser les réponses auto</p>
                  <p className="text-[11px] text-muted-foreground">Si désactivé : toujours en brouillon.</p>
                </div>
                <Switch checked={editing.auto_reply_ok} onCheckedChange={v => setEditing({ ...editing, auto_reply_ok: v })} />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-foreground">Bloquer ce contact</p>
                  <p className="text-[11px] text-muted-foreground">L'agent ignorera tous ses emails.</p>
                </div>
                <Switch checked={editing.is_blocked} onCheckedChange={v => setEditing({ ...editing, is_blocked: v })} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Annuler</Button>
            <Button onClick={handleSave} disabled={busy}>
              {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Enregistrer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
