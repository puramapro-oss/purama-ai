import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Save, Loader2, Building2, Banknote, Sparkles, Bell } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import {
  getComptaConfig, updateComptaConfig, getBridgeConnectUrl,
  LEGAL_FORMS, FISCAL_REGIMES, TVA_REGIMES,
  type ComptaConfig, type LegalForm, type FiscalRegime, type TvaRegime,
} from '@/lib/compta';

export default function ComptaAgentSettings() {
  const { user } = useAuth();
  const [config, setConfig] = useState<ComptaConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [bridging, setBridging] = useState(false);

  useEffect(() => {
    if (!user) return;
    (async () => {
      try { setConfig(await getComptaConfig(user.id)); }
      catch (e) { toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) }); }
      finally { setLoading(false); }
    })();
  }, [user?.id]);

  if (loading || !config) {
    return <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-accent-cyan" /></div>;
  }

  const update = (patch: Partial<ComptaConfig>) => setConfig({ ...config, ...patch });

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    try {
      const { id, user_id, created_at, updated_at, total_transactions, total_invoices, total_declarations, fiscal_health_score, bridge_last_sync_at, bridge_user_uuid, ...patch } = config;
      void id; void user_id; void created_at; void updated_at;
      void total_transactions; void total_invoices; void total_declarations;
      void fiscal_health_score; void bridge_last_sync_at; void bridge_user_uuid;
      await updateComptaConfig(user.id, patch);
      toast.success('✅ Paramètres enregistrés');
    } catch (e) {
      toast.error('Erreur de sauvegarde', { description: e instanceof Error ? e.message : String(e) });
    } finally { setSaving(false); }
  };

  const handleConnectBridge = async () => {
    setBridging(true);
    try {
      const url = await getBridgeConnectUrl();
      window.location.href = url;
    } catch (e) {
      toast.error('Bridge OAuth indisponible', {
        description: e instanceof Error ? e.message : String(e),
      });
      setBridging(false);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl mx-auto pb-12">
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between">
        <div>
          <Link to="/dashboard/compta-agent" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-1">
            <ArrowLeft className="w-3 h-3" /> Retour
          </Link>
          <h1 className="text-2xl font-orbitron font-bold text-foreground">Paramètres compta</h1>
        </div>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
          Enregistrer
        </Button>
      </motion.div>

      {/* Entreprise */}
      <Card className="bg-card border-border">
        <CardContent className="p-5 space-y-4">
          <h2 className="font-semibold text-foreground flex items-center gap-2">
            <Building2 className="w-4 h-4 text-accent-cyan" /> Entreprise
          </h2>
          <div>
            <Label className="text-xs">Raison sociale</Label>
            <Input value={config.company_name ?? ''} onChange={e => update({ company_name: e.target.value })} className="mt-1.5" placeholder="SASU PURAMA" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">SIREN</Label>
              <Input value={config.siren ?? ''} onChange={e => update({ siren: e.target.value })} className="mt-1.5" placeholder="123 456 789" />
            </div>
            <div>
              <Label className="text-xs">SIRET</Label>
              <Input value={config.siret ?? ''} onChange={e => update({ siret: e.target.value })} className="mt-1.5" placeholder="12345678900012" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Code NAF</Label>
              <Input value={config.naf_code ?? ''} onChange={e => update({ naf_code: e.target.value })} className="mt-1.5" placeholder="6201Z" />
            </div>
            <div>
              <Label className="text-xs">N° TVA intracom</Label>
              <Input value={config.tva_number ?? ''} onChange={e => update({ tva_number: e.target.value })} className="mt-1.5" placeholder="FR12345678901" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label className="text-xs">Forme juridique</Label>
              <Select value={config.legal_form ?? ''} onValueChange={(v: LegalForm) => update({ legal_form: v })}>
                <SelectTrigger className="mt-1.5"><SelectValue placeholder="…" /></SelectTrigger>
                <SelectContent>
                  {LEGAL_FORMS.map(f => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Régime fiscal</Label>
              <Select value={config.fiscal_regime ?? ''} onValueChange={(v: FiscalRegime) => update({ fiscal_regime: v })}>
                <SelectTrigger className="mt-1.5"><SelectValue placeholder="…" /></SelectTrigger>
                <SelectContent>
                  {FISCAL_REGIMES.map(f => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Régime TVA</Label>
              <Select value={config.tva_regime ?? ''} onValueChange={(v: TvaRegime) => update({ tva_regime: v })}>
                <SelectTrigger className="mt-1.5"><SelectValue placeholder="…" /></SelectTrigger>
                <SelectContent>
                  {TVA_REGIMES.map(f => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label className="text-xs">Adresse</Label>
            <Input value={config.address ?? ''} onChange={e => update({ address: e.target.value })} className="mt-1.5" placeholder="8 Rue Chapelle" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Code postal</Label>
              <Input value={config.postal_code ?? ''} onChange={e => update({ postal_code: e.target.value })} className="mt-1.5" />
            </div>
            <div>
              <Label className="text-xs">Ville</Label>
              <Input value={config.city ?? ''} onChange={e => update({ city: e.target.value })} className="mt-1.5" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Bridge */}
      <Card className="bg-card border-border">
        <CardContent className="p-5 space-y-4">
          <h2 className="font-semibold text-foreground flex items-center gap-2">
            <Banknote className="w-4 h-4 text-emerald-400" /> Connexion bancaire
          </h2>
          {config.bridge_user_uuid ? (
            <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
              <div>
                <p className="text-sm font-medium text-foreground">Bridge connecté ✅</p>
                <p className="text-[11px] text-muted-foreground">
                  {config.bridge_accounts.length} compte(s) — dernière synchro :{' '}
                  {config.bridge_last_sync_at ? new Date(config.bridge_last_sync_at).toLocaleString('fr-FR') : 'jamais'}
                </p>
              </div>
            </div>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Connecte ta banque via Bridge (DSP2 compliant). L'agent récupère tes transactions et les catégorise automatiquement toutes les 4h.
              </p>
              <Button onClick={handleConnectBridge} disabled={bridging} className="w-full">
                {bridging ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Banknote className="w-4 h-4 mr-2" />}
                Connecter une banque
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/* Optimisations fiscales */}
      <Card className="bg-card border-border">
        <CardContent className="p-5 space-y-4">
          <h2 className="font-semibold text-foreground flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-accent-purple" /> Optimisations fiscales
          </h2>
          <ToggleRow
            label="Zone France Ruralités Revitalisation (ZFRR)"
            sub="Exonération IS pendant 5 ans + 3 ans dégressifs"
            checked={config.is_zfrr}
            onChange={v => update({ is_zfrr: v })}
          />
          {config.is_zfrr && (
            <div>
              <Label className="text-xs">Date de début ZFRR</Label>
              <Input type="date" value={config.zfrr_start_date ?? ''} onChange={e => update({ zfrr_start_date: e.target.value || null })} className="mt-1.5 max-w-[200px]" />
            </div>
          )}
          <ToggleRow
            label="ZFU (Zone Franche Urbaine)"
            checked={config.is_zfu}
            onChange={v => update({ is_zfu: v })}
          />
          <ToggleRow
            label="CIR (Crédit Impôt Recherche)"
            sub="30% des dépenses R&D jusqu'à 100M€"
            checked={config.cir_eligible}
            onChange={v => update({ cir_eligible: v })}
          />
          <ToggleRow
            label="CII (Crédit Impôt Innovation)"
            sub="20% des dépenses d'innovation (PME)"
            checked={config.cii_eligible}
            onChange={v => update({ cii_eligible: v })}
          />
          <ToggleRow
            label="IP Box"
            sub="Taux réduit 10% sur revenus de brevets et logiciels"
            checked={config.ip_box_eligible}
            onChange={v => update({ ip_box_eligible: v })}
          />
          <ToggleRow
            label="Statut JEI (Jeune Entreprise Innovante)"
            checked={config.jei_status}
            onChange={v => update({ jei_status: v })}
          />
        </CardContent>
      </Card>

      {/* Automatisation */}
      <Card className="bg-card border-border">
        <CardContent className="p-5 space-y-4">
          <h2 className="font-semibold text-foreground">Automatisation</h2>
          <ToggleRow label="Catégorisation IA automatique" checked={config.auto_categorize} onChange={v => update({ auto_categorize: v })} />
          <ToggleRow label="Calcul TVA automatique" checked={config.auto_tva} onChange={v => update({ auto_tva: v })} />
          <ToggleRow label="Préparation des déclarations" sub="L'agent prépare 7j avant deadline" checked={config.auto_declarations} onChange={v => update({ auto_declarations: v })} />
          <ToggleRow label="Approbation manuelle obligatoire" sub="Recommandé. Désactiver pour un mode 100% automatique." checked={config.require_approval_before_send} onChange={v => update({ require_approval_before_send: v })} />
        </CardContent>
      </Card>

      {/* Notifications */}
      <Card className="bg-card border-border">
        <CardContent className="p-5 space-y-4">
          <h2 className="font-semibold text-foreground flex items-center gap-2">
            <Bell className="w-4 h-4 text-accent-pink" /> Notifications
          </h2>
          <ToggleRow label="Nouvelle transaction" checked={config.notify_new_transaction} onChange={v => update({ notify_new_transaction: v })} />
          <ToggleRow label="Déclaration prête" checked={config.notify_declaration_ready} onChange={v => update({ notify_declaration_ready: v })} />
          <ToggleRow label="Anomalies détectées" checked={config.notify_anomaly} onChange={v => update({ notify_anomaly: v })} />
          <ToggleRow label="Rapport mensuel" checked={config.notify_monthly_report} onChange={v => update({ notify_monthly_report: v })} />
        </CardContent>
      </Card>

      {/* Facturation */}
      <Card className="bg-card border-border">
        <CardContent className="p-5 space-y-4">
          <h2 className="font-semibold text-foreground">Numérotation des factures</h2>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Préfixe</Label>
              <Input value={config.invoice_prefix} onChange={e => update({ invoice_prefix: e.target.value.toUpperCase() })} className="mt-1.5" />
            </div>
            <div>
              <Label className="text-xs">Prochain numéro</Label>
              <Input type="number" min={1} value={config.invoice_next_number} onChange={e => update({ invoice_next_number: parseInt(e.target.value || '1', 10) })} className="mt-1.5" />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Format : <code className="text-accent-cyan">{config.invoice_prefix}-{new Date().getFullYear()}-{String(config.invoice_next_number).padStart(5, '0')}</code>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function ToggleRow({
  label, sub, checked, onChange,
}: {
  label: string;
  sub?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
