import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Send, Loader2, Plus, MessageSquare, Scale, BookOpen } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import {
  sendChatMessage, listChatSessions, listChatMessages, newSessionId,
  type LegalChatMessage,
} from '@/lib/legal';

export default function LegalAgentChat() {
  const { user } = useAuth();
  const [sessionId, setSessionId] = useState<string>('');
  const [messages, setMessages] = useState<LegalChatMessage[]>([]);
  const [sessions, setSessions] = useState<Array<{ session_id: string; title: string; created_at: string }>>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!user) return;
    listChatSessions(user.id).then(setSessions).catch(() => {});
    setSessionId(newSessionId());
  }, [user?.id]);

  useEffect(() => {
    if (!user || !sessionId) return;
    listChatMessages(user.id, sessionId).then(setMessages).catch(() => {});
  }, [user?.id, sessionId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || sending || !user) return;
    const userMsg = input.trim();
    setInput('');
    setSending(true);
    // Optimistic UI
    const tempUser: LegalChatMessage = {
      id: 'tmp-' + Date.now(),
      user_id: user.id,
      session_id: sessionId,
      role: 'user',
      content: userMsg,
      category: null,
      documents_referenced: [],
      cases_referenced: [],
      sources_cited: [],
      confidence: null,
      disclaimer_shown: false,
      created_at: new Date().toISOString(),
    };
    setMessages(prev => [...prev, tempUser]);
    try {
      const result = await sendChatMessage(sessionId, userMsg);
      const assistantMsg: LegalChatMessage = {
        ...tempUser,
        id: 'tmp-asst-' + Date.now(),
        role: 'assistant',
        content: result.reply,
        sources_cited: result.sources,
      };
      setMessages(prev => [...prev, assistantMsg]);
      // Refresh sessions list to surface a freshly-named one
      listChatSessions(user.id).then(setSessions).catch(() => {});
    } catch (e) {
      toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
      setMessages(prev => prev.filter(m => m.id !== tempUser.id));
      setInput(userMsg);
    } finally { setSending(false); }
  };

  const newSession = () => {
    setSessionId(newSessionId());
    setMessages([]);
  };

  return (
    <div className="max-w-6xl mx-auto pb-12">
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="mb-4">
        <Link to="/dashboard/legal-agent" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-1">
          <ArrowLeft className="w-3 h-3" /> Retour
        </Link>
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-orbitron font-bold text-foreground flex items-center gap-2">
            <Scale className="w-6 h-6 text-accent-purple" /> Chat juridique
          </h1>
          <Button variant="outline" size="sm" onClick={newSession}>
            <Plus className="w-4 h-4 mr-2" /> Nouvelle conversation
          </Button>
        </div>
      </motion.div>

      <div className="grid grid-cols-1 lg:grid-cols-[200px_1fr] gap-4">
        {/* Sessions sidebar */}
        <div className="hidden lg:block">
          <Card className="bg-card border-border h-[70vh] overflow-y-auto">
            <CardContent className="p-3 space-y-1">
              <p className="text-[10px] uppercase text-muted-foreground px-2 py-1">Conversations</p>
              {sessions.length === 0 ? (
                <p className="text-[11px] text-muted-foreground px-2">Aucune.</p>
              ) : sessions.map(s => (
                <button
                  key={s.session_id}
                  onClick={() => setSessionId(s.session_id)}
                  className={`w-full text-left p-2 rounded-lg text-xs truncate ${
                    s.session_id === sessionId
                      ? 'bg-accent-purple/15 text-foreground border border-accent-purple/30'
                      : 'text-muted-foreground hover:bg-secondary/50'
                  }`}
                >
                  <MessageSquare className="w-3 h-3 inline mr-1" />
                  {s.title}
                </button>
              ))}
            </CardContent>
          </Card>
        </div>

        {/* Chat */}
        <Card className="bg-card border-border h-[70vh] flex flex-col">
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-5 space-y-4">
            {messages.length === 0 ? (
              <div className="h-full flex items-center justify-center text-center">
                <div>
                  <Scale className="w-12 h-12 text-accent-purple mx-auto mb-3" />
                  <p className="text-sm font-medium text-foreground">Pose ta question juridique</p>
                  <p className="text-[11px] text-muted-foreground mt-1 max-w-xs">
                    Droit des sociétés, travail, fiscal, RGPD, immobilier, propriété intellectuelle…
                  </p>
                  <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-md mx-auto">
                    {[
                      'Quelles sont mes obligations RGPD ?',
                      'Comment licencier un salarié en CDI ?',
                      'Rédige-moi une clause de non-concurrence',
                      'Quel est le délai de prescription d\'une facture impayée ?',
                    ].map(q => (
                      <button
                        key={q}
                        onClick={() => setInput(q)}
                        className="text-[11px] text-left p-2 rounded-lg border border-border bg-secondary/20 hover:bg-secondary/50 text-foreground/80"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : messages.map(m => (
              <div key={m.id} className={`flex gap-3 ${m.role === 'user' ? 'flex-row-reverse' : ''}`}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                  m.role === 'user' ? 'bg-accent-cyan/15' : 'bg-accent-purple/15'
                }`}>
                  {m.role === 'user' ? '👤' : '⚖️'}
                </div>
                <div className={`flex-1 max-w-[80%] ${m.role === 'user' ? 'text-right' : ''}`}>
                  <div className={`inline-block text-left rounded-2xl p-3 ${
                    m.role === 'user'
                      ? 'bg-accent-cyan/10 border border-accent-cyan/20'
                      : 'bg-secondary/30 border border-border'
                  }`}>
                    <div className="text-sm text-foreground prose prose-sm prose-invert max-w-none prose-p:my-1 prose-headings:mt-3 prose-headings:mb-1">
                      <ReactMarkdown>{m.content}</ReactMarkdown>
                    </div>
                    {m.sources_cited && m.sources_cited.length > 0 && (
                      <div className="mt-2 pt-2 border-t border-border/50">
                        <p className="text-[10px] uppercase text-muted-foreground mb-1 flex items-center gap-1">
                          <BookOpen className="w-2.5 h-2.5" /> Sources
                        </p>
                        <div className="flex flex-wrap gap-1">
                          {m.sources_cited.map((s, i) => (
                            s.url ? (
                              <a key={i} href={s.url} target="_blank" rel="noreferrer">
                                <Badge variant="outline" className="text-[10px] hover:bg-accent-purple/10">{s.reference}</Badge>
                              </a>
                            ) : (
                              <Badge key={i} variant="outline" className="text-[10px]">{s.reference}</Badge>
                            )
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {sending && (
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-full bg-accent-purple/15 flex items-center justify-center">⚖️</div>
                <div className="flex-1">
                  <div className="inline-block rounded-2xl p-3 bg-secondary/30 border border-border">
                    <Loader2 className="w-4 h-4 animate-spin text-accent-purple" />
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="border-t border-border p-3">
            <div className="flex gap-2">
              <Textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder="Pose ta question juridique…"
                rows={2}
                className="resize-none"
                disabled={sending}
              />
              <Button onClick={handleSend} disabled={sending || !input.trim()} className="self-end">
                <Send className="w-4 h-4" />
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground mt-2 text-center">
              ⚖️ Cet avis ne remplace pas une consultation avec un avocat inscrit au barreau pour les procédures judiciaires.
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}
