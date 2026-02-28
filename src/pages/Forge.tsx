import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence, useInView } from 'framer-motion';
import { Link } from 'react-router-dom';
import { 
  Sparkles, Zap, Brain, Palette, Rocket, Loader2, Star, Search,
  Check, ChevronDown, Copy, RotateCcw, Pencil, MessageSquare, 
  Send, X, Bot, Shield, Globe, Clock, Ban, Volume2, Eye, Users,
  ShoppingCart, Package, Gift, Calendar, Home, Scale, Dumbbell, 
  Heart, Apple, BookOpen, Laptop, Languages, Trophy, ArrowLeft
} from 'lucide-react';
import { AnimatedStarfield } from '@/components/AnimatedStarfield';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { toast } from 'sonner';

// ── TYPEWRITER PLACEHOLDERS ──
const placeholders = [
  "Crée un agent IA qui gère le support client d'une boutique de vêtements. Il doit être amical, connaître les tailles, gérer les retours, et proposer des looks personnalisés...",
  "Un assistant immobilier qui qualifie les prospects, planifie les visites et connaît tous les biens du catalogue...",
  "Un coach sportif IA qui crée des programmes personnalisés, motive les utilisateurs et suit leur progression...",
  "Un avocat virtuel spécialisé en droit du travail qui répond aux questions et génère des courriers types...",
  "Un serveur virtuel pour mon restaurant qui prend les commandes, recommande les plats et gère les réservations...",
];

const forgeSteps = [
  { icon: '🧬', label: 'Analyse du prompt...', pct: 20 },
  { icon: '🧠', label: 'Création de la personnalité...', pct: 40 },
  { icon: '💡', label: 'Configuration des compétences...', pct: 60 },
  { icon: '🎨', label: 'Design de l\'interface...', pct: 80 },
  { icon: '🚀', label: 'Déploiement en cours...', pct: 100 },
];

// ── AGENT RESULT GENERATOR ──
function generateAgent(prompt: string) {
  const lower = prompt.toLowerCase();
  if (lower.includes('restaurant') || lower.includes('plat') || lower.includes('commande')) {
    return { name: 'ChefBot', emoji: '🍕', domain: '🍽️ Restaurant', traits: ['Chaleureux', 'Gourmand', 'Efficace', 'Serviable'], skills: ['📋 Prises de commandes', '🍝 Recommandations plats', '📅 Réservations', '💬 Chat en direct', '📊 Rapports hebdo'], welcome: 'Buongiorno ! 🇮🇹 Qu\'est-ce qui vous ferait plaisir aujourd\'hui ?', color: '#f97316' };
  }
  if (lower.includes('immobil') || lower.includes('prospect') || lower.includes('visite')) {
    return { name: 'ImmoAssist', emoji: '🏠', domain: '🏠 Immobilier', traits: ['Expert', 'Patient', 'Proactif', 'Persuasif'], skills: ['🔍 Qualification prospects', '📅 Planification visites', '📋 Catalogue biens', '💬 Chat en direct', '📧 Emails automatiques', '📊 Rapports'], welcome: 'Bonjour ! Je suis votre assistant immobilier. Comment puis-je vous aider dans votre recherche ?', color: '#3b82f6' };
  }
  if (lower.includes('sport') || lower.includes('coach') || lower.includes('entraîn')) {
    return { name: 'CoachMax', emoji: '💪', domain: '💪 Sport & Fitness', traits: ['Dynamique', 'Motivant', 'Expert', 'Bienveillant'], skills: ['🏋️ Programmes personnalisés', '📈 Suivi progression', '🥗 Conseils nutrition', '💬 Motivation quotidienne', '📅 Planning entraînements'], welcome: 'Hey champion ! 💪 Prêt à dépasser tes limites aujourd\'hui ?', color: '#10b981' };
  }
  if (lower.includes('avocat') || lower.includes('juridique') || lower.includes('droit')) {
    return { name: 'JuriBot', emoji: '⚖️', domain: '⚖️ Juridique', traits: ['Précis', 'Fiable', 'Formel', 'Expert'], skills: ['📋 Questions courantes', '📄 Génération courriers', '📚 Base juridique', '💬 Consultation IA'], welcome: 'Bonjour. Je suis votre assistant juridique. Quelle est votre question ?', color: '#7c3aed' };
  }
  if (lower.includes('boutique') || lower.includes('e-commerce') || lower.includes('vêtement') || lower.includes('vente')) {
    return { name: 'StyleBot', emoji: '🛍️', domain: '🛍️ E-Commerce', traits: ['Amical', 'Expert', 'Patient', 'Proactif'], skills: ['📦 Gestion des retours', '👗 Conseils style', '📏 Guide des tailles', '💬 Chat en direct', '📧 Emails automatiques', '📊 Rapports hebdo'], welcome: 'Bienvenue ! ✨ Comment puis-je vous aider dans vos achats ?', color: '#f472b6' };
  }
  return { name: 'SmartAssist', emoji: '🤖', domain: '🤖 Assistant général', traits: ['Intelligent', 'Polyvalent', 'Amical', 'Efficace'], skills: ['💬 Chat en direct', '📧 Emails automatiques', '📋 Gestion des demandes', '📊 Rapports', '🔍 Recherche intelligente'], welcome: 'Bonjour ! Je suis votre assistant IA. Comment puis-je vous aider ?', color: '#00f0ff' };
}

