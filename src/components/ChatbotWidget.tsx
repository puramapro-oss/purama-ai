import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Link, useLocation } from 'react-router-dom';
import { 
  MessageCircle, 
  X, 
  Send, 
  Bot, 
  User, 
  Sparkles,
  Square,
  Phone,
  History,
  Trash2
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { parseSSEStream } from '@/lib/sse';
import { createRequestScope, type RequestLease } from '@/lib/request-scope';
import { prepareChatMessages, CHAT_MAX_MESSAGE_LENGTH } from '../../supabase/functions/_shared/chat-input';
import { ConsultationPanel } from '@/components/ConsultationPanel';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
  kind?: 'notice';
}

interface Conversation {
  id: string;
  createdAt: Date;
  preview: string;
}

const WELCOME_MESSAGES: Record<string, string> = {
  '/': "Bonjour, je suis PURA. Décrivez ce que vous souhaitez faire.",
  '/pricing': "Je peux vous aider à comprendre les offres. Les montants et conditions à jour sont ceux de la page Tarifs.",
  '/agent': "Besoin d'aide avec cet agent ? 🤖 Je peux vous expliquer son fonctionnement en détail !",
  '/dashboard': "Besoin d'assistance avec votre tableau de bord ? 📊 Je suis là pour vous aider !",
  '/influenceur': "Je peux vous orienter vers les conditions de partenariat applicables à votre situation.",
};

const SUGGESTION_CHIPS = [
  "Quels sont vos tarifs ?",
  "Comment fonctionnent les agents ?",
  "Programme d'affiliation",
  "Comment connecter Gmail ?",
];

