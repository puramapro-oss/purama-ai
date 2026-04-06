import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Loader2, Plus, Trash2, Sparkles, Pencil } from 'lucide-react';
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
  listRules, createRule, updateRule, deleteRule,
  type EmailAgentRule, type EmailAction,
} from '@/lib/email-agent';

const ACTION_OPTIONS: { value: EmailAction; label: string }[] = [
  { value: 'auto_reply', label: '⚡ Réponse automatique' },
  { value: 'draft', label: '📝 Créer un brouillon' },
  { value: 'notify', label: '🔔 Me notifier' },
  { value: 'archive', label: '📦 Archiver' },
  { value: 'ignore', label: '➖ Ignorer' },
  { value: 'forward', label: '➡️ Transférer' },
  { value: 'label', label: '🏷️ Étiqueter' },
];

const PRESETS: Partial<EmailAgentRule>[] = [
  {
    rule_name: 'Impôts → Notification urgente',
    condition_from_domain: 'impots.gouv.fr',
    action: 'notify',
    action_notify_message: 'Email administratif important reçu',
    priority: 100,
  },
  {
    rule_name: 'Newsletters → Archiver',
    condition_subject_contains: 'newsletter',
    action: 'archive',
    priority: 10,
  },
  {
    rule_name: 'Stripe → Notification',
    condition_from_domain: 'stripe.com',
    action: 'notify',
    priority: 80,
  },
];

const emptyRule = (): Partial<EmailAgentRule> => ({
  rule_name: '',
  is_active: true,
  priority: 50,
  condition_from_email: null,
  condition_from_domain: null,
  condition_subject_contains: null,
  condition_body_contains: null,
  condition_category: null,
  action: 'notify',
  action_reply_template: null,
  action_forward_to: null,
  action_label: null,
  action_notify_message: null,
});

