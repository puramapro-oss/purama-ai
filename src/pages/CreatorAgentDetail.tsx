import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft, Loader2, Send, Settings, MessageSquare, Activity,
  Trash2, Save, Power, Bot, AlertCircle, Headphones, Zap, ShieldAlert, PlayCircle,
  FlaskConical, PauseCircle, Check, X,
} from 'lucide-react';
import { useVoice } from '@/hooks/useVoice';
import { MicButton } from '@/components/voice/MicButton';
import { SpeakButton } from '@/components/voice/SpeakButton';
import { VoiceMode } from '@/components/voice/VoiceMode';
import ReactMarkdown from 'react-markdown';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
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
  getAgent, updateAgent, deleteAgent,
  chatWithAgent, listChatMessages,
  listRuns, newSessionId,
  CATEGORIES, MODELS, TOOL_OPTIONS, SCHEDULE_PRESETS,
  type CreatorAgent, type CreatorAgentChatMessage, type CreatorAgentRun,
  type AgentModel, type AgentCategory,
} from '@/lib/creator-agent';
import {
  useCustomAgentKartaState, useUpdateCustomAgentKartaState,
  useCustomAgentKartaRuns, useTriggerCustomAgent, useCustomAgentPendingActions,
} from '@/hooks/useCreatorAgentKarta';
import { useResolvePendingAction } from '@/hooks/useKartaEmployees';

