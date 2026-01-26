import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useLocation } from 'react-router-dom';
import { 
  MessageCircle, 
  X, 
  Send, 
  Bot, 
  User, 
  Loader2, 
  Sparkles,
  ChevronDown,
  Phone,
  History,
  Trash2,
  AlertCircle
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
}

interface Conversation {
  id: string;
  createdAt: Date;
  preview: string;
}

const WELCOME_MESSAGES: Record<string, string> = {
  '/': "Bienvenue ! 👋 Je suis Purama AI, votre assistant. Besoin d'aide pour choisir votre agent IA ?",
  '/pricing': "Des questions sur nos tarifs ? 💰 Starter à 33€/mois ou Premium à 99€/mois - je peux tout vous expliquer !",
  '/agent': "Besoin d'aide avec cet agent ? 🤖 Je peux vous expliquer son fonctionnement en détail !",
  '/dashboard': "Besoin d'assistance avec votre tableau de bord ? 📊 Je suis là pour vous aider !",
  '/influenceur': "Questions sur notre programme d'affiliation ? 🌟 Gagnez jusqu'à 33% de commission !",
};

const SUGGESTION_CHIPS = [
  "Quels sont vos tarifs ?",
  "Comment fonctionnent les agents ?",
  "Programme d'affiliation",
  "Comment connecter Gmail ?",
];

const N8N_WEBHOOK_URL = 'https://n8n.srv1286148.hstgr.cloud/webhook/agent-chatbot-support';