// ── TEMPLATES ──
const templates = [
  { emoji: '🛍️', name: 'ShopAssist', desc: 'Agent de vente e-commerce', category: 'E-Commerce', tier: 'Gratuit', prompt: "Un agent IA pour ma boutique e-commerce qui aide les clients à trouver les bons produits, recommande des articles complémentaires, gère les questions sur la livraison et les tailles.", icon: ShoppingCart },
  { emoji: '📦', name: 'ReturnBot', desc: 'Gestion des retours et SAV', category: 'E-Commerce', tier: 'Gratuit', prompt: "Un agent SAV pour ma boutique en ligne qui gère les retours produits, vérifie les conditions de retour, génère les étiquettes et suit les remboursements.", icon: Package },
  { emoji: '🎁', name: 'PromoAgent', desc: 'Promotions et upsell', category: 'E-Commerce', tier: 'Pro', prompt: "Un agent de promotions qui propose des offres personnalisées, des ventes incitatives et des codes promo aux clients selon leur historique d'achat.", icon: Gift },
  { emoji: '📅', name: 'BookingBot', desc: 'Prise de rendez-vous automatique', category: 'Services', tier: 'Gratuit', prompt: "Un assistant de prise de rendez-vous pour mon salon qui gère le planning, confirme les réservations par email et envoie des rappels automatiques.", icon: Calendar },
  { emoji: '🏠', name: 'ImmoExpert', desc: 'Qualification prospects immobilier', category: 'Services', tier: 'Pro', prompt: "Un agent immobilier IA qui qualifie les prospects en posant les bonnes questions (budget, surface, localisation), présente les biens et planifie les visites.", icon: Home },
  { emoji: '⚖️', name: 'JuriBot', desc: 'Assistant juridique', category: 'Services', tier: 'Pro', prompt: "Un assistant juridique spécialisé en droit du travail qui répond aux questions courantes, explique les procédures et génère des courriers types.", icon: Scale },
  { emoji: '💪', name: 'CoachFit', desc: 'Coach sportif personnalisé', category: 'Santé', tier: 'Gratuit', prompt: "Un coach sportif IA qui crée des programmes d'entraînement personnalisés, suit la progression et motive les utilisateurs avec des objectifs quotidiens.", icon: Dumbbell },
  { emoji: '🧘', name: 'ZenGuide', desc: 'Bien-être et méditation', category: 'Santé', tier: 'Pro', prompt: "Un guide de méditation et bien-être qui propose des séances adaptées au niveau de stress, des exercices de respiration et des conseils pour mieux dormir.", icon: Heart },
  { emoji: '🥗', name: 'NutriBot', desc: 'Conseils nutrition personnalisés', category: 'Santé', tier: 'Pro', prompt: "Un nutritionniste IA qui crée des plans alimentaires personnalisés, calcule les macros et propose des recettes saines selon les préférences.", icon: Apple },
  { emoji: '📚', name: 'TutorIA', desc: 'Tuteur éducatif adaptatif', category: 'Tech', tier: 'Gratuit', prompt: "Un tuteur éducatif IA qui s'adapte au niveau de l'élève, explique les concepts avec des exemples simples et propose des exercices progressifs.", icon: BookOpen },
  { emoji: '💻', name: 'DevHelper', desc: 'Support technique IT', category: 'Tech', tier: 'Business', prompt: "Un agent de support technique qui diagnostique les problèmes informatiques, guide les utilisateurs pas à pas et escalade vers un humain si nécessaire.", icon: Laptop },
  { emoji: '🌍', name: 'LinguaBot', desc: 'Apprentissage de langues', category: 'Tech', tier: 'Pro', prompt: "Un assistant d'apprentissage des langues qui pratique la conversation, corrige la grammaire et adapte la difficulté au niveau de l'apprenant.", icon: Languages },
];

// ── COMMUNITY GALLERY ──
const communityAgents = [
  { name: 'FinanceBot', emoji: '💰', creator: 'Lucas M.', uses: '2.3k', rating: 4.9, domain: 'Finance', top: true },
  { name: 'TravelGuide', emoji: '✈️', creator: 'Emma B.', uses: '1.8k', rating: 4.8, domain: 'Voyage', top: true },
  { name: 'RecipeChef', emoji: '👨‍🍳', creator: 'Paul K.', uses: '1.5k', rating: 4.7, domain: 'Cuisine', top: false },
  { name: 'PetCare', emoji: '🐕', creator: 'Julie R.', uses: '1.2k', rating: 4.9, domain: 'Animaux', top: false },
  { name: 'StyleAdvisor', emoji: '👗', creator: 'Chloé D.', uses: '980', rating: 4.6, domain: 'Mode', top: false },
  { name: 'MusicMentor', emoji: '🎵', creator: 'Maxime L.', uses: '870', rating: 4.8, domain: 'Musique', top: true },
  { name: 'GardenHelper', emoji: '🌱', creator: 'Anne P.', uses: '750', rating: 4.5, domain: 'Jardinage', top: false },
  { name: 'StudyBuddy', emoji: '📖', creator: 'Théo S.', uses: '2.1k', rating: 4.9, domain: 'Études', top: true },
];