export default function CreatorAgentDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const nav = useNavigate();
  const [agent, setAgent] = useState<CreatorAgent | null>(null);
  const [loading, setLoading] = useState(true);
  const voice = useVoice();
  const [voiceModeOpen, setVoiceModeOpen] = useState(false);

  // Chat
  const [sessionId, setSessionId] = useState<string>('');
  const [messages, setMessages] = useState<CreatorAgentChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Runs
  const [runs, setRuns] = useState<CreatorAgentRun[]>([]);

  // Settings
  const [saving, setSaving] = useState(false);

  // Exécution réelle (KARTA)
  const { data: kartaState, isError: kartaStateError } = useCustomAgentKartaState(id);
  const updateKartaState = useUpdateCustomAgentKartaState(id);
  const { data: kartaRuns = [] } = useCustomAgentKartaRuns(id, 20);
  const triggerKarta = useTriggerCustomAgent();
  const { data: pendingActions = [] } = useCustomAgentPendingActions(id);
  const resolvePendingAction = useResolvePendingAction();

  const handleResolvePendingAction = (pendingActionId: string, decision: 'approve' | 'reject') => {
    resolvePendingAction.mutate(
      { pendingActionId, decision },
      {
        onSuccess: () => toast.success(decision === 'approve' ? 'Action exécutée' : 'Action rejetée'),
        onError: (e) => toast.error('Erreur', { description: e instanceof Error ? e.message : "Impossible de traiter cette action" }),
      },
    );
  };

  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        const a = await getAgent(id);
        setAgent(a);
        setSessionId(newSessionId());
      } catch (e) {
        toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  useEffect(() => {
    if (!id || !sessionId) return;
    listChatMessages(id, sessionId).then(setMessages).catch(() => {});
  }, [id, sessionId]);

  useEffect(() => {
    if (!user || !id) return;
    listRuns(user.id, { agent_id: id, limit: 50 }).then(setRuns).catch(() => {});
  }, [user?.id, id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const submitMessage = async (msg: string): Promise<string | null> => {
    if (!msg.trim() || !id || !user) return null;
    const tempUser: CreatorAgentChatMessage = {
      id: 'tmp-' + Date.now(),
      user_id: user.id,
      agent_id: id,
      session_id: sessionId,
      role: 'user',
      content: msg,
      tokens: null,
      created_at: new Date().toISOString(),
    };
    setMessages(prev => [...prev, tempUser]);
    try {
      const res = await chatWithAgent(id, sessionId, msg);
      setMessages(prev => [...prev, { ...tempUser, id: 'tmp-asst-' + Date.now(), role: 'assistant', content: res.reply, tokens: res.tokens }]);
      return res.reply;
    } catch (e) {
      toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
      setMessages(prev => prev.filter(m => m.id !== tempUser.id));
      return null;
    }
  };

  const handleSendChat = async () => {
    if (!chatInput.trim() || sending) return;
    const msg = chatInput.trim();
    setChatInput('');
    setSending(true);
    try { await submitMessage(msg); } finally { setSending(false); }
  };

  const handleSave = async () => {
    if (!agent) return;
    setSaving(true);
    try {
      const updated = await updateAgent(agent.id, agent);
      setAgent(updated);
      toast.success('✅ Enregistré');
    } catch (e) {
      toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
    } finally { setSaving(false); }
  };

  const handleTriggerNow = async () => {
    if (!id) return;
    try {
      await triggerKarta.mutateAsync(id);
      toast.success('Agent déclenché', { description: 'Regarde son activité ci-dessous dans quelques secondes.' });
    } catch (e) {
      toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const toggleTool = (toolValue: string) => {
    if (!agent) return;
    const has = agent.tools_enabled.includes(toolValue);
    setAgent({
      ...agent,
      tools_enabled: has ? agent.tools_enabled.filter((t) => t !== toolValue) : [...agent.tools_enabled, toolValue],
    });
  };

  const handleDelete = async () => {
    if (!agent) return;
    if (!confirm(`Supprimer "${agent.name}" et tout son historique ?`)) return;
    try {
      await deleteAgent(agent.id);
      toast.success('Supprimé');
      nav('/dashboard/creator-agent');
    } catch (e) {
      toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  if (loading || !agent) {
    return <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-accent-purple" /></div>;
  }

  // Templates aren't owned by the user → read-only mode
  const isReadOnly = agent.user_id !== user?.id;

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}>
        <Link to="/dashboard/creator-agent" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-1">
          <ArrowLeft className="w-3 h-3" /> Retour
        </Link>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="text-4xl">{agent.emoji}</div>
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-orbitron font-bold text-foreground">{agent.name}</h1>
            <p className="text-sm text-muted-foreground">{agent.description}</p>
          </div>
          <div className="flex gap-2">
            {agent.is_template && <Badge className="bg-yellow-500/15 text-yellow-400 border-yellow-500/30">Template</Badge>}
            {agent.is_active ? (
              <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30">Actif</Badge>
            ) : (
              <Badge variant="secondary">Désactivé</Badge>
            )}
          </div>
        </div>
      </motion.div>

      {isReadOnly && (
        <Card className="border-yellow-500/30 bg-yellow-500/5">
          <CardContent className="p-3 flex items-center gap-3 text-sm">
            <AlertCircle className="w-4 h-4 text-yellow-400 flex-shrink-0" />
            <p className="text-foreground/80">
              C'est un template. Pour l'utiliser et le personnaliser, va sur la page <Link to="/dashboard/creator-agent/templates" className="text-accent-cyan underline">Marketplace</Link> et clique « Cloner ».
            </p>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="chat">
        <TabsList>
          <TabsTrigger value="chat"><MessageSquare className="w-4 h-4 mr-2" /> Chat</TabsTrigger>
          <TabsTrigger value="runs"><Activity className="w-4 h-4 mr-2" /> Runs ({runs.length})</TabsTrigger>
          <TabsTrigger value="settings"><Settings className="w-4 h-4 mr-2" /> Paramètres</TabsTrigger>
        </TabsList>

        {/* CHAT */}
        <TabsContent value="chat">
          <Card className="bg-card border-border h-[60vh] flex flex-col">
            <div ref={scrollRef} className="flex-1 overflow-y-auto p-5 space-y-4">
              {messages.length === 0 ? (
                <div className="h-full flex items-center justify-center text-center">
                  <div>
                    <Bot className="w-12 h-12 text-accent-purple mx-auto mb-3" />
                    <p className="text-sm font-medium text-foreground">Démarre une conversation</p>
                    <p className="text-[11px] text-muted-foreground mt-1">L'agent va répondre selon son prompt système.</p>
                  </div>
                </div>
              ) : messages.map(m => (
                <div key={m.id} className={`flex gap-3 ${m.role === 'user' ? 'flex-row-reverse' : ''}`}>
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                    m.role === 'user' ? 'bg-accent-cyan/15' : 'bg-accent-purple/15'
                  }`}>
                    {m.role === 'user' ? '👤' : agent.emoji}
                  </div>
                  <div className={`flex-1 max-w-[80%] ${m.role === 'user' ? 'text-right' : ''}`}>
                    <div className={`inline-block text-left rounded-2xl p-3 ${
                      m.role === 'user'
                        ? 'bg-accent-cyan/10 border border-accent-cyan/20'
                        : 'bg-secondary/30 border border-border'
                    }`}>
                      <div className="text-sm text-foreground prose prose-sm prose-invert max-w-none prose-p:my-1">
                        <ReactMarkdown>{m.content}</ReactMarkdown>
                      </div>
                    </div>
                    {m.role === 'assistant' && (
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <SpeakButton voice={voice} text={m.content} />
                        <span className="text-[10px] text-muted-foreground">Écouter</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {sending && (
                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-accent-purple/15 flex items-center justify-center">{agent.emoji}</div>
                  <div className="inline-block rounded-2xl p-3 bg-secondary/30 border border-border">
                    <Loader2 className="w-4 h-4 animate-spin text-accent-purple" />
                  </div>
                </div>
              )}
            </div>
            <div className="border-t border-border p-3">
              <div className="mb-2 flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setVoiceModeOpen(true)}
                  disabled={isReadOnly}
                  className="border-accent-purple/40 text-accent-purple hover:bg-accent-purple/10"
                >
                  <Headphones className="w-4 h-4 mr-1.5" /> Mode vocal
                </Button>
              </div>
              <div className="flex gap-2 items-end">
                <MicButton
                  voice={voice}
                  onTranscript={(t) => setChatInput(prev => (prev ? prev + ' ' : '') + t)}
                  disabled={sending || isReadOnly}
                />
                <Textarea
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSendChat();
                    }
                  }}
                  placeholder={`Parle à ${agent.name}…`}
                  rows={2}
                  className="resize-none"
                  disabled={sending || isReadOnly}
                />
                <Button onClick={handleSendChat} disabled={sending || !chatInput.trim() || isReadOnly} className="self-end">
                  <Send className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </Card>
        </TabsContent>

        {/* RUNS */}
        <TabsContent value="runs">
          <Card className="bg-card border-border">
            <CardContent className="p-5">
              {runs.length === 0 ? (
                <p className="text-center py-10 text-sm text-muted-foreground">Aucune exécution.</p>
              ) : (
                <div className="space-y-2">
                  {runs.map(r => (
                    <div key={r.id} className="p-3 rounded-lg border border-border bg-secondary/20">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <Badge variant="outline" className="text-[10px]">{r.trigger}</Badge>
                        <Badge className={`text-[10px] ${r.status === 'success' ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : r.status === 'error' ? 'bg-red-500/15 text-red-400 border-red-500/30' : 'bg-secondary'}`}>
                          {r.status}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground">
                          {new Date(r.created_at).toLocaleString('fr-FR')}
                          {r.duration_ms && ` · ${r.duration_ms}ms`}
                          {r.tokens_output && ` · ${r.tokens_output} tokens`}
                        </span>
                      </div>
                      {r.input && <p className="text-[11px] text-muted-foreground line-clamp-2">→ {r.input}</p>}
                      {r.output && <p className="text-xs text-foreground/80 line-clamp-3 mt-1">{r.output}</p>}
                      {r.error_message && <p className="text-[11px] text-red-400 mt-1">{r.error_message}</p>}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* SETTINGS */}
        <TabsContent value="settings">
          <Card className="bg-card border-border">
            <CardContent className="p-5 space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <Label className="text-xs">Nom</Label>
                  <Input value={agent.name} onChange={e => setAgent({ ...agent, name: e.target.value })} className="mt-1.5" disabled={isReadOnly} />
                </div>
                <div>
                  <Label className="text-xs">Emoji</Label>
                  <Input value={agent.emoji} onChange={e => setAgent({ ...agent, emoji: e.target.value })} className="mt-1.5 text-center text-2xl" disabled={isReadOnly} />
                </div>
              </div>
              <div>
                <Label className="text-xs">Description</Label>
                <Input value={agent.description ?? ''} onChange={e => setAgent({ ...agent, description: e.target.value })} className="mt-1.5" disabled={isReadOnly} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Catégorie</Label>
                  <Select value={agent.category ?? 'productivity'} onValueChange={(v: AgentCategory) => setAgent({ ...agent, category: v })} disabled={isReadOnly}>
                    <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {CATEGORIES.map(c => <SelectItem key={c.value} value={c.value}>{c.emoji} {c.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Modèle</Label>
                  <Select value={agent.model} onValueChange={(v: AgentModel) => setAgent({ ...agent, model: v })} disabled={isReadOnly}>
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
                  rows={10}
                  value={agent.system_prompt}
                  onChange={e => setAgent({ ...agent, system_prompt: e.target.value })}
                  className="mt-1.5 font-mono text-xs"
                  disabled={isReadOnly}
                />
              </div>
              <div>
                <Label htmlFor="agent-temperature" className="text-xs">Température : {agent.temperature.toFixed(2)}</Label>
                <input
                  id="agent-temperature"
                  type="range" min={0} max={1} step={0.1}
                  value={agent.temperature}
                  onChange={e => setAgent({ ...agent, temperature: parseFloat(e.target.value) })}
                  className="w-full mt-2"
                  disabled={isReadOnly}
                />
              </div>

              <div className="pt-3 border-t border-border space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-foreground flex items-center gap-2">
                      <Zap className="w-4 h-4 text-accent-cyan" /> Exécution réelle (KARTA)
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      Cet agent fait vraiment les actions ci-dessous, au lieu de seulement en discuter dans le chat.
                    </p>
                    {kartaStateError && (
                      <p className="text-[11px] text-destructive mt-1">
                        Impossible de charger les réglages d'exécution réelle. Recharge la page.
                      </p>
                    )}
                  </div>
                  <Switch
                    checked={agent.karta_enabled}
                    onCheckedChange={v => setAgent({ ...agent, karta_enabled: v })}
                    disabled={isReadOnly}
                  />
                </div>

                <div>
                  <Label className="text-xs">Outils autorisés</Label>
                  <div className="mt-1.5 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {TOOL_OPTIONS.map((opt) => (
                      <label
                        key={opt.value}
                        className="flex items-start gap-2 p-2 rounded-lg bg-secondary/30 border border-border text-xs cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={agent.tools_enabled.includes(opt.value)}
                          onChange={() => toggleTool(opt.value)}
                          disabled={isReadOnly}
                          className="mt-0.5"
                        />
                        <span className="text-foreground/80">{opt.label}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {agent.karta_enabled && (
                  <>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <FlaskConical className="w-3.5 h-3.5 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">Mode simulation (dry-run)</span>
                      </div>
                      <Switch
                        checked={kartaState?.simulation_mode ?? true}
                        onCheckedChange={(v) => updateKartaState.mutate({ simulation_mode: v })}
                        disabled={isReadOnly || updateKartaState.isPending}
                      />
                    </div>
                    <p className="text-[10px] text-muted-foreground -mt-2">
                      {(kartaState?.simulation_mode ?? true)
                        ? "Actif : l'agent simule ses actions sans jamais rien exécuter réellement."
                        : 'Désactivé : selon le niveau d\'autonomie ci-dessous, cet agent peut réellement agir.'}
                    </p>

                    <div>
                      <Label className="text-xs">Niveau d'autonomie</Label>
                      <div className="flex gap-1.5 mt-1.5">
                        {[1, 2, 3].map((level) => (
                          <button
                            key={level}
                            type="button"
                            disabled={isReadOnly || updateKartaState.isPending}
                            onClick={() => updateKartaState.mutate({ autonomy_level: level })}
                            className={`flex-1 py-1.5 rounded-md text-xs font-semibold transition-all ${
                              (kartaState?.autonomy_level ?? 1) === level
                                ? 'bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30'
                                : 'bg-secondary/50 text-muted-foreground border border-transparent'
                            }`}
                          >
                            {level === 1 ? 'Propose' : level === 2 ? 'Semi-auto' : 'Autonome'}
                          </button>
                        ))}
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-1">
                        {(kartaState?.autonomy_level ?? 1) === 1
                          ? 'Il propose ses actions, tu valides toujours avant.'
                          : (kartaState?.autonomy_level ?? 1) === 2
                            ? 'Il agit seul, sauf pour les actions sensibles (envoi email...).'
                            : 'Il agit seul en totale autonomie — rapport après coup.'}
                      </p>
                    </div>

                    {pendingActions.length > 0 && (
                      <div className="space-y-1.5 p-3 rounded-lg bg-yellow-500/5 border border-yellow-500/30">
                        <Label className="text-xs flex items-center gap-1.5">
                          <PauseCircle className="w-3.5 h-3.5 text-yellow-500" /> En attente de ta validation
                        </Label>
                        {pendingActions.map((action) => (
                          <div key={action.id} className="flex items-center justify-between gap-2 py-1.5">
                            <p className="text-xs text-foreground/80 truncate">
                              Exécuter <span className="font-mono text-[11px] bg-secondary/60 px-1 rounded">{action.tool_name}</span>
                            </p>
                            <div className="flex gap-1.5 flex-shrink-0">
                              <Button
                                size="sm" variant="outline"
                                disabled={resolvePendingAction.isPending}
                                onClick={() => handleResolvePendingAction(action.id, 'reject')}
                                className="h-7 px-2 border-destructive/30 text-destructive hover:bg-destructive/10"
                              >
                                <X className="w-3.5 h-3.5" />
                              </Button>
                              <Button
                                size="sm"
                                disabled={resolvePendingAction.isPending}
                                onClick={() => handleResolvePendingAction(action.id, 'approve')}
                                className="h-7 px-2"
                              >
                                <Check className="w-3.5 h-3.5" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <ShieldAlert className="w-3.5 h-3.5 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">Arrêt d'urgence</span>
                      </div>
                      <Switch
                        checked={kartaState?.kill_switch ?? false}
                        onCheckedChange={(v) => updateKartaState.mutate({ kill_switch: v })}
                        disabled={isReadOnly || updateKartaState.isPending}
                      />
                    </div>

                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleTriggerNow}
                      disabled={isReadOnly || triggerKarta.isPending}
                      className="w-full"
                    >
                      {triggerKarta.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <PlayCircle className="w-4 h-4 mr-2" />}
                      Tester maintenant
                    </Button>

                    {kartaRuns.length > 0 && (
                      <div className="space-y-1.5">
                        <Label className="text-xs">Activité réelle récente</Label>
                        {kartaRuns.slice(0, 5).map((r) => (
                          <div key={r.id} className="p-2 rounded-lg bg-secondary/30 border border-border text-xs">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <Badge variant="outline" className="text-[10px]">{r.status}</Badge>
                              {r.claude_mock && (
                                <Badge variant="outline" className="text-[10px] border-yellow-500/40 text-yellow-500">
                                  [MOCK] TODO_LIVE_TEST
                                </Badge>
                              )}
                              <span className="text-[10px] text-muted-foreground">
                                {new Date(r.started_at).toLocaleString('fr-FR')}
                              </span>
                            </div>
                            {(r.decision || r.result_summary) && (
                              <p className="text-[11px] text-foreground/80 mt-1 line-clamp-2">{r.decision || r.result_summary}</p>
                            )}
                            {r.error_message && <p className="text-[11px] text-red-400 mt-1">{r.error_message}</p>}
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className="pt-3 border-t border-border space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-foreground">Planification</p>
                    <p className="text-[11px] text-muted-foreground">Quand l'agent se déclenche automatiquement (nécessite « Exécution réelle » ci-dessus).</p>
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Fréquence</Label>
                  <Select
                    value={agent.schedule_cron ?? '__none__'}
                    onValueChange={(v) => {
                      const cron = v === '__none__' ? null : v;
                      setAgent({ ...agent, schedule_cron: cron, schedule_enabled: cron !== null });
                    }}
                    disabled={isReadOnly}
                  >
                    <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {SCHEDULE_PRESETS.map((p) => (
                        <SelectItem key={p.label} value={p.cron ?? '__none__'}>{p.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {agent.schedule_cron && !SCHEDULE_PRESETS.some((p) => p.cron === agent.schedule_cron) && (
                  <div>
                    <Label className="text-xs">Planification personnalisée (avancé)</Label>
                    <Input
                      value={agent.schedule_cron ?? ''}
                      onChange={e => setAgent({ ...agent, schedule_cron: e.target.value, schedule_enabled: true })}
                      placeholder="0 9 * * *"
                      className="mt-1.5 font-mono text-xs"
                      disabled={isReadOnly}
                    />
                    <p className="text-[10px] text-muted-foreground mt-1">Générée par l'IA ou éditée manuellement — format cron 5 champs.</p>
                  </div>
                )}
                {agent.schedule_cron && (
                  <div>
                    <Label className="text-xs">Input par défaut (mode chat/legacy)</Label>
                    <Input
                      value={JSON.stringify(agent.schedule_input ?? {})}
                      onChange={e => {
                        try { setAgent({ ...agent, schedule_input: JSON.parse(e.target.value) }); } catch { /* JSON invalide en cours de frappe, ignoré */ }
                      }}
                      className="mt-1.5 font-mono text-xs"
                      disabled={isReadOnly}
                    />
                    <p className="text-[10px] text-muted-foreground mt-1">Utilisé uniquement si « Exécution réelle » est désactivée (l'agent répond alors en chat via le déclencheur planifié historique).</p>
                  </div>
                )}
              </div>

              <div className="pt-3 border-t border-border flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-foreground">Partager publiquement</p>
                  <p className="text-[11px] text-muted-foreground">L'agent apparaît dans la marketplace.</p>
                </div>
                <Switch checked={agent.is_public} onCheckedChange={v => setAgent({ ...agent, is_public: v })} disabled={isReadOnly} />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-foreground flex items-center gap-2">
                    <Power className="w-4 h-4" /> Actif
                  </p>
                </div>
                <Switch checked={agent.is_active} onCheckedChange={v => setAgent({ ...agent, is_active: v })} disabled={isReadOnly} />
              </div>

              {!isReadOnly && (
                <div className="pt-3 border-t border-border flex gap-2">
                  <Button onClick={handleSave} disabled={saving} className="flex-1">
                    {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                    <Save className="w-4 h-4 mr-2" /> Enregistrer
                  </Button>
                  <Button onClick={handleDelete} variant="outline" className="text-red-400 hover:text-red-300">
                    <Trash2 className="w-4 h-4 mr-2" /> Supprimer
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <VoiceMode
        open={voiceModeOpen}
        onClose={() => setVoiceModeOpen(false)}
        voice={voice}
        agentName={agent.name}
        agentEmoji={agent.emoji}
        agentColor="#8B5CF6"
        onSend={async (text) => submitMessage(text)}
      />
    </div>
  );
}
