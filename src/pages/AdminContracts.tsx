import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Loader2, FileText, ExternalLink, Ban, Shield } from 'lucide-react';
import { toast } from 'sonner';

interface ContractRow {
  id: string;
  user_id: string;
  app_slug: string;
  template_slug: string;
  status: string;
  docuseal_submission_id: number | null;
  commission_rate: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
  signed_at: string | null;
  ots_block_height: number | null;
  ots_btc_timestamp: string | null;
  ots_proof: string | null;
}

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  draft:     { label: 'Brouillon',  className: 'bg-gray-500' },
  sent:      { label: 'Envoyé',     className: 'bg-blue-500' },
  opened:    { label: 'Ouvert',     className: 'bg-amber-500' },
  signed:    { label: 'Signé',      className: 'bg-emerald-600' },
  declined:  { label: 'Refusé',     className: 'bg-red-600' },
  cancelled: { label: 'Annulé',     className: 'bg-gray-600' },
  expired:   { label: 'Expiré',     className: 'bg-orange-600' },
};

export default function AdminContracts() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [contracts, setContracts] = useState<ContractRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [appSlugFilter, setAppSlugFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ContractRow | null>(null);

  // Verify admin role
  useEffect(() => {
    if (!user) { setIsAdmin(false); return; }
    supabase.schema('purama_ai' as never).from('user_roles' as never)
      .select('role').eq('user_id', user.id).eq('role', 'admin' as never).maybeSingle()
      .then(({ data }) => setIsAdmin(!!data));
  }, [user]);

  useEffect(() => {
    if (isAdmin === false) navigate('/dashboard', { replace: true });
  }, [isAdmin, navigate]);

  // Load contracts
  useEffect(() => {
    if (!isAdmin) return;
    setLoading(true);
    supabase.from('contracts' as never)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200)
      .then(({ data, error }) => {
        if (error) toast.error(`Erreur chargement contrats : ${error.message}`);
        else setContracts((data as unknown as ContractRow[]) ?? []);
        setLoading(false);
      });
  }, [isAdmin]);

  const apps = useMemo(() => {
    const set = new Set(contracts.map(c => c.app_slug));
    return Array.from(set).sort();
  }, [contracts]);

  const filtered = useMemo(() => contracts.filter(c => {
    if (statusFilter !== 'all' && c.status !== statusFilter) return false;
    if (appSlugFilter !== 'all' && c.app_slug !== appSlugFilter) return false;
    if (search && !(c.template_slug.toLowerCase().includes(search.toLowerCase()) ||
                    c.id.toLowerCase().includes(search.toLowerCase()) ||
                    String(c.metadata.signer_email ?? '').toLowerCase().includes(search.toLowerCase()))) return false;
    return true;
  }), [contracts, statusFilter, appSlugFilter, search]);

  const stats = useMemo(() => ({
    total: contracts.length,
    signed: contracts.filter(c => c.status === 'signed').length,
    pending: contracts.filter(c => ['sent', 'opened'].includes(c.status)).length,
    cancelled: contracts.filter(c => ['cancelled', 'declined', 'expired'].includes(c.status)).length,
  }), [contracts]);

  async function handleCancel(contract: ContractRow) {
    if (!window.confirm(`Annuler le contrat ${contract.template_slug} ?`)) return;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/contracts-cancel`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contract_id: contract.id, reason: 'admin_cancel' }),
    });
    if (res.ok) {
      toast.success('Contrat annulé');
      setContracts(prev => prev.map(c => c.id === contract.id ? { ...c, status: 'cancelled' } : c));
    } else {
      const err = await res.json().catch(() => ({}));
      toast.error(`Échec : ${err.error ?? res.statusText}`);
    }
  }

  async function handleVerifyOts(contract: ContractRow) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    toast.info('Vérification OTS en cours…');
    const res = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/contracts-ots-verify?id=${contract.id}&upgrade=true`,
      { headers: { 'Authorization': `Bearer ${session.access_token}` } }
    );
    const data = await res.json();
    if (data.verified) {
      toast.success(`Bloc Bitcoin #${data.block_height} — ${new Date(data.btc_timestamp).toLocaleString('fr-FR')}`);
      setContracts(prev => prev.map(c => c.id === contract.id
        ? { ...c, ots_block_height: data.block_height, ots_btc_timestamp: data.btc_timestamp }
        : c));
    } else {
      toast.info(data.message ?? 'En attente de confirmation Bitcoin (1-6h)');
    }
  }

  if (isAdmin === null) return <div className="p-8"><Loader2 className="animate-spin" /></div>;
  if (isAdmin === false) return null;

  return (
    <div className="p-6 space-y-6 max-w-[1600px] mx-auto">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold">Contrats — DocuSeal Hub</h1>
          <p className="text-muted-foreground text-sm mt-1">Administration centrale des contrats de l'écosystème Purama.</p>
        </div>
        <Badge className="bg-amber-500 gap-1"><Shield className="h-3 w-3" /> Super Admin</Badge>
      </header>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total contrats" value={stats.total} />
        <StatCard label="Signés" value={stats.signed} tone="success" />
        <StatCard label="En attente" value={stats.pending} tone="warning" />
        <StatCard label="Annulés / Refusés" value={stats.cancelled} tone="muted" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Filtres</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Input placeholder="Rechercher (ID, template, email)…" value={search}
                 onChange={e => setSearch(e.target.value)} className="max-w-xs" />
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-48"><SelectValue placeholder="Statut" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tous les statuts</SelectItem>
              {Object.entries(STATUS_BADGE).map(([k, v]) => (
                <SelectItem key={k} value={k}>{v.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={appSlugFilter} onValueChange={setAppSlugFilter}>
            <SelectTrigger className="w-48"><SelectValue placeholder="App" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Toutes les apps</SelectItem>
              {apps.map(a => <SelectItem key={a} value={a}>{a}</SelectItem>)}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-lg">{filtered.length} contrat{filtered.length > 1 ? 's' : ''}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-8 flex items-center gap-3"><Loader2 className="animate-spin h-5 w-5" /> Chargement…</div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">Aucun contrat.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Template</TableHead>
                  <TableHead>App</TableHead>
                  <TableHead>Signataire</TableHead>
                  <TableHead>Commission</TableHead>
                  <TableHead>Statut</TableHead>
                  <TableHead>OTS</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map(c => {
                  const status = STATUS_BADGE[c.status] ?? { label: c.status, className: 'bg-gray-500' };
                  return (
                    <TableRow key={c.id} className="hover:bg-muted/50 cursor-pointer" onClick={() => setSelected(c)}>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {new Date(c.created_at).toLocaleDateString('fr-FR')}
                      </TableCell>
                      <TableCell className="font-medium">{c.template_slug}</TableCell>
                      <TableCell><Badge variant="outline">{c.app_slug}</Badge></TableCell>
                      <TableCell className="text-xs">{String(c.metadata?.signer_email ?? '—')}</TableCell>
                      <TableCell>{c.commission_rate ? `${c.commission_rate}%` : '—'}</TableCell>
                      <TableCell><Badge className={`${status.className} text-white`}>{status.label}</Badge></TableCell>
                      <TableCell>
                        {c.ots_block_height
                          ? <Badge variant="outline" className="gap-1"><Shield className="h-3 w-3" /> #{c.ots_block_height}</Badge>
                          : c.ots_proof
                            ? <Badge variant="outline" className="text-amber-600">En attente</Badge>
                            : <span className="text-xs text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                        <div className="flex gap-1 justify-end">
                          <Button size="sm" variant="ghost" onClick={() => setSelected(c)}>
                            <FileText className="h-4 w-4" />
                          </Button>
                          {c.status !== 'cancelled' && c.status !== 'signed' && (
                            <Button size="sm" variant="ghost" onClick={() => handleCancel(c)}>
                              <Ban className="h-4 w-4" />
                            </Button>
                          )}
                          {c.ots_proof && (
                            <Button size="sm" variant="ghost" onClick={() => handleVerifyOts(c)}>
                              <Shield className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle>{selected.template_slug}</SheetTitle>
                <SheetDescription>ID : <code className="text-xs">{selected.id}</code></SheetDescription>
              </SheetHeader>
              <div className="mt-6 space-y-4 text-sm">
                <Row label="Statut">
                  <Badge className={`${(STATUS_BADGE[selected.status] ?? { className: '' }).className} text-white`}>
                    {(STATUS_BADGE[selected.status] ?? { label: selected.status }).label}
                  </Badge>
                </Row>
                <Row label="App">{selected.app_slug}</Row>
                <Row label="Signataire">{String(selected.metadata?.signer_email ?? '—')}</Row>
                <Row label="Nom">{String(selected.metadata?.signer_name ?? '—')}</Row>
                {selected.commission_rate !== null && (
                  <Row label="Commission">{selected.commission_rate}%</Row>
                )}
                <Row label="Créé">{new Date(selected.created_at).toLocaleString('fr-FR')}</Row>
                {selected.signed_at && <Row label="Signé">{new Date(selected.signed_at).toLocaleString('fr-FR')}</Row>}
                <Row label="DocuSeal #">{selected.docuseal_submission_id ?? '—'}</Row>
                {selected.ots_block_height && (
                  <Row label="Bloc Bitcoin">
                    <a href={`https://blockstream.info/block-height/${selected.ots_block_height}`}
                       target="_blank" rel="noreferrer"
                       className="underline flex items-center gap-1">
                      #{selected.ots_block_height} <ExternalLink className="h-3 w-3" />
                    </a>
                  </Row>
                )}
                {selected.ots_btc_timestamp && (
                  <Row label="Timestamp BTC">{new Date(selected.ots_btc_timestamp).toLocaleString('fr-FR')}</Row>
                )}
                <details className="mt-6">
                  <summary className="cursor-pointer text-muted-foreground">Metadata JSON</summary>
                  <pre className="mt-2 p-3 bg-muted rounded text-xs overflow-x-auto">
                    {JSON.stringify(selected.metadata, null, 2)}
                  </pre>
                </details>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number; tone?: 'success' | 'warning' | 'muted' }) {
  const color = tone === 'success' ? 'text-emerald-600'
             : tone === 'warning' ? 'text-amber-600'
             : tone === 'muted'   ? 'text-muted-foreground'
             : '';
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={`text-3xl font-semibold mt-1 ${color}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 border-b border-border/50">
      <span className="text-muted-foreground text-xs uppercase tracking-wide">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}
