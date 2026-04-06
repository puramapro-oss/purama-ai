import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Loader2, Plus, Trash2, BookOpen, Pencil } from 'lucide-react';
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
  listTemplates, createTemplate, updateTemplate, deleteTemplate,
  type EmailAgentTemplate,
} from '@/lib/email-agent';

const CATEGORIES = ['confirmation', 'remerciement', 'relance', 'partenariat', 'facturation', 'support', 'custom'];

const empty = (): Partial<EmailAgentTemplate> => ({
  template_name: '',
  template_category: 'custom',
  subject_template: '',
  body_template: '',
  is_active: true,
});

const extractVariables = (text: string): string[] => {
  const re = /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi;
  const out = new Set<string>();
  let m;
  while ((m = re.exec(text)) !== null) out.add(m[1]);
  return [...out];
};

export default function EmailAgentTemplates() {
  const { user } = useAuth();
  const [templates, setTemplates] = useState<EmailAgentTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<EmailAgentTemplate> | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    if (!user) return;
    setLoading(true);
    try { setTemplates(await listTemplates(user.id)); }
    catch (e) { toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setLoading(false); }
  };
  useEffect(() => { refresh(); /* eslint-disable-line */ }, [user?.id]);

  const handleSave = async () => {
    if (!user || !editing || !editing.template_name?.trim() || !editing.body_template?.trim()) return;
    setBusy(true);
    try {
      const variables = extractVariables(`${editing.subject_template ?? ''} ${editing.body_template ?? ''}`);
      const payload = { ...editing, variables };
      if (editing.id) {
        const { id, user_id, created_at, updated_at, usage_count, ...patch } = payload as EmailAgentTemplate;
        void user_id; void created_at; void updated_at; void usage_count;
        await updateTemplate(id, patch);
      } else {
        await createTemplate(user.id, payload);
      }
      toast.success('✅ Template enregistré');
      setEditing(null);
      refresh();
    } catch (e) { toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Supprimer ce template ?')) return;
    try { await deleteTemplate(id); toast.success('Supprimé'); refresh(); }
    catch (e) { toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) }); }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto pb-12">
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between">
        <div>
          <Link to="/dashboard/email-agent" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-1">
            <ArrowLeft className="w-3 h-3" /> Retour
          </Link>
          <h1 className="text-2xl font-orbitron font-bold text-foreground flex items-center gap-2">
            <BookOpen className="w-6 h-6 text-accent-purple" /> Templates de réponses
          </h1>
          <p className="text-sm text-muted-foreground">Utilise <code className="text-accent-cyan">{'{{nom}}'}</code> pour insérer des variables.</p>
        </div>
        <Button onClick={() => setEditing(empty())}>
          <Plus className="w-4 h-4 mr-2" /> Nouveau
        </Button>
      </motion.div>

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-accent-cyan" /></div>
      ) : templates.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">Aucun template.</CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {templates.map(t => (
            <Card key={t.id} className="bg-card border-border">
              <CardContent className="p-4 flex items-start gap-3">
                <Switch checked={t.is_active} onCheckedChange={async v => { await updateTemplate(t.id, { is_active: v }); refresh(); }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-medium text-foreground">{t.template_name}</p>
                    {t.template_category && <Badge variant="outline" className="text-[10px]">{t.template_category}</Badge>}
                    {t.usage_count > 0 && <span className="text-[10px] text-accent-cyan">Utilisé {t.usage_count}×</span>}
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1 line-clamp-2 whitespace-pre-wrap">{t.body_template}</p>
                  {t.variables.length > 0 && (
                    <div className="flex gap-1 mt-1.5 flex-wrap">
                      {t.variables.map(v => <Badge key={v} variant="secondary" className="text-[10px] py-0 h-4">{`{{${v}}}`}</Badge>)}
                    </div>
                  )}
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" onClick={() => setEditing(t)}><Pencil className="w-4 h-4" /></Button>
                  <Button variant="ghost" size="icon" onClick={() => handleDelete(t.id)} className="text-red-400"><Trash2 className="w-4 h-4" /></Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!editing} onOpenChange={o => !o && setEditing(null)}>
        <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing?.id ? 'Modifier le template' : 'Nouveau template'}</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-3">
              <div>
                <Label className="text-xs">Nom</Label>
                <Input value={editing.template_name ?? ''} onChange={e => setEditing({ ...editing, template_name: e.target.value })} className="mt-1.5" />
              </div>
              <div>
                <Label className="text-xs">Catégorie</Label>
                <Select value={editing.template_category ?? 'custom'} onValueChange={v => setEditing({ ...editing, template_category: v })}>
                  <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Objet</Label>
                <Input value={editing.subject_template ?? ''} placeholder="Re: {{sujet}}" onChange={e => setEditing({ ...editing, subject_template: e.target.value })} className="mt-1.5" />
              </div>
              <div>
                <Label className="text-xs">Corps</Label>
                <Textarea rows={8} value={editing.body_template ?? ''} placeholder={'Bonjour {{nom}},\n\nMerci pour votre message…\n\nCordialement'} onChange={e => setEditing({ ...editing, body_template: e.target.value })} className="mt-1.5 font-mono text-xs" />
              </div>
              {editing.body_template && extractVariables(`${editing.subject_template ?? ''} ${editing.body_template}`).length > 0 && (
                <div className="text-[11px] text-muted-foreground">
                  Variables détectées :{' '}
                  {extractVariables(`${editing.subject_template ?? ''} ${editing.body_template}`).map(v => (
                    <Badge key={v} variant="secondary" className="text-[10px] mr-1">{`{{${v}}}`}</Badge>
                  ))}
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Annuler</Button>
            <Button onClick={handleSave} disabled={busy || !editing?.template_name?.trim() || !editing?.body_template?.trim()}>
              {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Enregistrer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
