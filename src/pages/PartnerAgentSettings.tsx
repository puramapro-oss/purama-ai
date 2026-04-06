import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Save, Loader2, User, Sparkles, Clock, DollarSign, Image as ImageIcon, X } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import {
  getPartnerConfig, updatePartnerConfig, uploadSignature,
  TONES, NICHES,
  type PartnerConfig,
} from '@/lib/partner';

const DAYS = [
  { v: 'MO', l: 'L' }, { v: 'TU', l: 'M' }, { v: 'WE', l: 'M' },
  { v: 'TH', l: 'J' }, { v: 'FR', l: 'V' }, { v: 'SA', l: 'S' }, { v: 'SU', l: 'D' },
];

export default function PartnerAgentSettings() {
  const { user } = useAuth();
  const [config, setConfig] = useState<PartnerConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!user) return;
    (async () => {
      try { setConfig(await getPartnerConfig(user.id)); }
      catch (e) { toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) }); }
      finally { setLoading(false); }
    })();
  }, [user?.id]);

  if (loading || !config) {
    return <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-accent-cyan" /></div>;
  }

  const update = (patch: Partial<PartnerConfig>) => setConfig({ ...config, ...patch });

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    try {
      const { id, user_id, created_at, updated_at, total_prospects_found, total_emails_sent, total_replies, total_active_partners, total_revenue_generated, ...patch } = config;
      void id; void user_id; void created_at; void updated_at;
      void total_prospects_found; void total_emails_sent; void total_replies;
      void total_active_partners; void total_revenue_generated;
      await updatePartnerConfig(user.id, patch);
      toast.success('✅ Paramètres enregistrés');
    } catch (e) {
      toast.error('Erreur de sauvegarde', { description: e instanceof Error ? e.message : String(e) });
    } finally { setSaving(false); }
  };

  const handleUpload = async (file: File) => {
    if (!user) return;
    setUploading(true);
    try {
      const url = await uploadSignature(user.id, file);
      update({ signature_image_url: url });
      toast.success('✅ Signature chargée');
    } catch (e) {
      toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
    } finally { setUploading(false); }
  };

  const toggleNiche = (n: string) => {
    const set = new Set(config.target_niches);
    if (set.has(n)) set.delete(n); else set.add(n);
    update({ target_niches: [...set] });
  };

  const toggleDay = (d: string) => {
    const set = new Set(config.outreach_days);
    if (set.has(d)) set.delete(d); else set.add(d);
    update({ outreach_days: [...set] });
  };

  return (
    <div className="space-y-6 max-w-3xl mx-auto pb-12">
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between">
        <div>
          <Link to="/dashboard/partner-agent" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-1">
            <ArrowLeft className="w-3 h-3" /> Retour
          </Link>
          <h1 className="text-2xl font-orbitron font-bold text-foreground">Paramètres partenariat</h1>
        </div>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
          Enregistrer
        </Button>
      </motion.div>

      {/* Sender identity */}
      <Card className="bg-card border-border">
        <CardContent className="p-5 space-y-4">
          <h2 className="font-semibold text-foreground flex items-center gap-2">
            <User className="w-4 h-4 text-accent-cyan" /> Identité expéditeur
          </h2>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Nom complet</Label>
              <Input value={config.sender_name ?? ''} onChange={e => update({ sender_name: e.target.value })} className="mt-1.5" placeholder="Tissma Dornier" />
            </div>
            <div>
              <Label className="text-xs">Email d'envoi</Label>
              <Input type="email" value={config.sender_email ?? ''} onChange={e => update({ sender_email: e.target.value })} className="mt-1.5" placeholder="tissma@purama.dev" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Titre</Label>
              <Input value={config.sender_title ?? ''} onChange={e => update({ sender_title: e.target.value })} className="mt-1.5" placeholder="Fondateur de Purama" />
            </div>
            <div>
              <Label className="text-xs">Société</Label>
              <Input value={config.company_name} onChange={e => update({ company_name: e.target.value })} className="mt-1.5" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Signature */}
      <Card className="bg-card border-border">
        <CardContent className="p-5 space-y-4">
          <h2 className="font-semibold text-foreground flex items-center gap-2">
            <ImageIcon className="w-4 h-4 text-accent-purple" /> Signature manuscrite
          </h2>
          {config.signature_image_url ? (
            <div className="rounded-lg border border-border bg-secondary/20 p-4 flex items-center gap-3">
              <img src={config.signature_image_url} alt="Signature" className="max-h-20 max-w-[200px] bg-white rounded p-1" />
              <Button variant="ghost" size="sm" onClick={() => update({ signature_image_url: null })} className="text-red-400 ml-auto">
                <X className="w-3 h-3 mr-1" /> Retirer
              </Button>
            </div>
          ) : (
            <label className="block cursor-pointer">
              <input
                type="file"
                accept="image/png,image/jpeg"
                className="hidden"
                onChange={e => e.target.files?.[0] && handleUpload(e.target.files[0])}
              />
              <div className="rounded-lg border-2 border-dashed border-border hover:border-accent-cyan/50 p-6 text-center transition-colors">
                {uploading ? (
                  <Loader2 className="w-6 h-6 animate-spin text-accent-cyan mx-auto" />
                ) : (
                  <>
                    <ImageIcon className="w-6 h-6 text-muted-foreground mx-auto mb-2" />
                    <p className="text-sm text-foreground">Upload ta signature (PNG/JPG)</p>
                    <p className="text-[10px] text-muted-foreground mt-1">Sera intégrée automatiquement dans chaque contrat</p>
                  </>
                )}
              </div>
            </label>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Nom signature</Label>
              <Input value={config.signature_name ?? ''} onChange={e => update({ signature_name: e.target.value })} className="mt-1.5" />
            </div>
            <div>
              <Label className="text-xs">Titre signature</Label>
              <Input value={config.signature_title ?? ''} onChange={e => update({ signature_title: e.target.value })} className="mt-1.5" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tone */}
      <Card className="bg-card border-border">
        <CardContent className="p-5 space-y-4">
          <h2 className="font-semibold text-foreground flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-accent-purple" /> Ton de communication
          </h2>
          <div>
            <Label className="text-xs">Ton</Label>
            <Select value={config.outreach_tone} onValueChange={v => update({ outreach_tone: v })}>
              <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
              <SelectContent>
                {TONES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {config.outreach_tone === 'custom' && (
            <div>
              <Label className="text-xs">Prompt personnalisé</Label>
              <Textarea
                rows={3}
                value={config.custom_tone_prompt ?? ''}
                onChange={e => update({ custom_tone_prompt: e.target.value })}
                className="mt-1.5"
                placeholder="Ex : Toujours commencer par une référence à leur dernier contenu, ton chaleureux mais pro, max 6 lignes…"
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Outreach throttle */}
      <Card className="bg-card border-border">
        <CardContent className="p-5 space-y-4">
          <h2 className="font-semibold text-foreground flex items-center gap-2">
            <Clock className="w-4 h-4 text-yellow-400" /> Plages d'envoi
          </h2>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label className="text-xs">Limite/jour</Label>
              <Input type="number" min={1} max={200} value={config.daily_outreach_limit} onChange={e => update({ daily_outreach_limit: parseInt(e.target.value || '20', 10) })} className="mt-1.5" />
            </div>
            <div>
              <Label className="text-xs">Début</Label>
              <Input type="time" value={config.outreach_hours_start} onChange={e => update({ outreach_hours_start: e.target.value })} className="mt-1.5" />
            </div>
            <div>
              <Label className="text-xs">Fin</Label>
              <Input type="time" value={config.outreach_hours_end} onChange={e => update({ outreach_hours_end: e.target.value })} className="mt-1.5" />
            </div>
          </div>
          <div>
            <Label className="text-xs">Jours d'envoi</Label>
            <div className="flex gap-1.5 mt-1.5">
              {DAYS.map(d => (
                <button
                  key={d.v}
                  type="button"
                  onClick={() => toggleDay(d.v)}
                  className={`w-9 h-9 rounded-full text-xs font-semibold transition-colors ${
                    config.outreach_days.includes(d.v)
                      ? 'bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30'
                      : 'bg-secondary text-muted-foreground border border-border'
                  }`}
                >
                  {d.l}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3 pt-2 border-t border-border">
            <div>
              <Label className="text-xs">Relance 1 (j)</Label>
              <Input type="number" min={1} value={config.relance_1_delay_days} onChange={e => update({ relance_1_delay_days: parseInt(e.target.value || '3', 10) })} className="mt-1.5" />
            </div>
            <div>
              <Label className="text-xs">Relance 2 (j)</Label>
              <Input type="number" min={1} value={config.relance_2_delay_days} onChange={e => update({ relance_2_delay_days: parseInt(e.target.value || '7', 10) })} className="mt-1.5" />
            </div>
            <div>
              <Label className="text-xs">Relance 3 (j)</Label>
              <Input type="number" min={1} value={config.relance_3_delay_days} onChange={e => update({ relance_3_delay_days: parseInt(e.target.value || '14', 10) })} className="mt-1.5" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Commissions */}
      <Card className="bg-card border-border">
        <CardContent className="p-5 space-y-4">
          <h2 className="font-semibold text-foreground flex items-center gap-2">
            <DollarSign className="w-4 h-4 text-emerald-400" /> Commissions
          </h2>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">1er paiement (%)</Label>
              <Input type="number" min={0} max={100} step="0.5" value={config.commission_first_payment} onChange={e => update({ commission_first_payment: parseFloat(e.target.value || '50') })} className="mt-1.5" />
            </div>
            <div>
              <Label className="text-xs">Récurrent (%)</Label>
              <Input type="number" min={0} max={100} step="0.5" value={config.commission_recurring} onChange={e => update({ commission_recurring: parseFloat(e.target.value || '10') })} className="mt-1.5" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Targeting */}
      <Card className="bg-card border-border">
        <CardContent className="p-5 space-y-4">
          <h2 className="font-semibold text-foreground">Ciblage</h2>
          <div>
            <Label className="text-xs">Niches recherchées</Label>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {NICHES.map(n => (
                <button
                  key={n}
                  type="button"
                  onClick={() => toggleNiche(n)}
                  className={`px-2.5 py-1 rounded-full text-[11px] transition-colors ${
                    config.target_niches.includes(n)
                      ? 'bg-accent-purple/20 text-accent-purple border border-accent-purple/30'
                      : 'bg-secondary text-muted-foreground border border-border'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          <div>
            <Label className="text-xs">Followers minimum</Label>
            <Input type="number" min={0} value={config.target_min_followers} onChange={e => update({ target_min_followers: parseInt(e.target.value || '1000', 10) })} className="mt-1.5 max-w-[200px]" />
          </div>
        </CardContent>
      </Card>

      {/* Approvals */}
      <Card className="bg-card border-border">
        <CardContent className="p-5 space-y-4">
          <h2 className="font-semibold text-foreground">Validations</h2>
          <ToggleRow label="Valider chaque nouveau prospect avant envoi" sub="Recommandé au début" checked={config.require_approval_new_prospect} onChange={v => update({ require_approval_new_prospect: v })} />
          <ToggleRow label="Valider chaque email avant envoi" sub="Sinon l'IA envoie directement" checked={config.require_approval_outreach} onChange={v => update({ require_approval_outreach: v })} />
          <ToggleRow label="Valider chaque contrat avant envoi" sub="Très recommandé" checked={config.require_approval_contract} onChange={v => update({ require_approval_contract: v })} />
          <ToggleRow label="Auto-envoyer le contrat dès qu'un prospect est intéressé" checked={config.auto_send_contract} onChange={v => update({ auto_send_contract: v })} />
        </CardContent>
      </Card>
    </div>
  );
}

function ToggleRow({ label, sub, checked, onChange }: { label: string; sub?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex-1">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
