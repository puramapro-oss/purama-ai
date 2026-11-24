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
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { PartnerReplyAction } from '@/components/partner/PartnerReplyAction';
import {
  listProspects, createProspect, updateProspect, deleteProspect,
  findProspects, partnerDiscoveryFeedback, sendOutreach, approveOutreach, outreachFeedback, outreachStepForStatus,
  qualifyProspect,
  generateContract, previewContract, approveContract, contractFeedback,
  STATUS_META, PROSPECT_TYPES, NICHES,
  type PartnerProspect, type ProspectStatus, type ProspectType, type OutreachApproval, type PartnerContractResult,
  type PartnerQualification, type PartnerOutreachProfile, type PartnerContactRole,
} from '@/lib/partner';

type QualificationDraft = {
  ownerId: string; prospectId: string; profile: PartnerOutreachProfile;
  role: Exclude<PartnerContactRole, 'unknown'>; sourceUrl: string; country: string; language: string;
  consentReference: string; consentDate: string; confirmed: boolean;
  offerName: string; offerUrl: string; offerSummary: string;
};
const ROLE_LABELS: Record<PartnerContactRole, string> = {
  unknown: 'Rôle à confirmer', editorial: 'Rédaction', commercial: 'Régie / service commercial', creator: 'Créateur', venue: 'Responsable de lieu',
};
const PROFILE_LABELS: Record<PartnerOutreachProfile, string> = {
  legacy: 'Partenariat existant', media_affiliate: 'Affiliation médias / lieux · 30 %', editorial: 'Sujet rédactionnel indépendant',
};
const QUALIFICATION_ERRORS: Record<string, string> = {
  authentication_required: 'Reconnectez-vous pour qualifier ce contact.',
  prospect_not_found: 'Ce contact n’est plus accessible sur ce compte.',
  contact_suppressed: 'Ce destinataire a fait opposition. Aucun nouvel envoi ne sera préparé.',
  qualification_invalid: 'Vérifiez les informations de qualification.',
  source_required: 'Renseignez la page source exacte des coordonnées.',
  contact_role_required: 'Confirmez la fonction du destinataire.',
  campaign_role_mismatch: 'Le type de proposition doit correspondre au rôle du destinataire.',
  provider_opt_in_required: 'L’accord explicite du destinataire est nécessaire pour ce service d’envoi.',
  consent_evidence_required: 'Ajoutez la référence précise de l’accord du destinataire.',
  invalid_consent_date: 'Vérifiez la date de l’accord du destinataire.',
  offer_required: 'Complétez le produit, sa page et sa présentation.',
};
function safePartnerWebLink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

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
  const findRequests = useRef(new Set<string>());
  const findRevision = useRef(0);
  const openedContractLink = useRef<string | null>(null);
  const [prospects, setProspects] = useState<PartnerProspect[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | ProspectStatus>('all');
  const [editing, setEditing] = useState<Partial<PartnerProspect> | null>(null);
  const [busy, setBusy] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findOwner, setFindOwner] = useState<{ ownerId: string | null; epoch: number } | null>(null);
  const [findQuery, setFindQuery] = useState('');
  const [findNiche, setFindNiche] = useState('');
  const [findType, setFindType] = useState<ProspectType>('influencer');
  const [finding, setFinding] = useState(false);
  const ownsFindForm = findOwner !== null && findOwner.ownerId === (user?.id ?? null)
    && findOwner.epoch === accountEpoch.current;
  const saveRequests = useRef(new Set<string>());
  const qualificationRequests = useRef(new Set<string>());
  const [qualification, setQualification] = useState<QualificationDraft | null>(null);
  const [qualifying, setQualifying] = useState(false);
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
    findRevision.current += 1;
    setFindOpen(false);
    setFindOwner(null);
    setFindQuery('');
    setFindNiche('');
    setFindType('influencer');
    setFinding(false);
    setQualification(null);
    setQualifying(false);
    setBusy(false);
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
    if (!user || !editing || editing.user_id !== user.id || !editing.name?.trim()) return;
    const ownerId = user.id;
    const epoch = accountEpoch.current;
    const key = `${ownerId}:${epoch}`;
    if (saveRequests.current.has(key)) return;
    saveRequests.current.add(key);
    const current = () => mounted.current && currentUser.current === ownerId && accountEpoch.current === epoch;
    setBusy(true);
    try {
      // Protected qualification/permission fields have their dedicated RPC.
      const patch = { name: editing.name.trim(), email: editing.email, website: editing.website,
        type: editing.type, niche: editing.niche, followers_count: editing.followers_count,
        status: editing.status, notes: editing.notes };
      if (editing.id) {
        await updateProspect(editing.id, patch);
      } else {
        await createProspect(ownerId, patch);
      }
      if (!current()) return;
      toast.success('✅ Enregistré');
      setEditing(null);
      refresh();
    } catch (e) {
      if (current()) toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      saveRequests.current.delete(key);
      if (current()) setBusy(false);
    }
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

  const handleFindOpenChange = (open: boolean) => {
    if (open) {
      const ownerId = user?.id ?? null;
      const epoch = accountEpoch.current;
      if (findOwner?.ownerId !== ownerId || findOwner.epoch !== epoch) {
        setFindQuery('');
        setFindNiche('');
        setFindType('influencer');
      }
      setFindOwner({ ownerId, epoch });
      setFinding(findRequests.current.has(`${ownerId}:${epoch}`));
    }
    findRevision.current += 1;
    setFindOpen(open);
  };

  const handleFind = async () => {
    if (!user || currentUser.current !== user.id || !mounted.current || !ownsFindForm || !findOpen || !findQuery.trim()) return;
    const ownerId = user.id;
    const epoch = accountEpoch.current;
    const requestKey = `${ownerId}:${epoch}`;
    if (findRequests.current.has(requestKey)) return;
    findRequests.current.add(requestKey);
    const revision = findRevision.current;
    const ownsAccount = () => mounted.current && currentUser.current === ownerId && accountEpoch.current === epoch;
    const ownsDraft = () => ownsAccount() && findRevision.current === revision;
    setFinding(true);
    try {
      const result = await findProspects(findQuery, findNiche || undefined, findType);
      if (!ownsDraft()) return;
      toast.success(`${result.inserted} prospects ajoutés à qualifier`);
      setFindOpen(false);
      setFindQuery('');
      refresh();
    } catch (e) {
      if (ownsDraft()) {
        const feedback = partnerDiscoveryFeedback(e);
        toast[feedback.kind](feedback.title, { description: feedback.description });
        if (feedback.refreshList) void refresh();
      }
    } finally {
      // Closing or editing the dialog does not undo a request already accepted by the server.
      // Keep its admission until it settles; an old account cycle cannot unlock a new search.
      findRequests.current.delete(requestKey);
      if (ownsAccount()) setFinding(false);
    }
  };

  const openQualification = (p: PartnerProspect) => {
    if (!user || p.user_id !== user.id) return;
    const sameEmail = p.email?.trim().toLowerCase() === p.contact_qualification?.email?.trim().toLowerCase();
    const permission = p.email_permission?.email?.trim().toLowerCase() === p.email?.trim().toLowerCase() ? p.email_permission : null;
    const consent = new Date(permission?.consented_at ?? '');
    const localDate = Number.isFinite(consent.getTime()) ? new Date(consent.getTime() - consent.getTimezoneOffset() * 60_000).toISOString().slice(0,16) : '';
    const role = p.contact_role && p.contact_role !== 'unknown' ? p.contact_role : 'commercial';
    setQualification({ ownerId: user.id, prospectId: p.id,
      profile: p.outreach_profile ?? (role === 'editorial' ? 'editorial' : p.type === 'media' || role === 'venue' ? 'media_affiliate' : 'legacy'),
      role, sourceUrl: (sameEmail ? p.contact_qualification?.source_url : null) ?? safePartnerWebLink(p.contact_evidence?.source_url) ?? '',
      country: sameEmail ? p.contact_qualification?.country ?? '' : '', language: sameEmail ? p.contact_qualification?.language ?? '' : '',
      consentReference: permission?.reference ?? '', consentDate: localDate, confirmed: false,
      offerName: p.outreach_offer?.name ?? '', offerUrl: p.outreach_offer?.url ?? '', offerSummary: p.outreach_offer?.summary ?? '',
    });
  };

  const handleQualification = async (withdraw = false) => {
    if (!user || !qualification || qualification.ownerId !== user.id || qualifying) return;
    const draft = qualification;
    const ownerId = user.id;
    const epoch = accountEpoch.current;
    const key = `${ownerId}:${epoch}:${draft.prospectId}`;
    if (qualificationRequests.current.has(key)) return;
    let payload: PartnerQualification | { withdraw_permission: true };
    if (withdraw) payload = { withdraw_permission: true };
    else {
      const sourceUrl = safePartnerWebLink(draft.sourceUrl);
      const consentDate = new Date(draft.consentDate);
      const hasOffer = [draft.offerName,draft.offerUrl,draft.offerSummary].some(value => value.trim());
      const offerUrl = safePartnerWebLink(draft.offerUrl);
      if (!draft.confirmed || !sourceUrl || !/^[A-Z]{2}$/.test(draft.country.trim().toUpperCase()) ||
        !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(draft.language.trim()) ||
        draft.consentReference.trim().length < 10 || !Number.isFinite(consentDate.getTime()) || consentDate.getTime() > Date.now()) {
        toast.error('Qualification incomplète', { description: 'Vérifiez les coordonnées, le pays, la langue, la preuve d’accord et l’offre.' });
        return;
      }
      if ((draft.profile !== 'legacy' || hasOffer) && (!draft.offerName.trim() || !offerUrl?.startsWith('https://') ||
        offerUrl.length > 2048 || draft.offerSummary.trim().length < 10 || draft.offerSummary.trim().length > 1500)) {
        toast.error('Offre incomplète', { description: 'Renseignez le nom, une page HTTPS et une présentation de 10 à 1 500 caractères.' });
        return;
      }
      payload = { profile: draft.profile, role: draft.role, source_url: sourceUrl,
        country: draft.country.trim().toUpperCase(), language: draft.language.trim(),
        consent_reference: draft.consentReference.trim(), consent_at: consentDate.toISOString(),
        ...(hasOffer ? { offer: { name: draft.offerName.trim(), url: offerUrl!, summary: draft.offerSummary.trim() } } : {}),
      };
    }
    qualificationRequests.current.add(key);
    const current = () => mounted.current && currentUser.current === ownerId && accountEpoch.current === epoch;
    setQualifying(true);
    try {
      const result = await qualifyProspect(draft.prospectId,payload);
      if (!current()) return;
      if (result.status === 'blocked') {
        toast.error('Qualification non confirmée', { description: QUALIFICATION_ERRORS[result.reason ?? ''] ?? 'Le contact ne peut pas encore être admis à l’envoi. Vérifiez sa fiche et les conditions de campagne.' });
      } else {
        toast.success(result.status === 'permission_withdrawn' ? 'Autorisation d’envoi retirée' : 'Contact qualifié');
        setQualification(null);
        refresh();
      }
    } catch (error) {
      if (current()) toast.error('Qualification non confirmée', { description: error instanceof Error ? error.message : String(error) });
    } finally {
      qualificationRequests.current.delete(key);
      if (current()) setQualifying(false);
    }
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
          <Button variant="outline" onClick={() => handleFindOpenChange(true)}>
            <Sparkles className="w-4 h-4 mr-2" /> Trouver via IA
          </Button>
          <Button onClick={() => setEditing({ ...newProspect(), user_id: user?.id })}>
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
            const website = safePartnerWebLink(p.website);
            const qualified = Boolean(p.contact_qualification?.verified_at && p.email &&
              p.contact_qualification.email?.trim().toLowerCase() === p.email.trim().toLowerCase());
            const sourceLink = safePartnerWebLink(qualified ? p.contact_qualification?.source_url : p.contact_evidence?.source_url);
            const permitted = p.email_permission?.status === 'explicit_opt_in' && Boolean(p.email) &&
              p.email_permission.email?.trim().toLowerCase() === p.email?.trim().toLowerCase();
            return (
              <Card key={p.id} className="bg-card border-border">
                <CardContent className="p-4 flex flex-wrap items-start gap-3">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-accent-purple to-accent-cyan flex items-center justify-center text-sm font-bold text-foreground flex-shrink-0">
                    {p.name[0]?.toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-[160px]">
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
                      {website && <span> · <a href={website} target="_blank" rel="noopener noreferrer" className="hover:text-accent-cyan">{website.replace(/^https?:\/\//, '')}</a></span>}
                      {p.followers_count && <span> · {p.followers_count.toLocaleString('fr-FR')} followers</span>}
                    </p>
                    {p.ai_reasoning && (
                      <p className="text-[10px] italic text-accent-purple/80 mt-1 truncate">💭 {p.ai_reasoning}</p>
                    )}
                    <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                      <span>{ROLE_LABELS[p.contact_role ?? 'unknown'] ?? ROLE_LABELS.unknown}</span>
                      <span>{PROFILE_LABELS[p.outreach_profile ?? 'legacy'] ?? PROFILE_LABELS.legacy}</span>
                      <span>{qualified ? 'Coordonnées vérifiées' : 'À qualifier'}</span>
                      <span>{permitted ? 'Accord d’envoi enregistré' : 'Accord d’envoi à renseigner'}</span>
                    </div>
                    {sourceLink && <p className="mt-1 text-xs text-muted-foreground">
                      <a href={sourceLink} target="_blank" rel="noopener noreferrer" className="underline">{qualified ? 'Source des coordonnées vérifiées' : 'Source observée'}</a>
                      {!qualified && ' · à vérifier avant qualification'}
                    </p>}
                    {p.outreach_offer?.name && <p className="mt-1 text-xs">Offre : {p.outreach_offer.name}</p>}
                    {p.reply_summary && <p className="mt-2 text-xs text-muted-foreground">
                      <strong>{p.reply_kind === 'refusal' ? 'Refus' : p.reply_kind === 'automatic' ? 'Réponse automatique' : 'Réponse'} :</strong> {p.reply_summary}
                      {p.reply_received_at && Number.isFinite(Date.parse(p.reply_received_at)) && <span> · {new Date(p.reply_received_at).toLocaleString('fr-FR')}</span>}
                    </p>}
                    <PartnerReplyAction prospect={p} />
                    {p.ai_score !== null && (
                      <div className="mt-1.5 flex items-center gap-2">
                        <div className="h-1 w-24 bg-secondary rounded-full overflow-hidden">
                          <div className="h-full bg-gradient-to-r from-accent-purple to-accent-cyan" style={{ width: `${p.ai_score}%` }} />
                        </div>
                        <span className="text-[10px] text-muted-foreground">Score {p.ai_score}/100</span>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1 flex-shrink-0">
                    <Button variant="outline" size="sm" onClick={() => openQualification(p)} disabled={!p.email}
                      title={!p.email ? 'Renseignez une adresse avant de qualifier le contact' : 'Vérifier les coordonnées et les conditions de contact'}>Qualifier</Button>
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
                    {website && (
                      <a href={website} target="_blank" rel="noopener noreferrer">
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

      <Dialog open={!!qualification && qualification.ownerId === user?.id}
        onOpenChange={open => { if (!open && !qualifying) setQualification(null); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" aria-describedby="qualification-description">
          <DialogHeader><DialogTitle>Qualifier le contact</DialogTitle></DialogHeader>
          <p id="qualification-description" className="text-sm text-muted-foreground">
            Vérifiez le rôle, la source des coordonnées et l’accord du destinataire. Une adresse publique ou un résultat de recherche ne constitue pas un accord pour recevoir nos propositions.
          </p>
          {qualification && <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div><Label htmlFor="qualification-profile">Proposition</Label>
                <Select value={qualification.profile} disabled={qualifying} onValueChange={(profile: PartnerOutreachProfile) => setQualification({ ...qualification, profile,
                  role: profile === 'editorial' ? 'editorial' : qualification.role === 'editorial' ? 'commercial' : qualification.role })}>
                  <SelectTrigger id="qualification-profile"><SelectValue /></SelectTrigger>
                  <SelectContent>{Object.entries(PROFILE_LABELS).map(([value,label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div><Label htmlFor="qualification-role">Fonction du destinataire</Label>
                <Select value={qualification.role} disabled={qualifying} onValueChange={(role: Exclude<PartnerContactRole,'unknown'>) => setQualification({ ...qualification, role })}>
                  <SelectTrigger id="qualification-role"><SelectValue /></SelectTrigger>
                  <SelectContent>{Object.entries(ROLE_LABELS).filter(([value]) => value !== 'unknown').map(([value,label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <div><Label htmlFor="qualification-source">Page source exacte des coordonnées</Label>
              <Input id="qualification-source" type="url" maxLength={2000} value={qualification.sourceUrl} disabled={qualifying}
                onChange={e => setQualification({ ...qualification, sourceUrl: e.target.value })} placeholder="https://exemple.fr/contact" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label htmlFor="qualification-country">Pays du destinataire</Label>
                <Input id="qualification-country" value={qualification.country} maxLength={2} disabled={qualifying} placeholder="FR, CH…"
                  onChange={e => setQualification({ ...qualification, country: e.target.value.toUpperCase() })} />
              </div>
              <div><Label htmlFor="qualification-language">Langue de l’échange</Label>
                <Input id="qualification-language" value={qualification.language} maxLength={35} disabled={qualifying} placeholder="fr, de, en…"
                  onChange={e => setQualification({ ...qualification, language: e.target.value })} />
              </div>
            </div>
            <div className="rounded-md border p-3 space-y-3">
              <p className="text-sm font-medium">Accord pour recevoir nos propositions par email</p>
              <div><Label htmlFor="qualification-consent-reference">Référence vérifiable de l’accord</Label>
                <Textarea id="qualification-consent-reference" rows={2} maxLength={2000} disabled={qualifying} value={qualification.consentReference}
                  onChange={e => setQualification({ ...qualification, consentReference: e.target.value })} placeholder="Référence du message, formulaire ou document précisant l’accord…" />
              </div>
              <div><Label htmlFor="qualification-consent-date">Date et heure de l’accord</Label>
                <Input id="qualification-consent-date" type="datetime-local" disabled={qualifying} value={qualification.consentDate}
                  onChange={e => setQualification({ ...qualification, consentDate: e.target.value })} />
              </div>
              <p className="text-xs text-muted-foreground">Le service d’envoi actuel exige un accord explicite. Ce formulaire sert à enregistrer une preuve existante.</p>
            </div>
            <div className="rounded-md border p-3 space-y-3">
              <p className="text-sm font-medium">Produit ou sujet proposé{qualification.profile === 'legacy' ? ' · facultatif' : ''}</p>
              <div><Label htmlFor="qualification-offer-name">Nom</Label><Input id="qualification-offer-name" maxLength={200} disabled={qualifying}
                value={qualification.offerName} onChange={e => setQualification({ ...qualification, offerName: e.target.value })} /></div>
              <div><Label htmlFor="qualification-offer-url">Page de présentation</Label><Input id="qualification-offer-url" type="url" maxLength={2000} disabled={qualifying}
                aria-describedby="qualification-offer-help" value={qualification.offerUrl} onChange={e => setQualification({ ...qualification, offerUrl: e.target.value })} /></div>
              <div><Label htmlFor="qualification-offer-summary">Présentation vérifiée</Label><Textarea id="qualification-offer-summary" rows={3} minLength={10} maxLength={1500} disabled={qualifying}
                aria-describedby="qualification-offer-help" value={qualification.offerSummary} onChange={e => setQualification({ ...qualification, offerSummary: e.target.value })} /></div>
              <p id="qualification-offer-help" className="text-xs text-muted-foreground">Une page HTTPS et une présentation de 10 à 1 500 caractères sont nécessaires pour l’offre.</p>
            </div>
            <div className="flex items-start gap-3">
              <Checkbox id="qualification-confirmed" checked={qualification.confirmed} disabled={qualifying}
                onCheckedChange={checked => setQualification({ ...qualification, confirmed: checked === true })} />
              <Label htmlFor="qualification-confirmed" className="text-sm leading-relaxed">J’ai vérifié ces coordonnées, la fonction et la preuve de l’accord pour ce destinataire.</Label>
            </div>
          </div>}
          <DialogFooter className="gap-2 flex-wrap">
            {qualification && prospects.find(p => p.id === qualification.prospectId && p.user_id === user?.id)?.email_permission?.status === 'explicit_opt_in' &&
              <Button variant="outline" disabled={qualifying} onClick={() => handleQualification(true)}>Retirer l’autorisation d’envoi</Button>}
            <Button variant="outline" disabled={qualifying} onClick={() => setQualification(null)}>Fermer</Button>
            <Button disabled={qualifying || !qualification?.confirmed} onClick={() => handleQualification()}>
              {qualifying && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Enregistrer la qualification
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
      <Dialog open={!!editing && editing.user_id === user?.id} onOpenChange={o => !o && setEditing(null)}>
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
      <Dialog open={findOpen && ownsFindForm} onOpenChange={handleFindOpenChange}>
        {ownsFindForm && <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-accent-purple" /> Recherche IA de prospects
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="partner-find-query" className="text-xs">Requête</Label>
              <Input
                id="partner-find-query"
                value={findQuery}
                onChange={e => { findRevision.current += 1; setFindQuery(e.target.value); }}
                placeholder="ex : médias locaux, créateurs spécialisés…"
                className="mt-1.5"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Type</Label>
                <Select value={findType} onValueChange={(v: ProspectType) => { findRevision.current += 1; setFindType(v); }}>
                  <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PROSPECT_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.emoji} {t.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Niche</Label>
                <Select value={findNiche || 'all'} onValueChange={value => { findRevision.current += 1; setFindNiche(value === 'all' ? '' : value); }}>
                  <SelectTrigger className="mt-1.5"><SelectValue placeholder="Toutes" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Toutes</SelectItem>
                    {NICHES.map(n => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogDescription className="text-[11px] text-muted-foreground">
              La recherche utilise les pays et langues de vos paramètres. L’IA propose des prospects à vérifier et à qualifier, avec un score indicatif de 0 à 100. Une adresse observée ne vaut pas autorisation de contact.
            </DialogDescription>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => handleFindOpenChange(false)}>Annuler</Button>
            <Button onClick={handleFind} disabled={finding || !findQuery.trim()}>
              {finding && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Lancer la recherche
            </Button>
          </DialogFooter>
        </DialogContent>}
      </Dialog>
    </div>
  );
}
