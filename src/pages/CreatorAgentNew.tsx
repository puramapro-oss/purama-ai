import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Sparkles, Loader2, Save, Wand2, Edit3 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Tabs, TabsContent, TabsList, TabsTrigger,
} from '@/components/ui/tabs';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import {
  generateAgent, createAgent,
  CATEGORIES, MODELS, TOOL_OPTIONS,
  type AgentCategory, type AgentModel,
} from '@/lib/creator-agent';

interface DraftAgent {
  name: string;
  description: string;
  emoji: string;
  color: string;
  category: AgentCategory;
  system_prompt: string;
  model: AgentModel;
  temperature: number;
  tools_enabled: string[];
  schedule_cron: string | null;
}

const blank = (): DraftAgent => ({
  name: '',
  description: '',
  emoji: '🤖',
  color: '#8B5CF6',
  category: 'productivity',
  system_prompt: '',
  model: 'claude-sonnet-4-20250514',
  temperature: 0.7,
  tools_enabled: [],
  schedule_cron: null,
});

export default function CreatorAgentNew() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [aiDescription, setAiDescription] = useState('');
  const [generating, setGenerating] = useState(false);
  const [draft, setDraft] = useState<DraftAgent>(blank());
  const [saving, setSaving] = useState(false);

  const handleGenerate = async () => {
    if (!aiDescription.trim()) {
      toast.error('Décris l\'agent que tu veux');
      return;
    }
    setGenerating(true);
    try {
      const g = await generateAgent(aiDescription);
      setDraft({
        name: g.name,
        description: g.description,
        emoji: g.emoji || '🤖',
        color: g.color || '#8B5CF6',
        category: g.category,
        system_prompt: g.system_prompt,
        model: g.suggested_model,
        temperature: g.suggested_temperature,
        tools_enabled: g.suggested_tools ?? [],
        schedule_cron: g.suggested_schedule ?? null,
      });
      toast.success('✨ Agent généré', { description: 'Vérifie le prompt et clique « Créer »' });
    } catch (e) {
      toast.error('Erreur génération', { description: e instanceof Error ? e.message : String(e) });
    } finally { setGenerating(false); }
  };

  const handleSave = async () => {
    if (!user || !draft.name.trim() || !draft.system_prompt.trim()) {
      toast.error('Renseigne au moins le nom et le prompt système');
      return;
    }
    setSaving(true);
    try {
      const a = await createAgent(user.id, draft);
      toast.success(`✅ ${a.name} créé`);
      nav(`/dashboard/creator-agent/${a.id}`);
    } catch (e) {
      toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-6 max-w-3xl mx-auto pb-12">
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}>
        <Link to="/dashboard/creator-agent" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-1">
          <ArrowLeft className="w-3 h-3" /> Retour
        </Link>
        <h1 className="text-2xl font-orbitron font-bold text-foreground flex items-center gap-2">
          <Sparkles className="w-6 h-6 text-accent-purple" /> Créer un agent
        </h1>
      </motion.div>

      <Tabs defaultValue="ai">
        <TabsList>
          <TabsTrigger value="ai"><Wand2 className="w-4 h-4 mr-2" /> Mode IA</TabsTrigger>
          <TabsTrigger value="manual"><Edit3 className="w-4 h-4 mr-2" /> Mode manuel</TabsTrigger>
        </TabsList>

        <TabsContent value="ai">
          <Card className="bg-card border-border">
            <CardContent className="p-5 space-y-4">
              <div>
                <Label className="text-xs">Décris l'agent que tu veux</Label>
                <Textarea
                  rows={5}
                  value={aiDescription}
                  onChange={e => setAiDescription(e.target.value)}
                  className="mt-1.5"
                  placeholder="Ex : Je veux un agent qui répond aux DM Instagram avec mon style chaleureux et qui propose toujours de prendre rendez-vous via mon Calendly. Il doit éviter les emojis."
                />
                <p className="text-[10px] text-muted-foreground mt-1">
                  Plus tu es précis (ton, contexte, exemples), meilleur sera le résultat.
                </p>
              </div>
              <Button onClick={handleGenerate} disabled={generating || !aiDescription.trim()} className="w-full">
                {generating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
                Générer l'agent
              </Button>
            </CardContent>
          </Card>

          {/* Preview after generation */}
          {draft.name && (
            <Card className="bg-card border-border mt-4">
              <CardContent className="p-5 space-y-4">
                <div className="flex items-start gap-3 pb-3 border-b border-border">
                  <div className="text-4xl">{draft.emoji}</div>
                  <div className="flex-1 min-w-0">
                    <p className="text-lg font-semibold text-foreground">{draft.name}</p>
                    <p className="text-xs text-muted-foreground">{draft.description}</p>
                    <Badge variant="outline" className="mt-2 text-[10px]">{draft.category}</Badge>
                  </div>
                </div>
                <DraftEditor draft={draft} setDraft={setDraft} />
                {(draft.tools_enabled.length > 0 || draft.schedule_cron) && (
                  <div className="p-3 rounded-lg bg-accent-cyan/10 border border-accent-cyan/20 space-y-2">
                    <p className="text-[11px] text-muted-foreground">
                      Une fois créé, active « Exécution réelle » dans ses réglages pour qu'il fasse
                      vraiment ces actions (validation avant chaque envoi sensible) :
                    </p>
                    {draft.tools_enabled.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {draft.tools_enabled.map((t) => (
                          <Badge key={t} variant="outline" className="text-[10px]">
                            {TOOL_OPTIONS.find((o) => o.value === t)?.label ?? t}
                          </Badge>
                        ))}
                      </div>
                    )}
                    {draft.schedule_cron && (
                      <p className="text-[11px] text-accent-cyan">
                        Planification suggérée : <code className="font-mono">{draft.schedule_cron}</code>
                      </p>
                    )}
                  </div>
                )}
                <Button onClick={handleSave} disabled={saving} className="w-full">
                  {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  <Save className="w-4 h-4 mr-2" /> Créer l'agent
                </Button>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="manual">
          <Card className="bg-card border-border">
            <CardContent className="p-5 space-y-4">
              <DraftEditor draft={draft} setDraft={setDraft} showAll />
              <Button onClick={handleSave} disabled={saving || !draft.name.trim() || !draft.system_prompt.trim()} className="w-full">
                {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                <Save className="w-4 h-4 mr-2" /> Créer l'agent
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function DraftEditor({
  draft, setDraft, showAll,
}: {
  draft: DraftAgent;
  setDraft: (d: DraftAgent) => void;
  showAll?: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <Label className="text-xs">Nom</Label>
          <Input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} className="mt-1.5" />
        </div>
        <div>
          <Label className="text-xs">Emoji</Label>
          <Input value={draft.emoji} onChange={e => setDraft({ ...draft, emoji: e.target.value })} className="mt-1.5 text-center text-2xl" maxLength={4} />
        </div>
      </div>
      <div>
        <Label className="text-xs">Description courte</Label>
        <Input value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} className="mt-1.5" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">Catégorie</Label>
          <Select value={draft.category} onValueChange={(v: AgentCategory) => setDraft({ ...draft, category: v })}>
            <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
            <SelectContent>
              {CATEGORIES.map(c => <SelectItem key={c.value} value={c.value}>{c.emoji} {c.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">Modèle</Label>
          <Select value={draft.model} onValueChange={(v: AgentModel) => setDraft({ ...draft, model: v })}>
            <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
            <SelectContent>
              {MODELS.map(m => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div>
        <Label className="text-xs">Prompt système</Label>
        <Textarea
          rows={showAll ? 10 : 6}
          value={draft.system_prompt}
          onChange={e => setDraft({ ...draft, system_prompt: e.target.value })}
          className="mt-1.5 font-mono text-xs"
          placeholder="Tu es un expert ... Tu réponds en ... Tu structures ..."
        />
      </div>
      <div>
        <Label className="text-xs">Température : {draft.temperature.toFixed(2)}</Label>
        <input
          type="range" min={0} max={1} step={0.1}
          value={draft.temperature}
          onChange={e => setDraft({ ...draft, temperature: parseFloat(e.target.value) })}
          className="w-full mt-2"
        />
        <p className="text-[10px] text-muted-foreground mt-1">
          0 = factuel, déterministe · 1 = créatif, varié
        </p>
      </div>
    </div>
  );
}
