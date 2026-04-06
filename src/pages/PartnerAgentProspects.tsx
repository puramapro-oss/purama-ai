import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft, Loader2, Plus, Trash2, Send, Search, Filter, Pencil,
  ExternalLink, Sparkles, Users,
} from 'lucide-react';
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
  listProspects, createProspect, updateProspect, deleteProspect,
  findProspects, sendOutreach,
  STATUS_META, PROSPECT_TYPES, NICHES,
  type PartnerProspect, type ProspectStatus, type ProspectType,
} from '@/lib/partner';

const newProspect = (): Partial<PartnerProspect> => ({
  name: '',
  email: '',
  website: '',
  type: 'influencer',
  niche: '',
  status: 'identified',
  source: 'manual',
  social_links: {},
  tags: [],
});

export default function PartnerAgentProspects() {
  const { user } = useAuth();
  const [prospects, setProspects] = useState<PartnerProspect[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | ProspectStatus>('all');
  const [editing, setEditing] = useState<Partial<PartnerProspect> | null>(null);
  const [busy, setBusy] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findNiche, setFindNiche] = useState('');
  const [findType, setFindType] = useState<ProspectType>('influencer');
  const [finding, setFinding] = useState(false);

  const refresh = async () => {
    if (!user) return;
    setLoading(true);
    try {
      setProspects(await listProspects(user.id));
    } catch (e) {
      toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { refresh(); /* eslint-disable-line */ }, [user?.id]);

  const filtered = prospects.filter(p => {
    if (statusFilter !== 'all' && p.status !== statusFilter) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return p.name.toLowerCase().includes(q)
      || (p.email ?? '').toLowerCase().includes(q)
      || (p.website ?? '').toLowerCase().includes(q)
      || (p.niche ?? '').toLowerCase().includes(q);
  });

  const handleSave = async () => {
    if (!user || !editing || !editing.name?.trim()) return;
    setBusy(true);
    try {
      if (editing.id) {
        const { id, user_id, created_at, updated_at, ...patch } = editing as PartnerProspect;
        void user_id; void created_at; void updated_at;
        await updateProspect(id, patch);
      } else {
        await createProspect(user.id, editing);
      }
      toast.success('✅ Enregistré');
      setEditing(null);
      refresh();
    } catch (e) {
      toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Supprimer ce prospect ?')) return;
    try { await deleteProspect(id); toast.success('Supprimé'); refresh(); }
    catch (e) { toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) }); }
  };

  const handleSend = async (p: PartnerProspect) => {
    if (!p.email) {
      toast.error('Pas d\'email pour ce prospect');
      return;
    }
    if (!confirm(`Envoyer un email d'outreach IA à ${p.name} (${p.email}) ?`)) return;
    try {
      await sendOutreach(p.id);
      toast.success('✅ Email envoyé', { description: 'L\'IA a rédigé et envoyé un message personnalisé' });
      refresh();
    } catch (e) {
      toast.error('Erreur d\'envoi', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const handleFind = async () => {
    if (!findQuery.trim()) return;
    setFinding(true);
    try {
      const result = await findProspects(findQuery, findNiche || undefined, findType);
      toast.success(`✨ ${result.inserted} prospects ajoutés`);
      setFindOpen(false);
      setFindQuery('');
      refresh();
    } catch (e) {
      toast.error('Erreur recherche', { description: e instanceof Error ? e.message : String(e) });
    } finally { setFinding(false); }
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto pb-12">
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <Link to="/dashboard/partner-agent" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-1">
            <ArrowLeft className="w-3 h-3" /> Retour
          </Link>
          <h1 className="text-2xl font-orbitron font-bold text-foreground flex items-center gap-2">
            <Users className="w-6 h-6 text-accent-cyan" /> Prospects
          </h1>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setFindOpen(true)}>
            <Sparkles className="w-4 h-4 mr-2" /> Trouver via IA
          </Button>
          <Button onClick={() => setEditing(newProspect())}>
            <Plus className="w-4 h-4 mr-2" /> Ajouter
          </Button>
        </div>
      </motion.div>

      <div className="flex gap-2 items-center flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Rechercher…" value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
        </div>
        <Filter className="w-4 h-4 text-muted-foreground" />
        <Select value={statusFilter} onValueChange={v => setStatusFilter(v as 'all' | ProspectStatus)}>
          <SelectTrigger className="w-[200px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tous les statuts</SelectItem>
            {Object.entries(STATUS_META).map(([k, m]) => (
              <SelectItem key={k} value={k}>{m.emoji} {m.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-accent-cyan" /></div>
      ) : filtered.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            Aucun prospect. Clique « Trouver via IA » pour démarrer.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map(p => {
            const meta = STATUS_META[p.status];
            return (
              <Card key={p.id} className="bg-card border-border">
                <CardContent className="p-4 flex items-start gap-3">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-accent-purple to-accent-cyan flex items-center justify-center text-sm font-bold text-foreground flex-shrink-0">
                    {p.name[0]?.toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-foreground truncate">{p.name}</p>
                      <Badge variant="outline" className={`text-[10px] ${meta.color}`}>
                        {meta.emoji} {meta.label}
                      </Badge>
                      {p.niche && <Badge variant="secondary" className="text-[10px]">{p.niche}</Badge>}
                      {p.found_by_ai && <span className="text-[10px] text-accent-purple">✨ IA</span>}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {p.email && <span>{p.email}</span>}
                      {p.website && <span> · <a href={p.website} target="_blank" rel="noreferrer" className="hover:text-accent-cyan">{p.website.replace(/^https?:\/\//, '')}</a></span>}
                      {p.followers_count && <span> · {p.followers_count.toLocaleString('fr-FR')} followers</span>}
                    </p>
                    {p.ai_reasoning && (
                      <p className="text-[10px] italic text-accent-purple/80 mt-1 truncate">💭 {p.ai_reasoning}</p>
                    )}
                    {p.ai_score !== null && (
                      <div className="mt-1.5 flex items-center gap-2">
                        <div className="h-1 w-24 bg-secondary rounded-full overflow-hidden">
                          <div className="h-full bg-gradient-to-r from-accent-purple to-accent-cyan" style={{ width: `${p.ai_score}%` }} />
                        </div>
                        <span className="text-[10px] text-muted-foreground">Score {p.ai_score}/100</span>
                      </div>
                    )}
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    {p.email && p.status !== 'active' && p.status !== 'rejected' && (
                      <Button variant="ghost" size="icon" onClick={() => handleSend(p)} title="Envoyer outreach IA">
                        <Send className="w-4 h-4 text-accent-purple" />
                      </Button>
                    )}
                    {p.website && (
                      <a href={p.website} target="_blank" rel="noreferrer">
                        <Button variant="ghost" size="icon" title="Ouvrir le site"><ExternalLink className="w-4 h-4" /></Button>
                      </a>
                    )}
                    <Button variant="ghost" size="icon" onClick={() => setEditing(p)}><Pencil className="w-4 h-4" /></Button>
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(p.id)} className="text-red-400"><Trash2 className="w-4 h-4" /></Button>
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
            <DialogTitle>{editing?.id ? 'Modifier le prospect' : 'Nouveau prospect'}</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Nom</Label>
                  <Input value={editing.name ?? ''} onChange={e => setEditing({ ...editing, name: e.target.value })} className="mt-1.5" />
                </div>
                <div>
                  <Label className="text-xs">Email</Label>
                  <Input type="email" value={editing.email ?? ''} onChange={e => setEditing({ ...editing, email: e.target.value })} className="mt-1.5" />
                </div>
              </div>
              <div>
                <Label className="text-xs">Site web</Label>
                <Input value={editing.website ?? ''} onChange={e => setEditing({ ...editing, website: e.target.value })} className="mt-1.5" placeholder="https://…" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Type</Label>
                  <Select value={editing.type ?? 'influencer'} onValueChange={(v: ProspectType) => setEditing({ ...editing, type: v })}>
                    <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {PROSPECT_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.emoji} {t.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Niche</Label>
                  <Input value={editing.niche ?? ''} onChange={e => setEditing({ ...editing, niche: e.target.value })} className="mt-1.5" placeholder="fitness, finance…" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Followers</Label>
                  <Input type="number" value={editing.followers_count ?? ''} onChange={e => setEditing({ ...editing, followers_count: e.target.value ? parseInt(e.target.value, 10) : null })} className="mt-1.5" />
                </div>
                <div>
                  <Label className="text-xs">Statut</Label>
                  <Select value={editing.status ?? 'identified'} onValueChange={v => setEditing({ ...editing, status: v as ProspectStatus })}>
                    <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(STATUS_META).map(([k, m]) => <SelectItem key={k} value={k}>{m.emoji} {m.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label className="text-xs">Notes</Label>
                <Textarea rows={3} value={editing.notes ?? ''} onChange={e => setEditing({ ...editing, notes: e.target.value })} className="mt-1.5" />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Annuler</Button>
            <Button onClick={handleSave} disabled={busy || !editing?.name?.trim()}>
              {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Enregistrer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* AI Find */}
      <Dialog open={findOpen} onOpenChange={setFindOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-accent-purple" /> Recherche IA de prospects
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Requête</Label>
              <Input
                value={findQuery}
                onChange={e => setFindQuery(e.target.value)}
                placeholder="ex : meilleurs influenceurs finance personnelle France"
                className="mt-1.5"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Type</Label>
                <Select value={findType} onValueChange={(v: ProspectType) => setFindType(v)}>
                  <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PROSPECT_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.emoji} {t.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Niche</Label>
                <Select value={findNiche} onValueChange={setFindNiche}>
                  <SelectTrigger className="mt-1.5"><SelectValue placeholder="Toutes" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Toutes</SelectItem>
                    {NICHES.map(n => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              L'IA combine Tavily Search + Claude pour identifier des prospects qualifiés et les scorer 0-100.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFindOpen(false)}>Annuler</Button>
            <Button onClick={handleFind} disabled={finding || !findQuery.trim()}>
              {finding && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Lancer la recherche
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
