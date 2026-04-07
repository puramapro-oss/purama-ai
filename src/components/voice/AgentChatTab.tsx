import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Send, Loader2, Bot, Sparkles, Plus, Headphones } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { useVoice } from '@/hooks/useVoice';
import { MicButton } from './MicButton';
import { SpeakButton } from './SpeakButton';
import { VoiceMode } from './VoiceMode';
import {
  newAgentSessionId,
  listAgentChatMessages,
  sendAgentChatMessage,
  type AgentChatMessage,
  type AgentChatType,
} from '@/lib/agent-chat';

interface Props {
  agentType: AgentChatType;
  agentName: string;
  agentEmoji: string;
  agentColor: string;
  suggestions?: string[];
}

export function AgentChatTab({ agentType, agentName, agentEmoji, agentColor, suggestions = [] }: Props) {
  const { user } = useAuth();
  const voice = useVoice();
  const [sessionId, setSessionId] = useState<string>('');
  const [messages, setMessages] = useState<AgentChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [voiceModeOpen, setVoiceModeOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setSessionId(newAgentSessionId()); }, []);

  useEffect(() => {
    if (!user || !sessionId) return;
    listAgentChatMessages(user.id, agentType, sessionId).then(setMessages).catch(() => {});
  }, [user?.id, agentType, sessionId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // Auto-play last assistant message when voice settings.auto_play
  useEffect(() => {
    if (!voice.settings.auto_play || voiceModeOpen) return;
    const last = messages[messages.length - 1];
    if (last && last.role === 'assistant') {
      voice.speak(last.content);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  const submit = async (text: string): Promise<string | null> => {
    if (!text.trim() || !user) return null;
    const tempUser: AgentChatMessage = {
      id: 'tmp-' + Date.now(),
      user_id: user.id,
      agent_type: agentType,
      session_id: sessionId,
      role: 'user',
      content: text.trim(),
      tokens: null,
      created_at: new Date().toISOString(),
    };
    setMessages(prev => [...prev, tempUser]);
    try {
      const res = await sendAgentChatMessage(agentType, sessionId, text.trim());
      setMessages(prev => [...prev, {
        ...tempUser,
        id: 'tmp-asst-' + Date.now(),
        role: 'assistant',
        content: res.reply,
        tokens: res.tokens,
      }]);
      return res.reply;
    } catch (e) {
      toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
      setMessages(prev => prev.filter(m => m.id !== tempUser.id));
      return null;
    }
  };

  const handleSend = async () => {
    if (!input.trim() || sending) return;
    const text = input.trim();
    setInput('');
    setSending(true);
    try { await submit(text); } finally { setSending(false); }
  };

  const newSession = () => {
    setSessionId(newAgentSessionId());
    setMessages([]);
  };

  return (
    <>
      <Card className="bg-card border-border h-[65vh] flex flex-col">
        {/* Toolbar */}
        <div className="border-b border-border p-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-2xl">{agentEmoji}</span>
            <div>
              <p className="text-sm font-semibold text-foreground">Chat avec {agentName}</p>
              <p className="text-[10px] text-muted-foreground">Texte ou voix · contexte gardé</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setVoiceModeOpen(true)}
              className="border-accent-purple/40 text-accent-purple hover:bg-accent-purple/10"
            >
              <Headphones className="w-4 h-4 mr-1.5" /> Mode vocal
            </Button>
            <Button variant="outline" size="sm" onClick={newSession}>
              <Plus className="w-4 h-4 mr-1.5" /> Nouvelle
            </Button>
          </div>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-5 space-y-4">
          {messages.length === 0 ? (
            <div className="h-full flex items-center justify-center text-center">
              <div>
                <Bot className="w-12 h-12 mx-auto mb-3" style={{ color: agentColor }} />
                <p className="text-sm font-medium text-foreground">Démarre une conversation avec {agentName}</p>
                <p className="text-[11px] text-muted-foreground mt-1">Tape ou utilise le micro · {agentName} répond comme un expert.</p>
                {suggestions.length > 0 && (
                  <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-md mx-auto">
                    {suggestions.map(s => (
                      <button
                        key={s}
                        onClick={() => setInput(s)}
                        className="text-[11px] text-left p-2 rounded-lg border border-border bg-secondary/20 hover:bg-secondary/50 text-foreground/80"
                      >
                        <Sparkles className="w-3 h-3 inline mr-1" style={{ color: agentColor }} />
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : messages.map(m => (
            <motion.div
              key={m.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className={`flex gap-3 ${m.role === 'user' ? 'flex-row-reverse' : ''}`}
            >
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-base"
                style={m.role === 'user'
                  ? { background: 'rgba(6,182,212,0.15)' }
                  : { background: `${agentColor}25` }}
              >
                {m.role === 'user' ? '👤' : agentEmoji}
              </div>
              <div className={`flex-1 max-w-[80%] ${m.role === 'user' ? 'text-right' : ''}`}>
                <div
                  className={`inline-block text-left rounded-2xl p-3 ${
                    m.role === 'user'
                      ? 'bg-accent-cyan/10 border border-accent-cyan/20'
                      : 'bg-secondary/30 border border-border'
                  }`}
                >
                  <div className="text-sm text-foreground prose prose-sm prose-invert max-w-none prose-p:my-1 prose-headings:mt-3 prose-headings:mb-1">
                    <ReactMarkdown>{m.content}</ReactMarkdown>
                  </div>
                </div>
                {m.role === 'assistant' && (
                  <div className="mt-1.5 flex items-center gap-1.5 justify-start">
                    <SpeakButton voice={voice} text={m.content} />
                    <span className="text-[10px] text-muted-foreground">Écouter</span>
                  </div>
                )}
              </div>
            </motion.div>
          ))}
          {sending && (
            <div className="flex gap-3">
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center"
                style={{ background: `${agentColor}25` }}
              >
                {agentEmoji}
              </div>
              <div className="inline-block rounded-2xl p-3 bg-secondary/30 border border-border">
                <Loader2 className="w-4 h-4 animate-spin" style={{ color: agentColor }} />
              </div>
            </div>
          )}
        </div>

        {/* Input */}
        <div className="border-t border-border p-3">
          <div className="flex gap-2 items-end">
            <MicButton
              voice={voice}
              onTranscript={(t) => setInput(prev => (prev ? prev + ' ' : '') + t)}
              disabled={sending}
            />
            <Textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder={`Parle à ${agentName}…`}
              rows={2}
              className="resize-none flex-1"
              disabled={sending}
            />
            <Button
              onClick={handleSend}
              disabled={sending || !input.trim()}
              className="self-end"
              style={{ background: agentColor }}
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </Card>

      <VoiceMode
        open={voiceModeOpen}
        onClose={() => setVoiceModeOpen(false)}
        voice={voice}
        agentName={agentName}
        agentEmoji={agentEmoji}
        agentColor={agentColor}
        onSend={async (text) => submit(text)}
      />
    </>
  );
}