export default function EmailAgentRules() {
  const { user } = useAuth();
  const [rules, setRules] = useState<EmailAgentRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<EmailAgentRule> | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    if (!user) return;
    setLoading(true);
    try { setRules(await listRules(user.id)); }
    catch (e) { toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setLoading(false); }
  };
  useEffect(() => { refresh(); /* eslint-disable-line */ }, [user?.id]);

  const handleSave = async () => {
    if (!user || !editing || !editing.rule_name?.trim()) return;
    setBusy(true);
    try {
      if (editing.id) {
        const { id, user_id, created_at, updated_at, match_count, ...patch } = editing as EmailAgentRule;
        void user_id; void created_at; void updated_at; void match_count;
        await updateRule(id, patch);
      } else {
        await createRule(user.id, editing);
      }
      toast.success('✅ Règle enregistrée');
      setEditing(null);
      refresh();
    } catch (e) {
      toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Supprimer cette règle ?')) return;
    try { await deleteRule(id); toast.success('Supprimée'); refresh(); }
    catch (e) { toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) }); }
  };

  const handleToggle = async (rule: EmailAgentRule) => {
    try {
      await updateRule(rule.id, { is_active: !rule.is_active });
      refresh();
    } catch (e) { toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) }); }
  };

  const addPreset = async (preset: Partial<EmailAgentRule>) => {
    if (!user) return;
    try {
      await createRule(user.id, { ...emptyRule(), ...preset });
      toast.success('Règle ajoutée');
      refresh();
    } catch (e) { toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) }); }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto pb-12">
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between">
        <div>
          <Link to="/dashboard/email-agent" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-1">
            <ArrowLeft className="w-3 h-3" /> Retour
          </Link>
          <h1 className="text-2xl font-orbitron font-bold text-foreground flex items-center gap-2">
            <Sparkles className="w-6 h-6 text-accent-purple" /> Règles personnalisées
          </h1>
          <p className="text-sm text-muted-foreground">Les règles s'appliquent en priorité, avant l'IA.</p>
        </div>
        <Button onClick={() => setEditing(emptyRule())}>
          <Plus className="w-4 h-4 mr-2" /> Nouvelle règle
        </Button>
      </motion.div>

      {/* Presets */}
      {rules.length === 0 && !loading && (
        <Card className="bg-card border-border">
          <CardContent className="p-5 space-y-3">
            <p className="text-sm font-medium text-foreground">Démarre vite avec ces règles populaires :</p>
            <div className="grid sm:grid-cols-3 gap-2">
              {PRESETS.map(p => (
                <button
                  key={p.rule_name}
                  onClick={() => addPreset(p)}
                  className="text-left p-3 rounded-lg border border-border bg-secondary/30 hover:bg-secondary/50 transition-colors"
                >
                  <p className="text-xs font-medium text-foreground">{p.rule_name}</p>
                  <p className="text-[10px] text-muted-foreground mt-1">+ Ajouter</p>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-accent-cyan" /></div>
      ) : rules.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            Aucune règle pour l'instant.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {rules.map(rule => (
            <Card key={rule.id} className="bg-card border-border">
              <CardContent className="p-4 flex items-start gap-3">
                <Switch checked={rule.is_active} onCheckedChange={() => handleToggle(rule)} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-medium text-foreground">{rule.rule_name}</p>
                    <Badge variant="outline" className="text-[10px]">Priorité {rule.priority}</Badge>
                    <Badge variant="secondary" className="text-[10px]">
                      {ACTION_OPTIONS.find(a => a.value === rule.action)?.label ?? rule.action}
                    </Badge>
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-1 space-x-2">
                    {rule.condition_from_email && <span>de: {rule.condition_from_email}</span>}
                    {rule.condition_from_domain && <span>domaine: @{rule.condition_from_domain}</span>}
                    {rule.condition_subject_contains && <span>objet: « {rule.condition_subject_contains} »</span>}
                    {rule.condition_body_contains && <span>corps: « {rule.condition_body_contains} »</span>}
                    {rule.condition_category && <span>catégorie: {rule.condition_category}</span>}
                  </div>
                  {rule.match_count > 0 && (
                    <p className="text-[10px] text-accent-cyan mt-1">
                      Appliquée {rule.match_count} fois
                    </p>
                  )}
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" onClick={() => setEditing(rule)}><Pencil className="w-4 h-4" /></Button>
                  <Button variant="ghost" size="icon" onClick={() => handleDelete(rule.id)} className="text-red-400"><Trash2 className="w-4 h-4" /></Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Editor */}
      <Dialog open={!!editing} onOpenChange={o => !o && setEditing(null)}>
        <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing?.id ? 'Modifier la règle' : 'Nouvelle règle'}</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-3">
              <div>
                <Label className="text-xs">Nom</Label>
                <Input value={editing.rule_name ?? ''} onChange={e => setEditing({ ...editing, rule_name: e.target.value })} className="mt-1.5" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">Email expéditeur (contient)</Label>
                  <Input value={editing.condition_from_email ?? ''} onChange={e => setEditing({ ...editing, condition_from_email: e.target.value || null })} className="mt-1.5" />
                </div>
                <div>
                  <Label className="text-xs">Domaine expéditeur</Label>
                  <Input placeholder="exemple.com" value={editing.condition_from_domain ?? ''} onChange={e => setEditing({ ...editing, condition_from_domain: e.target.value || null })} className="mt-1.5" />
                </div>
              </div>
              <div>
                <Label className="text-xs">Objet contient</Label>
                <Input value={editing.condition_subject_contains ?? ''} onChange={e => setEditing({ ...editing, condition_subject_contains: e.target.value || null })} className="mt-1.5" />
              </div>
              <div>
                <Label className="text-xs">Corps contient</Label>
                <Input value={editing.condition_body_contains ?? ''} onChange={e => setEditing({ ...editing, condition_body_contains: e.target.value || null })} className="mt-1.5" />
              </div>
              <div>
                <Label className="text-xs">Action</Label>
                <Select value={editing.action} onValueChange={(v: EmailAction) => setEditing({ ...editing, action: v })}>
                  <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ACTION_OPTIONS.map(a => <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {editing.action === 'auto_reply' && (
                <div>
                  <Label className="text-xs">Template de réponse</Label>
                  <Textarea rows={4} value={editing.action_reply_template ?? ''} onChange={e => setEditing({ ...editing, action_reply_template: e.target.value })} className="mt-1.5" />
                </div>
              )}
              {editing.action === 'forward' && (
                <div>
                  <Label className="text-xs">Transférer à</Label>
                  <Input type="email" value={editing.action_forward_to ?? ''} onChange={e => setEditing({ ...editing, action_forward_to: e.target.value })} className="mt-1.5" />
                </div>
              )}
              {editing.action === 'label' && (
                <div>
                  <Label className="text-xs">Label Gmail</Label>
                  <Input value={editing.action_label ?? ''} onChange={e => setEditing({ ...editing, action_label: e.target.value })} className="mt-1.5" />
                </div>
              )}
              <div>
                <Label className="text-xs">Priorité (0-100)</Label>
                <Input type="number" min={0} max={100} value={editing.priority ?? 50} onChange={e => setEditing({ ...editing, priority: parseInt(e.target.value || '0', 10) })} className="mt-1.5" />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Annuler</Button>
            <Button onClick={handleSave} disabled={busy || !editing?.rule_name?.trim()}>
              {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Enregistrer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
