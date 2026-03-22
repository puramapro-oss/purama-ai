import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Send, Bot, User, Loader2, Menu, X, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AGENT_MODES, type AgentMode } from '@/lib/modes';
import { supabase } from '@/integrations/supabase/client';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export function PuramaSocialAgent() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [activeMode, setActiveMode] = useState<AgentMode>(AGENT_MODES[0]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 160) + 'px';
    }
  }, [input]);

  const handleModeChange = (mode: AgentMode) => {
    setActiveMode(mode);
    setSidebarOpen(false);
    setMessages([]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    const assistantId = crypto.randomUUID();
    setMessages(prev => [...prev, { id: assistantId, role: 'assistant', content: '', timestamp: new Date() }]);

    try {
      const { data, error } = await supabase.functions.invoke('social-agent', {
        body: {
          message: trimmed,
          mode: activeMode.id,
          systemPrompt: activeMode.systemPrompt,
          history: messages.slice(-10).map(m => ({ role: m.role, content: m.content })),
        },
      });

      if (error) throw error;

      const responseText = typeof data === 'string' ? data : data?.response || data?.content || data?.message || JSON.stringify(data);

      setMessages(prev =>
        prev.map(m => m.id === assistantId ? { ...m, content: responseText } : m)
      );
    } catch (err) {
      console.error('Social agent error:', err);
      setMessages(prev =>
        prev.map(m =>
          m.id === assistantId
            ? { ...m, content: 'Désolé, une erreur est survenue. Veuillez réessayer.' }
            : m
        )
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="flex h-[calc(100vh-80px)] max-h-[900px] w-full overflow-hidden rounded-2xl border border-accent-cyan/20 bg-[#030014]/95 backdrop-blur-xl">
      {/* Sidebar - Desktop */}
      <aside className="hidden lg:flex flex-col w-72 border-r border-accent-cyan/10 bg-[#0a0a1f]/80">
        <div className="p-6 border-b border-accent-cyan/10">
          <div className="flex items-center gap-2 mb-1">
            <Sparkles className="w-5 h-5 text-accent-cyan" />
            <h2 className="font-orbitron font-bold text-foreground">Modes</h2>
          </div>
          <p className="text-xs text-muted-foreground font-space">Sélectionnez un mode IA</p>
        </div>
        <nav className="flex-1 overflow-y-auto p-3 space-y-1">
          {AGENT_MODES.map(mode => (
            <button
              key={mode.id}
              onClick={() => handleModeChange(mode)}
              className={`w-full text-left p-3 rounded-xl transition-all font-space text-sm group ${
                activeMode.id === mode.id
                  ? 'bg-accent-cyan/10 border border-accent-cyan/30'
                  : 'hover:bg-white/5 border border-transparent'
              }`}
            >
              <div className="flex items-center gap-3">
                <span className="text-xl">{mode.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className={`font-semibold ${activeMode.id === mode.id ? 'text-accent-cyan' : 'text-foreground'}`}>
                    {mode.name}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">{mode.description}</div>
                </div>
              </div>
            </button>
          ))}
        </nav>
      </aside>

      {/* Sidebar - Mobile overlay */}
      <AnimatePresence>
        {sidebarOpen && (
          <>
            <motion.div
              className="fixed inset-0 bg-black/60 z-40 lg:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSidebarOpen(false)}
            />
            <motion.aside
              className="fixed left-0 top-0 bottom-0 w-72 z-50 bg-[#0a0a1f] border-r border-accent-cyan/10 lg:hidden flex flex-col"
              initial={{ x: -288 }}
              animate={{ x: 0 }}
              exit={{ x: -288 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            >
              <div className="p-6 border-b border-accent-cyan/10 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-accent-cyan" />
                  <h2 className="font-orbitron font-bold text-foreground">Modes</h2>
                </div>
                <button onClick={() => setSidebarOpen(false)} className="text-muted-foreground hover:text-foreground">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <nav className="flex-1 overflow-y-auto p-3 space-y-1">
                {AGENT_MODES.map(mode => (
                  <button
                    key={mode.id}
                    onClick={() => handleModeChange(mode)}
                    className={`w-full text-left p-3 rounded-xl transition-all font-space text-sm ${
                      activeMode.id === mode.id
                        ? 'bg-accent-cyan/10 border border-accent-cyan/30'
                        : 'hover:bg-white/5 border border-transparent'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-xl">{mode.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className={`font-semibold ${activeMode.id === mode.id ? 'text-accent-cyan' : 'text-foreground'}`}>
                          {mode.name}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">{mode.description}</div>
                      </div>
                    </div>
                  </button>
                ))}
              </nav>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Chat header */}
        <div className="flex items-center gap-3 p-4 border-b border-accent-cyan/10">
          <button
            className="lg:hidden text-muted-foreground hover:text-foreground"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="w-6 h-6" />
          </button>
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center text-xl"
            style={{ backgroundColor: activeMode.color + '15', border: `1px solid ${activeMode.color}40` }}
          >
            {activeMode.icon}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-orbitron font-bold text-foreground">{activeMode.name}</h3>
            <p className="text-xs text-muted-foreground font-space truncate">{activeMode.description}</p>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-xs text-emerald-400 font-space">En ligne</span>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center px-4">
              <div
                className="w-16 h-16 rounded-2xl flex items-center justify-center text-3xl mb-4"
                style={{ backgroundColor: activeMode.color + '15', border: `1px solid ${activeMode.color}30` }}
              >
                {activeMode.icon}
              </div>
              <h3 className="font-orbitron font-bold text-xl text-foreground mb-2">{activeMode.name}</h3>
              <p className="text-muted-foreground font-space text-sm max-w-md">{activeMode.description}</p>
              <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-lg w-full">
                {[
                  activeMode.id === 'social-media' ? 'Crée un post LinkedIn viral sur l\'IA' : undefined,
                  activeMode.id === 'social-media' ? 'Calendrier éditorial Instagram' : undefined,
                  activeMode.id === 'youtube' ? 'Script YouTube 10 minutes sur le marketing' : undefined,
                  activeMode.id === 'youtube' ? 'Idées de titres SEO pour ma chaîne' : undefined,
                  activeMode.id === 'video' ? 'Scénario Reel Instagram 30 secondes' : undefined,
                  activeMode.id === 'video' ? 'Prompt Runway Gen-3 pour une pub' : undefined,
                  activeMode.id === 'origin' ? 'Crée un agent support client' : undefined,
                  activeMode.id === 'origin' ? 'Configure un chatbot e-commerce' : undefined,
                  activeMode.id === 'vibe' ? 'Charte graphique pour une fintech' : undefined,
                  activeMode.id === 'vibe' ? 'Ton de voix pour marque premium' : undefined,
                  activeMode.id === 'libre' ? 'Analyse SWOT de mon business' : undefined,
                  activeMode.id === 'libre' ? 'Stratégie de lancement produit' : undefined,
                ].filter(Boolean).map((suggestion, i) => (
                  <button
                    key={i}
                    onClick={() => setInput(suggestion!)}
                    className="text-left p-3 rounded-xl border border-accent-cyan/10 hover:border-accent-cyan/30 hover:bg-accent-cyan/5 transition-all text-sm text-muted-foreground font-space"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map(msg => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {msg.role === 'assistant' && (
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-1"
                  style={{ backgroundColor: activeMode.color + '15', border: `1px solid ${activeMode.color}30` }}
                >
                  <Bot className="w-4 h-4" style={{ color: activeMode.color }} />
                </div>
              )}
              <div
                className={`max-w-[75%] rounded-2xl px-4 py-3 font-space text-sm leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-accent-cyan/10 border border-accent-cyan/20 text-foreground'
                    : 'bg-white/5 border border-white/10 text-foreground'
                }`}
              >
                {msg.content || (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span className="text-xs">Réflexion en cours...</span>
                  </div>
                )}
              </div>
              {msg.role === 'user' && (
                <div className="w-8 h-8 rounded-lg bg-accent-purple/10 border border-accent-purple/20 flex items-center justify-center flex-shrink-0 mt-1">
                  <User className="w-4 h-4 text-accent-purple" />
                </div>
              )}
            </motion.div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Input area */}
        <div className="p-4 border-t border-accent-cyan/10">
          <form onSubmit={handleSubmit} className="flex gap-3 items-end">
            <div className="flex-1 relative">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={`Message ${activeMode.name}...`}
                rows={1}
                className="w-full resize-none rounded-xl border border-accent-cyan/20 bg-white/5 px-4 py-3 pr-12 text-sm font-space text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-accent-cyan/50 focus:ring-1 focus:ring-accent-cyan/20 transition-all"
                disabled={isLoading}
              />
            </div>
            <Button
              type="submit"
              disabled={!input.trim() || isLoading}
              className="btn-primary h-11 w-11 p-0 rounded-xl flex-shrink-0"
            >
              {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
            </Button>
          </form>
          <p className="text-[10px] text-muted-foreground/60 text-center mt-2 font-space">
            PURAMA Social Agent peut faire des erreurs. Vérifiez les informations importantes.
          </p>
        </div>
      </div>
    </div>
  );
}
