import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft, Loader2, Plus, Trash2, Send, Search, Filter, Pencil,
  ExternalLink, Sparkles, Users, FileSignature,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
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
  findProspects, sendOutreach, approveOutreach, outreachFeedback, outreachStepForStatus,
  generateContract, previewContract, approveContract, contractFeedback,
  STATUS_META, PROSPECT_TYPES, NICHES,
  type PartnerProspect, type ProspectStatus, type ProspectType, type OutreachApproval, type PartnerContractResult,
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
  const [searchParams, setSearchParams] = useSearchParams();
  const currentUser = useRef(user?.id);
  const accountEpoch = useRef(0);
  if (currentUser.current !== user?.id) accountEpoch.current += 1;
  currentUser.current = user?.id;
  const mounted = useRef(true);
  const refreshSequence = useRef(0);
  const contractRequests = useRef(new Set<string>());
  const openedContractLink = useRef<string | null>(null);
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
  const [pendingApproval, setPendingApproval] = useState<{ ownerId: string; emailId: string; preview: OutreachApproval } | null>(null);
  const [approving, setApproving] = useState(false);
  const [contractReview, setContractReview] = useState<{ ownerId: string; prospectId: string; result: PartnerContractResult } | null>(null);
  const [contractBusy, setContractBusy] = useState<string | null>(null);
  const [contractRead, setContractRead] = useState<string | null>(null);
  const contractReviewKey = contractReview?.result.status === 'pending_approval'
    ? `${contractReview.ownerId}:${contractReview.prospectId}:${contractReview.result.approval.version}:${contractReview.result.approval.pdf_sha256}`
    : null;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; refreshSequence.current += 1; };
  }, []);

  const refresh = async () => {
    if (!user) return;
    const ownerId = user.id;
    const epoch = accountEpoch.current;
    const sequence = ++refreshSequence.current;
    setLoading(true);
    try {
      const result = await listProspects(ownerId);
      if (mounted.current && currentUser.current === ownerId && epoch === accountEpoch.current && sequence === refreshSequence.current) setProspects(result);
    } catch (e) {
      if (mounted.current && currentUser.current === ownerId && epoch === accountEpoch.current && sequence === refreshSequence.current) {
        toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      if (mounted.current && currentUser.current === ownerId && epoch === accountEpoch.current && sequence === refreshSequence.current) setLoading(false);
    }
  };
  useEffect(() => {
    setProspects([]);
    setEditing(null);
    setPendingApproval(null);
    setApproving(false);
    setContractReview(null);
    setContractRead(null);
    setContractBusy(null);
    openedContractLink.current = null;
    refresh(); // Every result is checked against the account and the latest request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const filtered = prospects.filter(p => {
    if (p.user_id !== user?.id) return false;
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

  const handleContract = async (p: PartnerProspect, previewOnly = false) => {
    if (!user || p.user_id !== user.id) return;
    if (!p.email) {
      toast.error('Pas d\'email pour ce prospect');
      return;
    }
    const ownerId = user.id;
    const epoch = accountEpoch.current;
    const requestKey = `${ownerId}:${epoch}`;
    if (contractRequests.current.has(requestKey)) return;
    contractRequests.current.add(requestKey);
    setContractBusy(p.id);
    setContractRead(null);
    try {
      const result = await (previewOnly ? previewContract(p.id) : generateContract(p.id));
      if (!mounted.current || currentUser.current !== ownerId || epoch !== accountEpoch.current) return;
      setContractReview({ ownerId, prospectId: p.id, result });
      const feedback = contractFeedback(result);
      toast[feedback.kind](feedback.title, { description: feedback.description });
    } catch (e) {
      if (mounted.current && currentUser.current === ownerId && epoch === accountEpoch.current) {
        toast.error('Aperçu du contrat indisponible', { description: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      contractRequests.current.delete(requestKey);
      if (mounted.current && currentUser.current === ownerId && epoch === accountEpoch.current) setContractBusy(null);
    }
  };

  const handleApproveContract = async () => {
    const review = contractReview;
    const epoch = accountEpoch.current;
    if (!review || review.result.status !== 'pending_approval' || !contractReviewKey
      || contractRead !== contractReviewKey || review.ownerId !== user?.id) return;
    const requestKey = `${review.ownerId}:${epoch}`;
    if (contractRequests.current.has(requestKey)) return;
    contractRequests.current.add(requestKey);
    setContractBusy(review.prospectId);
    setContractRead(null);
    try {
      const { version, pdf_sha256 } = review.result.approval;
      const result = await approveContract(review.prospectId, version, pdf_sha256);
      if (!mounted.current || currentUser.current !== review.ownerId || epoch !== accountEpoch.current) return;
      setContractReview({ ...review, result });
      const feedback = contractFeedback(result);
      toast[feedback.kind](feedback.title, { description: feedback.description });
      void refresh();
    } catch {
      if (!mounted.current || currentUser.current !== review.ownerId || epoch !== accountEpoch.current) return;
      // A lost response can follow provider acceptance. Offer only a status read.
      setContractReview({ ...review, result: { status: 'unknown', contract_id: review.result.contract_id,
        reused: true, reason: 'response_unconfirmed' } });
      toast.warning('Envoi du contrat à vérifier', {
        description: 'La réponse n’a pas pu être confirmée. Vérifiez l’état du contrat avant toute autre action.',
      });
    } finally {
      contractRequests.current.delete(requestKey);
      if (mounted.current && currentUser.current === review.ownerId && epoch === accountEpoch.current) setContractBusy(null);
    }
  };

  const linkedProspect = searchParams.get('contractProspect');
  useEffect(() => {
    if (!user || loading || !linkedProspect) return;
    const key = `${user.id}:${linkedProspect}`;
    if (openedContractLink.current === key) return;
    const prospect = prospects.find(p => p.id === linkedProspect && p.user_id === user.id);
    if (!prospect) return;
    openedContractLink.current = key;
    const next = new URLSearchParams(searchParams);
    next.delete('contractProspect');
    setSearchParams(next, { replace: true });
    void handleContract(prospect, true);
    // Opening a link only reads the existing contract. It cannot prepare or send it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, loading, linkedProspect, prospects]);

  const handleSend = async (p: PartnerProspect) => {
    if (!user || p.user_id !== user.id) return;
    const ownerId = user.id;
    const epoch = accountEpoch.current;
    const step = outreachStepForStatus(p.status);
    if (!step) return;
    if (!p.email) {
      toast.error('Pas d\'email pour ce prospect');
      return;
    }
    const label = step === 'outreach' ? 'un premier email de partenariat' : `la relance ${step.slice(-1)}`;
    if (!confirm(`Envoyer ${label} à ${p.name} (${p.email}) ?`)) return;
    try {
      const result = await sendOutreach(p.id, step);
      if (!mounted.current || currentUser.current !== ownerId || accountEpoch.current !== epoch) return;
      const feedback = outreachFeedback(result);
      toast[feedback.kind](feedback.title, { description: feedback.description });
      if (result.status === 'pending_approval' && result.email_id && result.approval) {
        setPendingApproval({ ownerId, emailId: result.email_id, preview: result.approval });
      }
      refresh();
    } catch (e) {
      if (mounted.current && currentUser.current === ownerId && accountEpoch.current === epoch) {
        toast.error('Erreur d\'envoi', { description: e instanceof Error ? e.message : String(e) });
      }
    }
  };

  const handleApprove = async () => {
    if (!pendingApproval || approving || pendingApproval.ownerId !== user?.id) return;
    const ownerId = pendingApproval.ownerId;
    const epoch = accountEpoch.current;
    setApproving(true);
    try {
      const result = await approveOutreach(pendingApproval.emailId, pendingApproval.preview.version);
      if (!mounted.current || currentUser.current !== ownerId || accountEpoch.current !== epoch) return;
      const feedback = outreachFeedback(result);
      toast[feedback.kind](feedback.title, { description: feedback.description });
      if (result.status === 'pending_approval' && result.email_id && result.approval) {
        setPendingApproval({ ownerId, emailId: result.email_id, preview: result.approval });
      } else {
        setPendingApproval(null);
      }
      refresh();
    } catch (e) {
      if (mounted.current && currentUser.current === ownerId && accountEpoch.current === epoch) {
        toast.error('Validation non confirmée', { description: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      if (mounted.current && currentUser.current === ownerId && accountEpoch.current === epoch) setApproving(false);
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
            const nextStep = outreachStepForStatus(p.status);
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
                    {p.email && nextStep && (
                      <Button variant="ghost" size="icon" onClick={() => handleSend(p)} title={nextStep === 'outreach' ? 'Premier email de partenariat' : `Relance ${nextStep.slice(-1)}`}>
                        <Send className="w-4 h-4 text-accent-purple" />
                      </Button>
                    )}
                    {p.email && (p.status === 'interested' || p.status === 'contract_sent') && (
                      <Button variant="ghost" size="icon" disabled={!!contractBusy}
                        onClick={() => handleContract(p, p.status === 'contract_sent')}
                        title={p.status === 'contract_sent' ? 'Vérifier le contrat' : 'Préparer le contrat'}>
                        {contractBusy === p.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSignature className="w-4 h-4 text-emerald-400" />}
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

      <Dialog open={!!contractReview && contractReview.ownerId === user?.id}
        onOpenChange={open => { if (!open && !contractBusy) { setContractReview(null); setContractRead(null); } }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" aria-describedby="contract-review-description">
          <DialogHeader><DialogTitle>Vérifier le contrat de partenariat</DialogTitle></DialogHeader>
          {contractReview && (
            <>
              <p id="contract-review-description" className="text-sm text-muted-foreground">
                {contractFeedback(contractReview.result).description}
              </p>
              {contractReview.result.status === 'pending_approval' && (
                <div className="space-y-4 text-sm">
                  <dl className="space-y-2">
                    <div><dt className="font-medium">Partenaire destinataire</dt><dd>{contractReview.result.approval.recipient_name} · {contractReview.result.approval.recipient_email}</dd></div>
                    <div><dt className="font-medium">Émetteur</dt><dd>{contractReview.result.approval.company_name} · {contractReview.result.approval.sender_name} · {contractReview.result.approval.sender_email}</dd></div>
                    <div><dt className="font-medium">Conditions figurant dans ce projet</dt>
                      <dd>{contractReview.result.approval.commission_first_payment.toLocaleString('fr-FR')} % au premier paiement · {contractReview.result.approval.commission_recurring.toLocaleString('fr-FR')} % récurrent</dd></div>
                  </dl>
                  <Button variant="outline" asChild>
                    <a href={contractReview.result.approval.pdf_url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="w-4 h-4 mr-2" /> Ouvrir le PDF à approuver
                    </a>
                  </Button>
                  <p className="text-xs text-muted-foreground">Le document complet doit être relu. La génération du projet ne vaut pas validation juridique.</p>
                  <details className="text-xs text-muted-foreground">
                    <summary>Identifier cette version du document</summary>
                    <p className="break-all mt-2">Version : {contractReview.result.approval.version}</p>
                    <p className="break-all">SHA-256 : {contractReview.result.approval.pdf_sha256}</p>
                  </details>
                  <div className="flex items-start gap-3 rounded-md border p-3">
                    <Checkbox id="contract-read" checked={contractRead !== null && contractRead === contractReviewKey} disabled={!!contractBusy}
                      onCheckedChange={checked => setContractRead(checked === true ? contractReviewKey : null)} />
                    <Label htmlFor="contract-read" className="text-sm leading-relaxed cursor-pointer">
                      J’ai relu ce PDF, vérifié les parties et les conditions, et j’autorise l’envoi de cette version à ce destinataire.
                    </Label>
                  </div>
                </div>
              )}
              {contractReview.result.status === 'sent' && (
                <div className="space-y-2 text-sm">
                  <p>Référence DocuSeal : {contractReview.result.docuseal_submission_id}</p>
                  {contractReview.result.pdf_url && <a className="underline" href={contractReview.result.pdf_url} target="_blank" rel="noopener noreferrer">Ouvrir le PDF du contrat</a>}
                </div>
              )}
              <DialogFooter className="gap-2">
                <Button variant="outline" disabled={!!contractBusy} onClick={() => { setContractReview(null); setContractRead(null); }}>Fermer</Button>
                <Button variant="outline" disabled={!!contractBusy} onClick={() => {
                  const p = prospects.find(value => value.id === contractReview.prospectId && value.user_id === user?.id);
                  if (p) void handleContract(p, true);
                }}>Vérifier l’état et l’aperçu</Button>
                {contractReview.result.status === 'pending_approval' && (
                  <Button disabled={contractRead === null || contractRead !== contractReviewKey || !!contractBusy} onClick={handleApproveContract}>
                    {contractBusy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Approuver ce PDF et envoyer
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

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

      <Dialog open={!!pendingApproval && pendingApproval.ownerId === user?.id} onOpenChange={open => { if (!open && !approving) setPendingApproval(null); }}>
        <DialogContent className="max-w-2xl" aria-describedby="outreach-approval-description">
          <DialogHeader><DialogTitle>Valider l’email</DialogTitle></DialogHeader>
          <p id="outreach-approval-description" className="text-sm text-muted-foreground">
            Vérifiez le destinataire et le message. Le bouton ci-dessous autorise uniquement cet email.
          </p>
          {pendingApproval && (
            <div className="space-y-2 text-sm">
              <p className="break-words"><strong>De :</strong> {pendingApproval.preview.from}</p>
              <p className="break-words"><strong>À :</strong> {pendingApproval.preview.to}</p>
              <p className="break-words"><strong>Objet :</strong> {pendingApproval.preview.subject}</p>
              <iframe
                title="Aperçu du message à valider"
                sandbox=""
                referrerPolicy="no-referrer"
                className="h-64 w-full rounded border bg-white"
                srcDoc={'<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;"></head><body>' + pendingApproval.preview.body_html + '</body></html>'}
              />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={approving} onClick={() => setPendingApproval(null)}>Plus tard</Button>
            <Button disabled={approving || !pendingApproval} onClick={handleApprove}>
              {approving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Approuver et envoyer
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