// Edge Function URL for chatbot
const CHATBOT_FUNCTION_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/chatbot`;

export function ChatbotWidget() {
  const { user, session, loading: authLoading } = useAuth();
  const [requests] = useState(createRequestScope);
  const [isOpen, setIsOpen] = useState(false);
  const [consultationOpen, setConsultationOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [busyKind, setBusyKind] = useState<'reply' | 'history' | null>(null);
  const isLoading = busyKind !== null;
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [isEscalating, setIsEscalating] = useState(false);
  const [hasNewMessage, setHasNewMessage] = useState(false);
  const [dynamicSuggestions, setDynamicSuggestions] = useState<string[]>([]);
  const activeReply = useRef<{ prompt: string; assistantId?: string; completed?: boolean } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const location = useLocation();

  // A change of account invalidates every pending operation before the next paint.
  useLayoutEffect(() => {
    requests.invalidate();
    activeReply.current = null;
    setMessages([]);
    setConversations([]);
    setConversationId(null);
    setInputValue('');
    setShowHistory(false);
    setHistoryError(null);
    setBusyKind(null);
    setIsEscalating(false);
    setConsultationOpen(false);
    setDynamicSuggestions([]);
    return () => requests.invalidate();
  }, [requests, user?.id]);

  const getWelcomeMessage = useCallback(() => {
    const path = location.pathname;
    if (path.startsWith('/agent/')) return WELCOME_MESSAGES['/agent'];
    if (path.startsWith('/influenceur')) return WELCOME_MESSAGES['/influenceur'];
    return WELCOME_MESSAGES[path] || WELCOME_MESSAGES['/'];
  }, [location.pathname]);

  useEffect(() => {
    if (isOpen && messages.length === 0 && busyKind !== 'history') {
      setMessages([{ id: crypto.randomUUID(), role: 'assistant', kind: 'notice',
        content: getWelcomeMessage(), createdAt: new Date() }]);
    }
  }, [isOpen, getWelcomeMessage, messages.length, busyKind]);

  useEffect(() => {
    const viewport = scrollRef.current?.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]');
    viewport?.scrollTo({ top: viewport.scrollHeight });
  }, [messages]);

  useEffect(() => {
    if (!isOpen) return;
    const timer = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, [isOpen]);

  const loadConversationHistory = useCallback(async () => {
    if (!user) return;
    requests.cancel('history');
    const lease = requests.begin('history');
    if (!lease) return;
    setHistoryError(null);
    try {
      // One bounded embedded query replaces one query per conversation.
      const { data, error } = await supabase.from('chat_conversations')
        .select('id, created_at, chat_messages(content, created_at)')
        .eq('user_id', user.id).eq('chat_messages.role', 'user')
        .order('created_at', { ascending: false }).limit(10)
        .order('created_at', { referencedTable: 'chat_messages', ascending: true })
        .limit(1, { referencedTable: 'chat_messages' }).abortSignal(lease.signal);
      if (!lease.current()) return;
      if (error) throw error;
      setConversations((data ?? []).map(conv => ({ id: conv.id,
        createdAt: new Date(conv.created_at),
        preview: conv.chat_messages?.[0]?.content?.slice(0, 50) || 'Nouvelle conversation',
      })));
    } catch {
      if (lease.current()) setHistoryError("L'historique n'a pas pu être chargé.");
    } finally { lease.finish(); }
  }, [requests, user]);

  useEffect(() => {
    if (!authLoading && user && showHistory) void loadConversationHistory();
    return () => requests.cancel('history');
  }, [authLoading, user, showHistory, loadConversationHistory, requests]);

  const createOrGetConversation = async (lease: RequestLease): Promise<string | null> => {
    // Guests keep their conversation in this page; no anonymous database row.
    if (!user) return null;
    if (conversationId) return conversationId;
    const { data, error } = await supabase.from('chat_conversations')
      .insert({ user_id: user.id, session_id: crypto.randomUUID(), status: 'active' })
      .select('id').abortSignal(lease.signal).single();
    if (error) throw error;
    lease.signal.throwIfAborted();
    return data.id;
  };

  const saveMessage = async (convId: string | null, role: 'user' | 'assistant', content: string,
    lease: RequestLease) => {
    if (!convId) return;
    const { error } = await supabase.from('chat_messages')
      .insert({ conversation_id: convId, role, content }).abortSignal(lease.signal);
    if (error) throw error;
    lease.signal.throwIfAborted();
  };

  const addNotice = (content: string) => setMessages(prev => [...prev, {
    id: crypto.randomUUID(), role: 'assistant', kind: 'notice', content, createdAt: new Date(),
  }]);

  const stopActiveRequest = () => {
    const pending = activeReply.current;
    requests.cancel('interaction');
    activeReply.current = null;
    setBusyKind(null);
    if (pending?.completed) {
      addNotice("L'enregistrement a été interrompu. La réponse reste disponible ici.");
    } else if (pending) {
      setMessages(prev => prev.filter(m => m.id !== pending.assistantId));
      setInputValue(current => current || pending.prompt);
      addNotice('Réponse arrêtée. Vous pouvez modifier votre demande.');
    }
  };

  const sendMessage = async (text: string) => {
    const userMessage = text.trim();
    if (!userMessage || authLoading || busyKind === 'history') return;
    // History loading and reply generation share the same synchronous slot.
    const lease = requests.begin('interaction');
    if (!lease) return;
    const prepared = prepareChatMessages([...messages.filter(m => m.kind !== 'notice')
      .map(m => ({ role: m.role, content: m.content })), { role: 'user', content: userMessage }]);
    if (prepared.ok === false) {
      lease.finish();
      addNotice(prepared.error);
      return;
    }
    setBusyKind('reply');
    setInputValue('');
    activeReply.current = { prompt: userMessage };
    setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'user', content: userMessage, createdAt: new Date() }]);
    let assistantId: string | undefined;
    let responseComplete = false;
    try {
      const convId = await createOrGetConversation(lease);
      if (!lease.current()) return;
      setConversationId(convId);
      await saveMessage(convId, 'user', userMessage, lease);
      if (!lease.current()) return;
      const response = await fetch(CHATBOT_FUNCTION_URL, {
        method: 'POST', signal: lease.signal,
        headers: { 'Content-Type': 'application/json', apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: JSON.stringify({ messages: prepared.messages, pageContext: location.pathname }),
      });
      if (!lease.current()) { await response.body?.cancel(); return; }
      if (!response.ok) throw new Error(String(response.status));
      assistantId = crypto.randomUUID();
      activeReply.current = { prompt: userMessage, assistantId };
      setMessages(prev => [...prev, { id: assistantId!, role: 'assistant', content: '', createdAt: new Date() }]);
      const content = await parseSSEStream(response, full => {
        if (lease.current()) setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: full } : m));
      });
      if (!lease.current()) return;
      if (!content.trim()) throw new Error('EMPTY_RESPONSE');
      responseComplete = true;
      activeReply.current = { prompt: userMessage, assistantId, completed: true };
      await saveMessage(convId, 'assistant', content, lease);
      if (lease.current()) setDynamicSuggestions([]);
    } catch (error) {
      if (!lease.current()) return;
      if (!responseComplete) {
        setMessages(prev => prev.filter(m => m.id !== assistantId));
        setInputValue(current => current || userMessage);
      }
      addNotice(responseComplete
        ? "La réponse est reçue, mais son enregistrement a échoué. Vous pouvez la copier ici."
        : error instanceof Error && error.message === '429'
          ? 'Limite temporaire atteinte. Votre demande est conservée ; réessayez plus tard.'
          : "La réponse n'a pas abouti. Votre demande est conservée et peut être modifiée.");
    } finally {
      if (lease.finish()) { activeReply.current = null; setBusyKind(null); }
    }
  };

  const handleSend = () => { void sendMessage(inputValue); };
  const handleSuggestionClick = (suggestion: string) => { void sendMessage(suggestion); };

  const handleEscalate = async () => {
    if (!conversationId || !user || !session?.access_token || isLoading) return;
    const lease = requests.begin('support');
    if (!lease) return;
    setIsEscalating(true);
    try {
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/escalate-chat`, {
        method: 'POST', signal: lease.signal,
        headers: { 'Content-Type': 'application/json', apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ conversationId }),
      });
      if (!lease.current()) return;
      if (!response.ok) throw new Error('SUPPORT_FAILED');
      toast.success('Votre demande a été transmise au support.');
      addNotice('Votre demande a été transmise au support.');
    } catch {
      if (lease.current()) toast.error("La transmission au support n'a pas pu être confirmée.");
    } finally { if (lease.finish()) setIsEscalating(false); }
  };

  const startNewConversation = () => {
    requests.invalidate();
    activeReply.current = null;
    setBusyKind(null);
    setIsEscalating(false);
    setConversationId(null);
    setMessages([]);
    setInputValue('');
    setShowHistory(false);
    setDynamicSuggestions([]);
  };

  const loadConversation = async (convId: string) => {
    if (!user || authLoading) return;
    requests.invalidate();
    activeReply.current = null;
    const lease = requests.begin('interaction');
    if (!lease) return;
    setBusyKind('history');
    setIsEscalating(false);
    setMessages([]);
    setInputValue('');
    setConversationId(null);
    setShowHistory(false);
    try {
      const { data, error } = await supabase.from('chat_messages')
        .select('id, role, content, created_at, chat_conversations!inner(user_id)')
        .eq('conversation_id', convId).eq('chat_conversations.user_id', user.id)
        .order('created_at', { ascending: true }).abortSignal(lease.signal);
      if (!lease.current()) return;
      if (error) throw error;
      setMessages((data ?? []).filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ id: m.id, role: m.role as 'user' | 'assistant', content: m.content, createdAt: new Date(m.created_at) })));
      setConversationId(convId);
    } catch {
      if (lease.current()) addNotice("Cette conversation n'a pas pu être chargée.");
    } finally { if (lease.finish()) setBusyKind(null); }
  };

  return (
    <>
      {/* Floating Button */}
      <AnimatePresence>
        {!isOpen && (
          <motion.div
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            className="fixed bottom-6 right-6 z-50"
          >
            <Button
              onClick={() => { setIsOpen(true); setHasNewMessage(false); }}
              aria-label="Ouvrir l'assistant PURA"
              className="w-14 h-14 rounded-full bg-gradient-to-br from-primary to-accent shadow-lg hover:shadow-xl transition-all relative"
            >
              <MessageCircle className="w-6 h-6 text-primary-foreground" />
              {hasNewMessage && (
                <span className="absolute -top-1 -right-1 w-4 h-4 bg-destructive rounded-full animate-pulse" />
              )}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Chat Window */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            role="dialog"
            aria-label="Conversation avec PURA"
            className="fixed bottom-6 right-6 z-50 w-[380px] max-w-[calc(100vw-3rem)] h-[600px] max-h-[calc(100dvh-6rem)] bg-background border border-border rounded-2xl shadow-2xl flex flex-col overflow-hidden"
          >
            {/* Header */}
            <div className="bg-gradient-to-r from-primary to-accent p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
                  <Sparkles className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h3 className="font-semibold text-white">PURA</h3>
                  <p className="text-xs text-white/80">Votre assistant</p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                {user && !consultationOpen && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setShowHistory(!showHistory)}
                    aria-label="Historique des conversations"
                    className="text-white/80 hover:text-white hover:bg-white/20"
                  >
                    <History className="w-4 h-4" />
                  </Button>
                )}
                {!consultationOpen && <Button
                  variant="ghost"
                  size="icon"
                  onClick={startNewConversation}
                  aria-label="Nouvelle conversation"
                  className="text-white/80 hover:text-white hover:bg-white/20"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => { stopActiveRequest(); setIsOpen(false); }}
                  aria-label="Fermer l'assistant"
                  className="text-white/80 hover:text-white hover:bg-white/20"
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </div>

            {user && !user.is_anonymous && session?.access_token && <div role="group" aria-label="Mode de conversation" className="flex border-b border-border shrink-0">
              <button type="button" aria-pressed={!consultationOpen} className="flex-1 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-primary"
                onClick={() => setConsultationOpen(false)}>Conversation</button>
              <button type="button" aria-pressed={consultationOpen} className="flex-1 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-primary"
                onClick={() => { stopActiveRequest(); setShowHistory(false); setConsultationOpen(true); }}>Consultation IA</button>
            </div>}

            {consultationOpen && user && !user.is_anonymous && session?.access_token
              ? <ConsultationPanel key={user.id} userId={user.id} accessToken={session.access_token} />
              : <>

            {/* History Panel */}
            <AnimatePresence>
              {showHistory && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="border-b border-border bg-muted/50 overflow-hidden"
                >
                  <div className="p-3 max-h-40 overflow-y-auto">
                    <p className="text-xs font-medium text-muted-foreground mb-2">Conversations récentes</p>
                    {historyError ? <p role="alert" className="text-xs text-destructive">{historyError}</p> : conversations.length === 0 ? (
                      <p className="text-xs text-muted-foreground">Aucune conversation</p>
                    ) : (
                      conversations.map(conv => (
                        <button
                          key={conv.id}
                          onClick={() => loadConversation(conv.id)}
                          className="w-full text-left p-2 rounded-lg hover:bg-muted transition-colors text-sm truncate"
                        >
                          {conv.preview}...
                        </button>
                      ))
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Messages */}
            <ScrollArea className="flex-1 p-4" ref={scrollRef}>
              <div className="space-y-4" role="log" aria-live="polite" aria-relevant="additions" aria-busy={isLoading}>
                {busyKind === 'history' && <p role="status" className="text-sm text-muted-foreground">Chargement de la conversation…</p>}
                {messages.map((message) => (
                  <motion.div
                    key={message.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`flex gap-3 ${message.role === 'user' ? 'flex-row-reverse' : ''}`}
                  >
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                        message.role === 'user'
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-gradient-to-br from-primary/20 to-accent/20'
                      }`}
                    >
                      {message.role === 'user' ? (
                        <User className="w-4 h-4" />
                      ) : (
                        <Bot className="w-4 h-4 text-primary" />
                      )}
                    </div>
                    <div
                      className={`max-w-[75%] p-3 rounded-2xl text-sm ${
                        message.role === 'user'
                          ? 'bg-primary text-primary-foreground rounded-tr-none'
                          : 'bg-muted rounded-tl-none'
                      }`}
                    >
                      <p className="whitespace-pre-wrap">{message.content}</p>
                    </div>
                  </motion.div>
                ))}

                {isLoading && messages[messages.length - 1]?.role === 'user' && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex gap-3"
                  >
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary/20 to-accent/20 flex items-center justify-center">
                      <Bot className="w-4 h-4 text-primary" />
                    </div>
                    <div className="bg-muted p-3 rounded-2xl rounded-tl-none">
                      <div className="flex items-center gap-2">
                        <div className="flex gap-1">
                          <motion.span 
                            className="w-2 h-2 bg-primary rounded-full"
                            animate={{ y: [0, -6, 0] }}
                            transition={{ duration: 0.6, repeat: Infinity, delay: 0 }}
                          />
                          <motion.span 
                            className="w-2 h-2 bg-primary rounded-full"
                            animate={{ y: [0, -6, 0] }}
                            transition={{ duration: 0.6, repeat: Infinity, delay: 0.15 }}
                          />
                          <motion.span 
                            className="w-2 h-2 bg-primary rounded-full"
                            animate={{ y: [0, -6, 0] }}
                            transition={{ duration: 0.6, repeat: Infinity, delay: 0.3 }}
                          />
                        </div>
                        <span className="text-xs text-muted-foreground ml-1">Purama réfléchit...</span>
                      </div>
                    </div>
                  </motion.div>
                )}
              </div>
            </ScrollArea>

            {/* Suggestions */}
            {!isLoading && !authLoading && (messages.length <= 2 || dynamicSuggestions.length > 0) && (
              <div className="px-4 pb-2">
                <div className="flex flex-wrap gap-2">
                  {(dynamicSuggestions.length > 0 ? dynamicSuggestions : SUGGESTION_CHIPS).map((suggestion) => (
                    <button
                      key={suggestion}
                      onClick={() => handleSuggestionClick(suggestion)}
                      className="text-xs px-3 py-1.5 rounded-full bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Escalate Button */}
            {user && conversationId && messages.length > 4 && (
              <div className="px-4 pb-2">
                <button
                  onClick={handleEscalate}
                  disabled={isEscalating || isLoading}
                  className="flex items-center gap-2 text-xs text-muted-foreground hover:text-primary transition-colors"
                >
                  <Phone className="w-3 h-3" />
                  {isEscalating ? 'Transmission…' : 'Parler à un humain'}
                </button>
              </div>
            )}
            {!user && !authLoading && messages.length > 4 && (
              <Link to="/login" className="px-4 pb-2 text-xs text-muted-foreground hover:text-primary">
                Se connecter pour contacter le support
              </Link>
            )}

            {/* Input */}
            <div className="p-4 border-t border-border">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSend();
                }}
                className="flex gap-2"
              >
                <Input
                  ref={inputRef}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  placeholder="Posez votre question..."
                  aria-label="Votre message"
                  maxLength={CHAT_MAX_MESSAGE_LENGTH}
                  disabled={isLoading || authLoading}
                  className="flex-1"
                />
                {isLoading ? <Button type="button" onClick={(event) => {
                  // React can reuse this node as the submit button before the click's default action.
                  event.preventDefault();
                  stopActiveRequest();
                }} aria-label="Arrêter la réponse" variant="outline">
                  <Square className="w-4 h-4 mr-2" />Arrêter
                </Button> : <Button
                  type="submit"
                  size="icon"
                  aria-label="Envoyer le message"
                  disabled={!inputValue.trim() || authLoading}
                  className="bg-gradient-to-br from-primary to-accent"
                >
                  <Send className="w-4 h-4" />
                </Button>}
              </form>
            </div>
            </>}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
