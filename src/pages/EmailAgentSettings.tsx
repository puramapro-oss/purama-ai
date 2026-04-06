import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft, Save, Loader2, Mail, Trash2, Plus, X, Plane,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import {
  getConfig, updateConfig, getGmailOAuthUrl, disconnectGmail,
  TONES, type EmailAgentConfig, type ToneId,
} from '@/lib/email-agent';

export default function EmailAgentSettings() {
  const { user } = useAuth();
  const [config, setConfig] = useState<EmailAgentConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newExcludedEmail, setNewExcludedEmail] = useState('');
  const [newExcludedDomain, setNewExcludedDomain] = useState('');

  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        setConfig(await getConfig(user.id));
      } catch (e) {
        toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
      } finally {
        setLoading(false);
      }
    })();
  }, [user?.id]);

  if (loading || !config) {
    return <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-accent-cyan" /></div>;
  }

  const update = (patch: Partial<EmailAgentConfig>) => setConfig({ ...config, ...patch });

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    try {
      const { id, user_id, created_at, updated_at, total_processed, total_auto_replied, total_drafted, total_notified, total_archived, estimated_time_saved_minutes, last_sync_at, gmail_email, ...patch } = config;
      void id; void user_id; void created_at; void updated_at;
      void total_processed; void total_auto_replied; void total_drafted; void total_notified; void total_archived;
      void estimated_time_saved_minutes; void last_sync_at; void gmail_email;
      await updateConfig(user.id, patch);
      toast.success('✅ Paramètres enregistrés');
    } catch (e) {
      toast.error('Erreur de sauvegarde', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  const addExcludedEmail = () => {
    const v = newExcludedEmail.trim().toLowerCase();
    if (!v || config.excluded_emails.includes(v)) return;
    update({ excluded_emails: [...config.excluded_emails, v] });
    setNewExcludedEmail('');
  };
  const addExcludedDomain = () => {
    const v = newExcludedDomain.trim().toLowerCase().replace(/^@/, '');
    if (!v || config.excluded_domains.includes(v)) return;
    update({ excluded_domains: [...config.excluded_domains, v] });
    setNewExcludedDomain('');
  };

  const handleConnectGmail = async () => {
    try {
      const url = await getGmailOAuthUrl();
      window.location.href = url;
    } catch (e) {
      toast.error('Erreur OAuth', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const handleDisconnect = async () => {
    if (!user) return;
    if (!confirm('Déconnecter Gmail ? L\'agent sera désactivé.')) return;
    try {
      await disconnectGmail(user.id);
      setConfig({ ...config, gmail_email: null, is_active: false });
      toast.success('Gmail déconnecté');
    } catch (e) {
      toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="space-y-6 max-w-3xl mx-auto pb-12">
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between">
        <div>
          <Link to="/dashboard/email-agent" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-1">
            <ArrowLeft className="w-3 h-3" /> Retour
          </Link>
          <h1 className="text-2xl font-orbitron font-bold text-foreground">Paramètres de l'agent</h1>
        </div>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
          Enregistrer
        </Button>
      </motion.div>

      {/* Gmail */}
      <Card className="bg-card border-border">
        <CardContent className="p-5 space-y-3">
          <h2 className="font-semibold text-foreground flex items-center gap-2">
            <Mail className="w-4 h-4 text-accent-cyan" /> Compte Gmail
          </h2>
          {config.gmail_email ? (
            <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
              <div>
                <p className="text-sm font-medium text-foreground">{config.gmail_email}</p>
                <p className="text-[11px] text-muted-foreground">Connecté ✅</p>
              </div>
              <Button variant="outline" size="sm" onClick={handleDisconnect} className="text-red-400 hover:text-red-300">
                <Trash2 className="w-3 h-3 mr-1" /> Déconnecter
              </Button>
            </div>
          ) : (
            <Button onClick={handleConnectGmail} className="w-full">
              <Mail className="w-4 h-4 mr-2" /> Connecter un compte Gmail
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Tone & signature */}
      <Card className="bg-card border-border">
        <CardContent className="p-5 space-y-4">
          <h2 className="font-semibold text-foreground">Voix & ton</h2>
          <div>
            <Label className="text-xs">Ton de réponse</Label>
            <Select value={config.tone} onValueChange={(v: ToneId) => update({ tone: v })}>
              <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(TONES).map(([id, t]) => (
                  <SelectItem key={id} value={id}>
                    {t.label} <span className="text-muted-foreground text-[11px]">— {t.description}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {config.tone === 'custom' && (
            <div>
              <Label className="text-xs">Prompt personnalisé</Label>
              <Textarea
                rows={3}
                placeholder="Ex : Réponds toujours avec un ton chaleureux, en utilisant 'tu', avec une touche d'humour discret…"
                value={config.custom_tone_prompt ?? ''}
                onChange={e => update({ custom_tone_prompt: e.target.value })}
                className="mt-1.5"
              />
            </div>
          )}
          <div>
            <Label className="text-xs">Signature email</Label>
            <Textarea
              rows={4}
              placeholder={'Ex :\nMatiss Dornier\nFondateur — Purama\nmatiss@purama.dev'}
              value={config.signature}
              onChange={e => update({ signature: e.target.value })}
              className="mt-1.5 font-mono text-xs"
            />
          </div>
          <div>
            <Label className="text-xs">Langue de réponse</Label>
            <Select value={config.language} onValueChange={v => update({ language: v })}>
              <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="fr">Français</SelectItem>
                <SelectItem value="en">English</SelectItem>
                <SelectItem value="es">Español</SelectItem>
                <SelectItem value="de">Deutsch</SelectItem>
                <SelectItem value="it">Italiano</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Working hours + digest */}
      <Card className="bg-card border-border">
        <CardContent className="p-5 space-y-4">
          <h2 className="font-semibold text-foreground">Horaires & rapports</h2>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">Heures de travail uniquement</p>
              <p className="text-[11px] text-muted-foreground">L'agent ne répond qu'aux heures définies.</p>
            </div>
            <Switch checked={config.working_hours_only} onCheckedChange={v => update({ working_hours_only: v })} />
          </div>
          {config.working_hours_only && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Début</Label>
                <Input type="time" value={config.working_hours_start} onChange={e => update({ working_hours_start: e.target.value })} className="mt-1.5" />
              </div>
              <div>
                <Label className="text-xs">Fin</Label>
                <Input type="time" value={config.working_hours_end} onChange={e => update({ working_hours_end: e.target.value })} className="mt-1.5" />
              </div>
            </div>
          )}
          <div className="pt-3 border-t border-border flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">Rapport quotidien</p>
              <p className="text-[11px] text-muted-foreground">Reçois un récap chaque matin.</p>
            </div>
            <Switch checked={config.daily_digest} onCheckedChange={v => update({ daily_digest: v })} />
          </div>
          {config.daily_digest && (
            <div>
              <Label className="text-xs">Heure du rapport</Label>
              <Input type="time" value={config.daily_digest_time} onChange={e => update({ daily_digest_time: e.target.value })} className="mt-1.5 max-w-[140px]" />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Vacation mode */}
      <Card className="bg-card border-border">
        <CardContent className="p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-foreground flex items-center gap-2">
              <Plane className="w-4 h-4 text-accent-purple" /> Mode vacances
            </h2>
            <Switch checked={config.vacation_mode} onCheckedChange={v => update({ vacation_mode: v })} />
          </div>
          {config.vacation_mode && (
            <Textarea
              rows={4}
              placeholder="Bonjour, je suis actuellement en congés jusqu'au … Je reviendrai vers vous à mon retour. Pour toute urgence, contactez …"
              value={config.vacation_message ?? ''}
              onChange={e => update({ vacation_message: e.target.value })}
            />
          )}
        </CardContent>
      </Card>

      {/* Exclusions */}
      <Card className="bg-card border-border">
        <CardContent className="p-5 space-y-4">
          <h2 className="font-semibold text-foreground">Exclusions</h2>
          <p className="text-[11px] text-muted-foreground">L'agent ignorera totalement ces emails et domaines.</p>
          <div>
            <Label className="text-xs">Emails exclus</Label>
            <div className="flex gap-2 mt-1.5">
              <Input placeholder="exemple@domaine.com" value={newExcludedEmail} onChange={e => setNewExcludedEmail(e.target.value)} onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addExcludedEmail())} />
              <Button type="button" variant="outline" size="icon" onClick={addExcludedEmail}><Plus className="w-4 h-4" /></Button>
            </div>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {config.excluded_emails.map(e => (
                <Badge key={e} variant="secondary" className="gap-1">
                  {e}
                  <button type="button" onClick={() => update({ excluded_emails: config.excluded_emails.filter(x => x !== e) })}>
                    <X className="w-3 h-3" />
                  </button>
                </Badge>
              ))}
            </div>
          </div>
          <div>
            <Label className="text-xs">Domaines exclus</Label>
            <div className="flex gap-2 mt-1.5">
              <Input placeholder="domaine.com" value={newExcludedDomain} onChange={e => setNewExcludedDomain(e.target.value)} onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addExcludedDomain())} />
              <Button type="button" variant="outline" size="icon" onClick={addExcludedDomain}><Plus className="w-4 h-4" /></Button>
            </div>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {config.excluded_domains.map(d => (
                <Badge key={d} variant="secondary" className="gap-1">
                  @{d}
                  <button type="button" onClick={() => update({ excluded_domains: config.excluded_domains.filter(x => x !== d) })}>
                    <X className="w-3 h-3" />
                  </button>
                </Badge>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