export function ChatbotWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [sessionId] = useState(() => crypto.randomUUID());
  const [showHistory, setShowHistory] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [hasNewMessage, setHasNewMessage] = useState(false);
  
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const location = useLocation();
  const { user } = useAuth();

  // Get contextual welcome message
  const getWelcomeMessage = useCallback(() => {
    const path = location.pathname;
    if (path.startsWith('/agent/')) return WELCOME_MESSAGES['/agent'];
    if (path.startsWith('/influenceur')) return WELCOME_MESSAGES['/influenceur'];
    return WELCOME_MESSAGES[path] || WELCOME_MESSAGES['/'];
  }, [location.pathname]);

  // Initialize with welcome message
  useEffect(() => {
    if (isOpen && messages.length === 0) {
      const welcomeMsg: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: getWelcomeMessage(),
        createdAt: new Date(),
      };
      setMessages([welcomeMsg]);
    }
  }, [isOpen, getWelcomeMessage, messages.length]);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [messages]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Load conversation history for logged-in users
  useEffect(() => {
    if (user && showHistory) {
      loadConversationHistory();
    }
  }, [user, showHistory]);

  const loadConversationHistory = async () => {
    const { data } = await supabase
      .from('chat_conversations')
      .select('id, created_at')
      .eq('user_id', user?.id)
      .order('created_at', { ascending: false })
      .limit(10);

    if (data) {
      const convs: Conversation[] = await Promise.all(
        data.map(async (conv) => {
          const { data: msgs } = await supabase
            .from('chat_messages')
            .select('content')
            .eq('conversation_id', conv.id)
            .eq('role', 'user')
            .order('created_at', { ascending: true })
            .limit(1);

          return {
            id: conv.id,
            createdAt: new Date(conv.created_at),
            preview: msgs?.[0]?.content?.slice(0, 50) || 'Nouvelle conversation...',
          };
        })
      );
      setConversations(convs);
    }
  };

  const createOrGetConversation = async (): Promise<string> => {
    if (conversationId) return conversationId;

    const { data, error } = await supabase
      .from('chat_conversations')
      .insert({
        user_id: user?.id || null,
        session_id: sessionId,
        status: 'active',
      })
      .select('id')
      .single();

    if (error) throw error;
    setConversationId(data.id);
    return data.id;
  };

  const saveMessage = async (convId: string, role: 'user' | 'assistant', content: string) => {
    await supabase.from('chat_messages').insert({
      conversation_id: convId,
      role,
      content,
    });
  };

  const sendToN8n = async (userMessage: string) => {
    setIsLoading(true);
    
    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: userMessage,
      createdAt: new Date(),
    };
    
    setMessages(prev => [...prev, userMsg]);

    try {
      const convId = await createOrGetConversation();
      await saveMessage(convId, 'user', userMessage);

      // Build conversation history for n8n
      const conversationHistory = messages
        .filter(m => m.role !== 'assistant' || !m.content.startsWith('Bienvenue'))
        .concat(userMsg)
        .map(m => ({ role: m.role, content: m.content }));

      // Send to n8n webhook
      const resp = await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: userMessage,
          user_id: user?.id || null,
          page_url: window.location.href,
          conversation_history: conversationHistory,
        }),
      });

      if (!resp.ok) {
        throw new Error(`n8n webhook error: ${resp.status}`);
      }

      const data = await resp.json();
      
      // Handle n8n response
      const assistantContent = data.response || "Je n'ai pas pu générer une réponse.";
      const suggestions = data.suggestions || [];

      const assistantMsg: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: assistantContent,
        createdAt: new Date(),
      };

      setMessages(prev => [...prev, assistantMsg]);

      // Save assistant message to database
      await saveMessage(convId, 'assistant', assistantContent);

      // Update suggestion chips if n8n provides custom suggestions
      if (suggestions.length > 0) {
        // Store suggestions for display (could be extended to show dynamically)
        console.log('n8n suggestions:', suggestions);
      }
    } catch (error) {
      console.error('n8n webhook error:', error);
      setMessages(prev => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: "Désolé, je rencontre un problème technique. 😔 Souhaitez-vous parler à un membre de notre équipe ?",
          createdAt: new Date(),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSend = () => {
    if (!inputValue.trim() || isLoading) return;
    const message = inputValue.trim();
    setInputValue('');
    sendToN8n(message);
  };

  const handleSuggestionClick = (suggestion: string) => {
    sendToN8n(suggestion);
  };

  const handleEscalate = async () => {
    if (!conversationId) {
      toast.error('Aucune conversation en cours');
      return;
    }

    try {
      const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/escalate-chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
        },
        body: JSON.stringify({
          conversationId,
          userEmail: user?.email,
          userMessage: messages.filter(m => m.role === 'user').pop()?.content,
          conversationHistory: messages.slice(-10),
        }),
      });

      if (resp.ok) {
        toast.success('Un membre de notre équipe va vous contacter rapidement !');
        setMessages(prev => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: "J'ai transmis votre demande à notre équipe support. 📞 Un conseiller vous contactera très bientôt par email !",
            createdAt: new Date(),
          },
        ]);
      }
    } catch (error) {
      toast.error('Erreur lors de la transmission de votre demande');
    }
  };

  const startNewConversation = () => {
    setConversationId(null);
    setMessages([]);
    setShowHistory(false);
  };

  const loadConversation = async (convId: string) => {
    const { data } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: true });

    if (data) {
      setMessages(data.map(m => ({
        id: m.id,
        role: m.role as 'user' | 'assistant',
        content: m.content,
        createdAt: new Date(m.created_at),
      })));
      setConversationId(convId);
      setShowHistory(false);
    }
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
            className="fixed bottom-6 right-6 z-50 w-[380px] max-w-[calc(100vw-3rem)] h-[600px] max-h-[calc(100vh-6rem)] bg-background border border-border rounded-2xl shadow-2xl flex flex-col overflow-hidden"
          >
            {/* Header */}
            <div className="bg-gradient-to-r from-primary to-accent p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
                  <Sparkles className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h3 className="font-semibold text-white">Purama AI</h3>
                  <p className="text-xs text-white/80">Assistant en ligne 24/7</p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                {user && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setShowHistory(!showHistory)}
                    className="text-white/80 hover:text-white hover:bg-white/20"
                  >
                    <History className="w-4 h-4" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={startNewConversation}
                  className="text-white/80 hover:text-white hover:bg-white/20"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setIsOpen(false)}
                  className="text-white/80 hover:text-white hover:bg-white/20"
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </div>

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
                    {conversations.length === 0 ? (
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
              <div className="space-y-4">
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
            {messages.length <= 2 && !isLoading && (
              <div className="px-4 pb-2">
                <div className="flex flex-wrap gap-2">
                  {SUGGESTION_CHIPS.map((suggestion) => (
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
            {messages.length > 4 && (
              <div className="px-4 pb-2">
                <button
                  onClick={handleEscalate}
                  className="flex items-center gap-2 text-xs text-muted-foreground hover:text-primary transition-colors"
                >
                  <Phone className="w-3 h-3" />
                  Parler à un humain
                </button>
              </div>
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
                  disabled={isLoading}
                  className="flex-1"
                />
                <Button
                  type="submit"
                  size="icon"
                  disabled={!inputValue.trim() || isLoading}
                  className="bg-gradient-to-br from-primary to-accent"
                >
                  <Send className="w-4 h-4" />
                </Button>
              </form>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