// ── CHAT SIMULATOR ──
const chatResponses: Record<string, string[]> = {
  default: [
    "Bien sûr, je peux vous aider avec ça ! Laissez-moi vérifier...",
    "Excellente question ! Voici ce que je recommande...",
    "Je comprends votre demande. Voici les options disponibles :",
    "Pas de problème ! Je m'en occupe tout de suite.",
  ],
};

export default function Forge() {
  // ── STATE ──
  const [prompt, setPrompt] = useState('');
  const [phase, setPhase] = useState<'input' | 'forging' | 'result'>('input');
  const [forgeStep, setForgeStep] = useState(0);
  const [agent, setAgent] = useState<ReturnType<typeof generateAgent> | null>(null);
  const [editName, setEditName] = useState(false);

  // Agent customization
  const [tonSlider, setTonSlider] = useState([50]);
  const [energySlider, setEnergySlider] = useState([60]);
  const [detailSlider, setDetailSlider] = useState([50]);
  const [widgetColor, setWidgetColor] = useState('#00f0ff');
  const [widgetPosition, setWidgetPosition] = useState('bottom-right');
  const [autoBubble, setAutoBubble] = useState(true);
  const [welcomeMsg, setWelcomeMsg] = useState('');
  const [mainLang, setMainLang] = useState('FR');
  const [responseDelay, setResponseDelay] = useState('natural');
  const [humanFallback, setHumanFallback] = useState(false);
  const [bannedTopics, setBannedTopics] = useState('');
  const [skillToggles, setSkillToggles] = useState<boolean[]>([]);

  // Chat simulator
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<{ role: 'agent' | 'user'; text: string }[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);

  // Typewriter placeholder
  const [placeholderIdx, setPlaceholderIdx] = useState(0);
  const [typedPlaceholder, setTypedPlaceholder] = useState('');
  const typewriterRef = useRef<NodeJS.Timeout | null>(null);

  // Scroll ref for hero stats
  const statsRef = useRef<HTMLDivElement>(null);
  const statsInView = useInView(statsRef, { once: true });

  // ── TYPEWRITER EFFECT ──
  useEffect(() => {
    if (prompt) return; // Don't animate if user is typing
    let charIdx = 0;
    const text = placeholders[placeholderIdx];
    setTypedPlaceholder('');
    typewriterRef.current = setInterval(() => {
      charIdx++;
      setTypedPlaceholder(text.slice(0, charIdx));
      if (charIdx >= text.length) {
        clearInterval(typewriterRef.current!);
        setTimeout(() => {
          setPlaceholderIdx(i => (i + 1) % placeholders.length);
        }, 2000);
      }
    }, 35);
    return () => { if (typewriterRef.current) clearInterval(typewriterRef.current); };
  }, [placeholderIdx, prompt]);

  // ── FORGE HANDLER ──
  const handleForge = useCallback(() => {
    if (!prompt.trim()) return;
    setPhase('forging');
    setForgeStep(0);
    let step = 0;
    const interval = setInterval(() => {
      step++;
      setForgeStep(step);
      if (step >= forgeSteps.length) {
        clearInterval(interval);
        const result = generateAgent(prompt);
        setAgent(result);
        setWelcomeMsg(result.welcome);
        setSkillToggles(result.skills.map(() => true));
        setPhase('result');
      }
    }, 900);
  }, [prompt]);

  // ── USE TEMPLATE ──
  const useTemplate = (templatePrompt: string) => {
    setPrompt(templatePrompt);
    setPhase('input');
    setAgent(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setTimeout(() => {
      setPhase('forging');
      setForgeStep(0);
      let step = 0;
      const interval = setInterval(() => {
        step++;
        setForgeStep(step);
        if (step >= forgeSteps.length) {
          clearInterval(interval);
          const result = generateAgent(templatePrompt);
          setAgent(result);
          setWelcomeMsg(result.welcome);
          setSkillToggles(result.skills.map(() => true));
          setPhase('result');
        }
      }, 900);
    }, 600);
  };

  // ── CHAT SIMULATOR ──
  const openChat = () => {
    if (!agent) return;
    setChatMessages([{ role: 'agent', text: agent.welcome }]);
    setChatOpen(true);
  };

  const sendChat = () => {
    if (!chatInput.trim()) return;
    setChatMessages(prev => [...prev, { role: 'user', text: chatInput }]);
    setChatInput('');
    setIsTyping(true);
    setTimeout(() => {
      const responses = chatResponses.default;
      setChatMessages(prev => [...prev, { role: 'agent', text: responses[Math.floor(Math.random() * responses.length)] }]);
      setIsTyping(false);
    }, 1500);
  };

  // ── TEMPLATE CATEGORIES ──
  const categories = ['Tous', ...Array.from(new Set(templates.map(t => t.category)))];
  const [selectedCategory, setSelectedCategory] = useState('Tous');
  const filteredTemplates = selectedCategory === 'Tous' ? templates : templates.filter(t => t.category === selectedCategory);

  // Gallery
  const [gallerySearch, setGallerySearch] = useState('');
  const [gallerySort, setGallerySort] = useState<'popular' | 'recent' | 'rated'>('popular');
  const filteredGallery = communityAgents.filter(a => a.name.toLowerCase().includes(gallerySearch.toLowerCase()) || a.domain.toLowerCase().includes(gallerySearch.toLowerCase()));

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AnimatedStarfield />

      {/* Back to home */}
      <div className="fixed top-4 left-4 z-50">
        <Link to="/" className="glass-effect px-4 py-2 rounded-full text-sm text-foreground/80 hover:text-accent-cyan transition-colors flex items-center gap-2">
          <ArrowLeft className="w-4 h-4" /> Retour
        </Link>
      </div>

      <main className="relative z-10">
        {/* ════════ HERO SECTION ════════ */}
        <section className="relative pt-28 pb-16 px-6 overflow-hidden">
          <div className="absolute inset-0">
            <div className="absolute top-1/4 left-1/3 w-[500px] h-[500px] bg-accent-purple/10 rounded-full blur-[150px]" />
            <div className="absolute bottom-1/4 right-1/4 w-[400px] h-[400px] bg-accent-cyan/10 rounded-full blur-[120px]" />
          </div>

          <div className="container mx-auto max-w-4xl relative z-10 text-center">
            {/* Badge */}
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="inline-flex items-center gap-2 mb-8">
              <span className="relative px-5 py-2 rounded-full text-sm font-semibold overflow-hidden">
                <span className="absolute inset-0 bg-gradient-to-r from-yellow-500/20 to-amber-500/20 border border-yellow-500/30 rounded-full" />
                <motion.span className="absolute inset-0 bg-gradient-to-r from-transparent via-yellow-400/30 to-transparent rounded-full" animate={{ x: ['-100%', '200%'] }} transition={{ duration: 2, repeat: Infinity }} />
                <span className="relative text-yellow-400">⚡ RÉVOLUTIONNAIRE</span>
              </span>
            </motion.div>

            <motion.h1 initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="text-4xl sm:text-5xl lg:text-6xl font-orbitron font-black leading-tight mb-6">
              <span className="gradient-text">Un prompt. Un agent IA.</span>{' '}
              <span className="text-foreground">Ton business transformé.</span>
            </motion.h1>

            <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }} className="text-muted-foreground text-lg max-w-2xl mx-auto mb-10">
              Décris ton agent idéal en quelques mots. Origin Forge le crée instantanément — personnalité, compétences, apparence, tout. Prêt à déployer sur ton site en 60 secondes.
            </motion.p>

            {/* Mini stats */}
            <motion.div ref={statsRef} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }} className="grid grid-cols-3 gap-6 max-w-lg mx-auto mb-12">
              {[
                { value: '∞', label: 'Possibilités infinies' },
                { value: '60s', label: 'Temps de création' },
                { value: '0', label: 'Ligne de code requise' },
              ].map((s, i) => (
                <div key={i} className="text-center">
                  <div className="text-2xl sm:text-3xl font-orbitron font-bold text-accent-cyan neon-text-cyan">{s.value}</div>
                  <div className="text-xs text-muted-foreground mt-1">{s.label}</div>
                </div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* ════════ THE FORGE ════════ */}
        <section className="relative px-6 pb-20">
          <div className="container mx-auto max-w-3xl relative z-10">
            <motion.div initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }} className="futuristic-card p-8 relative overflow-hidden" style={{ boxShadow: '0 0 60px rgba(0,240,255,0.1)' }}>
              {/* Animated border glow */}
              <div className="absolute inset-0 rounded-2xl overflow-hidden pointer-events-none">
                <motion.div className="absolute inset-[-2px] rounded-2xl" style={{ background: 'conic-gradient(from 0deg, #00f0ff, #7c3aed, #f472b6, #00f0ff)' , opacity: 0.15 }} animate={{ rotate: 360 }} transition={{ duration: 8, repeat: Infinity, ease: 'linear' }} />
              </div>

              <AnimatePresence mode="wait">
                {/* ── STEP 1: INPUT ── */}
                {phase === 'input' && (
                  <motion.div key="input" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                    <div className="flex items-center gap-2 mb-4">
                      <Sparkles className="w-5 h-5 text-accent-cyan" />
                      <h3 className="font-orbitron font-bold text-foreground text-lg">La Forge</h3>
                    </div>
                    <div className="relative">
                      <textarea
                        value={prompt}
                        onChange={e => setPrompt(e.target.value)}
                        placeholder={prompt ? undefined : typedPlaceholder}
                        className="w-full min-h-[200px] bg-secondary/40 border border-accent-cyan/20 rounded-xl px-5 py-4 text-foreground text-sm leading-relaxed placeholder:text-muted-foreground/50 resize-y focus:outline-none focus:border-accent-cyan/50 transition-colors"
                      />
                      <span className="absolute bottom-3 right-4 text-xs text-muted-foreground/50">{prompt.length} caractères</span>
                    </div>
                    <motion.button
                      onClick={handleForge}
                      disabled={!prompt.trim()}
                      whileHover={{ scale: 1.02, boxShadow: '0 0 50px rgba(0,240,255,0.4)' }}
                      whileTap={{ scale: 0.98 }}
                      className="w-full mt-5 btn-primary flex items-center justify-center gap-3 text-base py-4 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Zap className="w-5 h-5" />
                      Forger mon Agent IA
                    </motion.button>
                  </motion.div>
                )}

                {/* ── STEP: FORGING ── */}
                {phase === 'forging' && (
                  <motion.div key="forging" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="py-8">
                    <div className="space-y-4">
                      {forgeSteps.map((step, i) => (
                        <motion.div key={i} initial={{ opacity: 0, x: -20 }} animate={{ opacity: forgeStep > i ? 1 : forgeStep === i ? 0.8 : 0.3, x: 0 }} transition={{ delay: i * 0.1 }} className="flex items-center gap-3">
                          <span className="text-xl">{step.icon}</span>
                          <span className={`text-sm font-medium ${forgeStep > i ? 'text-accent-emerald' : forgeStep === i ? 'text-accent-cyan' : 'text-muted-foreground/50'}`}>
                            {step.label}
                          </span>
                          {forgeStep > i && <Check className="w-4 h-4 text-accent-emerald ml-auto" />}
                          {forgeStep === i && <Loader2 className="w-4 h-4 text-accent-cyan ml-auto animate-spin" />}
                        </motion.div>
                      ))}
                    </div>
                    <div className="mt-6 h-2 bg-secondary/50 rounded-full overflow-hidden">
                      <motion.div className="h-full bg-gradient-to-r from-accent-cyan to-accent-purple rounded-full" initial={{ width: '0%' }} animate={{ width: `${(forgeStep / forgeSteps.length) * 100}%` }} transition={{ duration: 0.5 }} />
                    </div>
                  </motion.div>
                )}

                {/* ── STEP: RESULT ── */}
                {phase === 'result' && agent && (
                  <motion.div key="result" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ type: 'spring', damping: 20 }}>
                    {/* Header */}
                    <div className="flex items-center gap-4 mb-6">
                      <div className="relative">
                        <div className="w-16 h-16 rounded-full flex items-center justify-center text-3xl" style={{ background: `linear-gradient(135deg, ${agent.color}40, ${agent.color}20)`, boxShadow: `0 0 25px ${agent.color}40` }}>
                          {agent.emoji}
                        </div>
                        <motion.div className="absolute inset-[-3px] rounded-full border-2 border-transparent" style={{ borderImage: `conic-gradient(from 0deg, ${agent.color}, #7c3aed, ${agent.color}) 1` }} animate={{ rotate: 360 }} transition={{ duration: 4, repeat: Infinity, ease: 'linear' }} />
                      </div>
                      <div className="flex-1">
                        {editName ? (
                          <input autoFocus value={agent.name} onChange={e => setAgent({ ...agent, name: e.target.value })} onBlur={() => setEditName(false)} onKeyDown={e => e.key === 'Enter' && setEditName(false)} className="bg-transparent border-b border-accent-cyan/50 text-foreground font-orbitron font-bold text-xl outline-none" />
                        ) : (
                          <h3 onClick={() => setEditName(true)} className="font-orbitron font-bold text-xl text-foreground cursor-pointer hover:text-accent-cyan transition-colors">{agent.name} <Pencil className="w-3.5 h-3.5 inline text-muted-foreground" /></h3>
                        )}
                        <span className="text-sm text-muted-foreground">{agent.domain}</span>
                      </div>
                      <span className="px-3 py-1 rounded-full bg-accent-emerald/20 text-accent-emerald text-xs font-medium border border-accent-emerald/30 animate-pulse">✅ Prêt à déployer</span>
                    </div>

                    {/* Personality */}
                    <div className="mb-6">
                      <h4 className="text-sm font-semibold text-foreground mb-3">Personnalité</h4>
                      <div className="flex flex-wrap gap-2 mb-4">
                        {agent.traits.map(t => (
                          <span key={t} className="px-3 py-1 rounded-full bg-accent-purple/15 text-accent-purple text-xs font-medium border border-accent-purple/25">{t}</span>
                        ))}
                      </div>
                      <div className="space-y-3">
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-muted-foreground w-16">Ton</span>
                          <span className="text-xs text-muted-foreground/60">Formel</span>
                          <Slider value={tonSlider} onValueChange={setTonSlider} max={100} step={1} className="flex-1" />
                          <span className="text-xs text-muted-foreground/60">Décontracté</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-muted-foreground w-16">Énergie</span>
                          <span className="text-xs text-muted-foreground/60">Calme</span>
                          <Slider value={energySlider} onValueChange={setEnergySlider} max={100} step={1} className="flex-1" />
                          <span className="text-xs text-muted-foreground/60">Dynamique</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-muted-foreground w-16">Détail</span>
                          <span className="text-xs text-muted-foreground/60">Concis</span>
                          <Slider value={detailSlider} onValueChange={setDetailSlider} max={100} step={1} className="flex-1" />
                          <span className="text-xs text-muted-foreground/60">Détaillé</span>
                        </div>
                      </div>
                    </div>

                    {/* Skills */}
                    <div className="mb-6">
                      <h4 className="text-sm font-semibold text-foreground mb-3">Compétences</h4>
                      <div className="space-y-2">
                        {agent.skills.map((skill, i) => (
                          <div key={i} className="flex items-center justify-between bg-secondary/30 rounded-lg px-4 py-2.5">
                            <span className="text-sm text-foreground/80">{skill}</span>
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/20 font-medium">IA</span>
                              <Switch checked={skillToggles[i] ?? true} onCheckedChange={v => { const n = [...skillToggles]; n[i] = v; setSkillToggles(n); }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Widget Appearance */}
                    <div className="mb-6">
                      <h4 className="text-sm font-semibold text-foreground mb-3">Apparence du Widget</h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                          <label className="text-xs text-muted-foreground mb-1 block">Couleur principale</label>
                          <div className="flex items-center gap-2">
                            <input type="color" value={widgetColor} onChange={e => setWidgetColor(e.target.value)} className="w-8 h-8 rounded border-none cursor-pointer" />
                            <span className="text-xs text-muted-foreground">{widgetColor}</span>
                          </div>
                        </div>
                        <div>
                          <label className="text-xs text-muted-foreground mb-1 block">Position</label>
                          <Select value={widgetPosition} onValueChange={setWidgetPosition}>
                            <SelectTrigger className="bg-secondary/50 border-accent-cyan/20 text-sm"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="bottom-right">Bas-droite</SelectItem>
                              <SelectItem value="bottom-left">Bas-gauche</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="flex items-center justify-between sm:col-span-2">
                          <span className="text-xs text-muted-foreground">Bulle de bienvenue automatique</span>
                          <Switch checked={autoBubble} onCheckedChange={setAutoBubble} />
                        </div>
                        <div className="sm:col-span-2">
                          <label className="text-xs text-muted-foreground mb-1 block">Message de bienvenue</label>
                          <textarea value={welcomeMsg} onChange={e => setWelcomeMsg(e.target.value)} rows={2} className="w-full bg-secondary/40 border border-accent-cyan/20 rounded-lg px-3 py-2 text-sm text-foreground resize-none focus:outline-none focus:border-accent-cyan/50" />
                        </div>
                      </div>
                      {/* Mini widget preview */}
                      <div className="mt-4 flex justify-end">
                        <div className="w-64 futuristic-card p-3" style={{ borderColor: `${widgetColor}40` }}>
                          <div className="flex items-center gap-2 mb-2">
                            <div className="w-7 h-7 rounded-full flex items-center justify-center text-sm" style={{ background: widgetColor }}>{agent.emoji}</div>
                            <span className="text-xs font-semibold text-foreground">{agent.name}</span>
                          </div>
                          <div className="bg-secondary/40 rounded-lg p-2">
                            <p className="text-[11px] text-foreground/70">{welcomeMsg.slice(0, 80)}{welcomeMsg.length > 80 ? '...' : ''}</p>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Advanced config */}
                    <Accordion type="single" collapsible>
                      <AccordionItem value="advanced" className="border-accent-cyan/10">
                        <AccordionTrigger className="text-sm font-semibold text-foreground hover:no-underline py-3">
                          Configuration Avancée
                        </AccordionTrigger>
                        <AccordionContent className="space-y-4 pt-2">
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                              <label className="text-xs text-muted-foreground mb-1 block">Langue principale</label>
                              <Select value={mainLang} onValueChange={setMainLang}>
                                <SelectTrigger className="bg-secondary/50 border-accent-cyan/20 text-sm"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  {['FR', 'EN', 'ES', 'DE', 'IT', 'AR', 'ZH', 'JA'].map(l => <SelectItem key={l} value={l}>{l}</SelectItem>)}
                                </SelectContent>
                              </Select>
                            </div>
                            <div>
                              <label className="text-xs text-muted-foreground mb-1 block">Temps de réponse</label>
                              <Select value={responseDelay} onValueChange={setResponseDelay}>
                                <SelectTrigger className="bg-secondary/50 border-accent-cyan/20 text-sm"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="instant">Instantané</SelectItem>
                                  <SelectItem value="natural">Naturel (1-3s)</SelectItem>
                                  <SelectItem value="realistic">Réaliste (3-5s)</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-muted-foreground">Transférer à un humain si l'IA ne sait pas</span>
                            <Switch checked={humanFallback} onCheckedChange={setHumanFallback} />
                          </div>
                          <div>
                            <label className="text-xs text-muted-foreground mb-1 block">Sujets interdits</label>
                            <textarea value={bannedTopics} onChange={e => setBannedTopics(e.target.value)} placeholder="Sujets que l'agent ne doit jamais aborder..." rows={2} className="w-full bg-secondary/40 border border-accent-cyan/20 rounded-lg px-3 py-2 text-sm text-foreground resize-none focus:outline-none focus:border-accent-cyan/50 placeholder:text-muted-foreground/40" />
                          </div>
                        </AccordionContent>
                      </AccordionItem>
                    </Accordion>

                    {/* Actions */}
                    <div className="flex flex-wrap gap-3 mt-6 pt-6 border-t border-border/30">
                      <motion.button whileHover={{ scale: 1.02 }} className="btn-primary flex items-center gap-2 text-sm px-5 py-2.5" onClick={() => toast.success('Agent déployé avec succès !')}>
                        <Rocket className="w-4 h-4" /> Déployer sur mon site
                      </motion.button>
                      <button onClick={openChat} className="btn-secondary flex items-center gap-2 text-sm px-5 py-2.5">
                        <Eye className="w-4 h-4" /> Tester mon agent
                      </button>
                      <button onClick={() => { navigator.clipboard.writeText(`<script src="https://purama.ai/widget/${agent.name.toLowerCase()}"></script>`); toast.success('Code copié !'); }} className="flex items-center gap-2 text-sm px-4 py-2 text-muted-foreground hover:text-foreground transition-colors">
                        <Copy className="w-4 h-4" /> Copier le code
                      </button>
                      <button onClick={() => { setPhase('forging'); setForgeStep(0); let s = 0; const iv = setInterval(() => { s++; setForgeStep(s); if (s >= forgeSteps.length) { clearInterval(iv); const r = generateAgent(prompt); setAgent(r); setWelcomeMsg(r.welcome); setSkillToggles(r.skills.map(() => true)); setPhase('result'); } }, 900); }} className="flex items-center gap-2 text-sm px-4 py-2 text-muted-foreground hover:text-foreground transition-colors">
                        <RotateCcw className="w-4 h-4" /> Régénérer
                      </button>
                      <button onClick={() => { setPhase('input'); }} className="flex items-center gap-2 text-sm px-4 py-2 text-muted-foreground hover:text-foreground transition-colors">
                        <Pencil className="w-4 h-4" /> Modifier le prompt
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          </div>
        </section>

        {/* ════════ TEMPLATES ════════ */}
        <section className="relative px-6 py-20 overflow-hidden">
          <div className="absolute inset-0 grid-pattern opacity-10" />
          <div className="container mx-auto max-w-6xl relative z-10">
            <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="text-center mb-10">
              <h2 className="text-3xl sm:text-4xl font-orbitron font-bold mb-3">
                <span className="text-foreground">🎯 Pas d'inspiration ? </span>
                <span className="gradient-text">Choisis un template</span>
              </h2>
              <p className="text-muted-foreground">Des agents pré-configurés par des experts. Un clic, c'est prêt.</p>
            </motion.div>

            {/* Category tabs */}
            <div className="flex flex-wrap gap-2 justify-center mb-8">
              {categories.map(cat => (
                <button key={cat} onClick={() => setSelectedCategory(cat)} className={`px-4 py-1.5 rounded-full text-xs font-medium transition-all ${selectedCategory === cat ? 'bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/40' : 'bg-secondary/40 text-muted-foreground border border-border/30 hover:border-accent-cyan/20'}`}>
                  {cat}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {filteredTemplates.map((t, i) => (
                <motion.div key={t.name} initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.05 }} className="futuristic-card p-5 cursor-pointer group" onClick={() => useTemplate(t.prompt)}>
                  <div className="flex items-center gap-3 mb-3">
                    <span className="text-3xl">{t.emoji}</span>
                    <div>
                      <h4 className="font-orbitron font-bold text-foreground text-sm">{t.name}</h4>
                      <p className="text-xs text-muted-foreground">{t.desc}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="px-2 py-0.5 rounded text-[10px] bg-secondary/50 text-muted-foreground border border-border/30">{t.category}</span>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${t.tier === 'Gratuit' ? 'bg-accent-emerald/10 text-accent-emerald border border-accent-emerald/20' : t.tier === 'Pro' ? 'bg-accent-purple/10 text-accent-purple border border-accent-purple/20' : 'bg-accent-blue/10 text-accent-blue border border-accent-blue/20'}`}>{t.tier}</span>
                  </div>
                  <button className="text-xs text-accent-cyan font-semibold group-hover:underline">Utiliser ce template →</button>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* ════════ COMMUNITY GALLERY ════════ */}
        <section className="relative px-6 py-20 overflow-hidden">
          <div className="container mx-auto max-w-6xl relative z-10">
            <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="text-center mb-10">
              <h2 className="text-3xl sm:text-4xl font-orbitron font-bold mb-3">
                <span className="text-foreground">🌟 Agents créés par la </span>
                <span className="gradient-text">communauté</span>
              </h2>
              <p className="text-muted-foreground">Découvre les agents les plus populaires créés par d'autres utilisateurs.</p>
            </motion.div>

            {/* Search & sort */}
            <div className="flex flex-col sm:flex-row gap-3 justify-center mb-8">
              <div className="relative max-w-sm w-full">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input value={gallerySearch} onChange={e => setGallerySearch(e.target.value)} placeholder="Rechercher un agent..." className="w-full bg-secondary/40 border border-accent-cyan/20 rounded-lg pl-9 pr-4 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-accent-cyan/50" />
              </div>
              <div className="flex gap-2">
                {[
                  { key: 'popular' as const, label: 'Plus populaires' },
                  { key: 'recent' as const, label: 'Plus récents' },
                  { key: 'rated' as const, label: 'Mieux notés' },
                ].map(s => (
                  <button key={s.key} onClick={() => setGallerySort(s.key)} className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${gallerySort === s.key ? 'bg-accent-cyan/15 text-accent-cyan border border-accent-cyan/30' : 'text-muted-foreground hover:text-foreground'}`}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
              {filteredGallery.map((a, i) => (
                <motion.div key={a.name} initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.05 }} className="futuristic-card p-5 relative">
                  {a.top && <span className="absolute top-3 right-3 text-xs px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 font-medium">🏆 Top</span>}
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-12 h-12 rounded-full bg-gradient-to-r from-accent-purple/30 to-accent-cyan/30 flex items-center justify-center text-2xl">{a.emoji}</div>
                    <div>
                      <h4 className="font-orbitron font-bold text-foreground text-sm">{a.name}</h4>
                      <p className="text-xs text-muted-foreground">{a.domain}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 mb-3 text-xs text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <div className="w-5 h-5 rounded-full bg-accent-purple/20 flex items-center justify-center text-[10px]">{a.creator[0]}</div>
                      <span>{a.creator}</span>
                    </div>
                    <span>{a.uses} utilisations</span>
                  </div>
                  <div className="flex items-center gap-1 mb-3">
                    {Array(5).fill(0).map((_, j) => (
                      <Star key={j} className={`w-3.5 h-3.5 ${j < Math.floor(a.rating) ? 'fill-yellow-400 text-yellow-400' : 'text-muted-foreground/30'}`} />
                    ))}
                    <span className="text-xs text-muted-foreground ml-1">{a.rating}</span>
                  </div>
                  <button onClick={() => toast.success(`Agent "${a.name}" dupliqué !`)} className="text-xs text-accent-cyan font-semibold hover:underline">Dupliquer cet agent →</button>
                </motion.div>
              ))}
            </div>
          </div>
        </section>
      </main>

      {/* ════════ CHAT SIMULATOR MODAL ════════ */}
      <Dialog open={chatOpen} onOpenChange={setChatOpen}>
        <DialogContent className="max-w-lg sm:max-w-2xl h-[80vh] flex flex-col p-0 bg-card border-accent-cyan/20 gap-0">
          {/* Chat header */}
          <div className="flex items-center gap-3 p-4 border-b border-border/30">
            <div className="w-10 h-10 rounded-full flex items-center justify-center text-xl" style={{ background: agent ? `${agent.color}30` : undefined }}>
              {agent?.emoji}
            </div>
            <div className="flex-1">
              <h4 className="font-orbitron font-bold text-foreground text-sm">{agent?.name}</h4>
              <span className="text-xs text-muted-foreground">{agent?.domain}</span>
            </div>
            <span className="px-2 py-0.5 rounded text-[10px] bg-orange-500/20 text-orange-400 border border-orange-500/30 font-medium">Mode Test</span>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {chatMessages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm ${msg.role === 'user' ? 'bg-accent-cyan/20 text-foreground rounded-br-md' : 'bg-secondary/60 text-foreground/90 rounded-bl-md'}`}>
                  {msg.text}
                </div>
              </div>
            ))}
            {isTyping && (
              <div className="flex justify-start">
                <div className="bg-secondary/60 rounded-2xl rounded-bl-md px-4 py-3 flex gap-1">
                  <motion.span animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1, repeat: Infinity, delay: 0 }} className="w-2 h-2 rounded-full bg-accent-cyan" />
                  <motion.span animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1, repeat: Infinity, delay: 0.2 }} className="w-2 h-2 rounded-full bg-accent-cyan" />
                  <motion.span animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1, repeat: Infinity, delay: 0.4 }} className="w-2 h-2 rounded-full bg-accent-cyan" />
                </div>
              </div>
            )}
          </div>

          {/* Input */}
          <div className="p-4 border-t border-border/30">
            <div className="flex gap-2">
              <input value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && sendChat()} placeholder="Taper un message..." className="flex-1 bg-secondary/40 border border-accent-cyan/20 rounded-lg px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-accent-cyan/50" />
              <button onClick={sendChat} className="btn-primary px-4 py-2.5">
                <Send className="w-4 h-4" />
              </button>
            </div>
            <div className="flex justify-between mt-3">
              <button onClick={() => setChatOpen(false)} className="text-xs text-muted-foreground hover:text-foreground transition-colors">Fermer le test</button>
              <button onClick={() => { setChatOpen(false); toast.success('Agent déployé !'); }} className="text-xs text-accent-cyan font-semibold hover:underline">Satisfait ? Déployer →</button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
