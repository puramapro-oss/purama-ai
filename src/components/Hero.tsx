import { motion, useReducedMotion } from 'framer-motion';
import { Link } from 'react-router-dom';
import {
  Menu, X, Bot, ArrowRight, LogIn, UserPlus, Users, Star,
  Mail, Calculator, Scale, Handshake, Brain, Sparkles,
} from 'lucide-react';
import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useInfluencer } from '@/hooks/useInfluencer';
import { Button } from '@/components/ui/button';
import { MagneticButton } from '@/components/shared/MagneticButton';
import { isSuperAdmin } from '@/lib/constants';

const AGENTS = [
  { icon: Mail, label: 'Email', desc: 'Tri, réponses, relances', tint: 'from-cyan-400/20 to-cyan-400/5', ring: 'ring-cyan-400/20', to: '/dashboard/email-agent' },
  { icon: Calculator, label: 'Compta', desc: 'Factures, TVA, exports', tint: 'from-violet-400/20 to-violet-400/5', ring: 'ring-violet-400/20', to: '/dashboard/compta-agent' },
  { icon: Scale, label: 'Juridique', desc: 'CGV, contrats, veille', tint: 'from-pink-400/20 to-pink-400/5', ring: 'ring-pink-400/20', to: '/dashboard/legal-agent' },
  { icon: Handshake, label: 'Partenariats', desc: 'Prospects, cold emails', tint: 'from-emerald-400/20 to-emerald-400/5', ring: 'ring-emerald-400/20', to: '/dashboard/partner-agent' },
  { icon: Brain, label: 'Créateur', desc: 'Compose ton agent', tint: 'from-amber-400/20 to-amber-400/5', ring: 'ring-amber-400/20', to: '/dashboard/creator-agent' },
  { icon: Sparkles, label: 'Forge', desc: 'Sites & automations', tint: 'from-blue-400/20 to-blue-400/5', ring: 'ring-blue-400/20', to: '/forge' },
];

const NAV = [
  { label: 'Agents', href: '#agents-section-wrapper' },
  { label: 'Tarifs', to: '/pricing' },
  { label: 'Forge', to: '/forge', isNew: true },
  { label: 'Aide', to: '/aide' },
];

export function Hero() {
  const { user, loading } = useAuth();
  const { influencer } = useInfluencer();
  const [isScrolled, setIsScrolled] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const handleScroll = () => setIsScrolled(window.scrollY > 20);
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    if (!isMobileMenuOpen) return;
    document.body.style.overflow = 'hidden';
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && setIsMobileMenuOpen(false);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('keydown', onEsc);
      document.body.style.overflow = 'unset';
    };
  }, [isMobileMenuOpen]);

  const isAdmin = isSuperAdmin(user?.email);

  return (
    <div className="relative min-h-[100svh] w-full overflow-hidden aurora-bg noise-overlay">
      <div className="aurora-orb aurora-orb-1" aria-hidden="true" />
      <div className="aurora-orb aurora-orb-2" aria-hidden="true" />
      <div className="aurora-orb aurora-orb-3" aria-hidden="true" />
      <div className="absolute inset-0 grid-pattern opacity-30 pointer-events-none" aria-hidden="true" />

      {/* Floating pill navbar — iOS Dynamic Island vibe */}
      <motion.nav
        initial={{ opacity: 0, y: -16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.15 }}
        className="fixed top-3 sm:top-4 left-0 right-0 z-[110] px-3 sm:px-6"
      >
        <div
          className={`mx-auto max-w-6xl rounded-2xl transition-all duration-300 ${
            isScrolled
              ? 'bg-background/60 backdrop-blur-2xl border border-white/[0.08] shadow-[0_8px_32px_-8px_rgba(0,0,0,0.5)]'
              : 'bg-white/[0.03] backdrop-blur-xl border border-white/[0.06]'
          }`}
        >
          <div className="flex items-center justify-between gap-4 px-4 sm:px-5 py-2.5 sm:py-3">
            <Link
              to="/"
              className="flex items-center gap-2.5 shrink-0"
              onClick={(e) => {
                if (window.location.pathname === '/') {
                  e.preventDefault();
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }
              }}
            >
              <div className="relative w-8 h-8 rounded-xl bg-gradient-to-br from-accent-cyan to-accent-purple flex items-center justify-center shadow-[0_0_16px_rgba(0,240,255,0.35)]">
                <Bot className="w-4.5 h-4.5 text-white" strokeWidth={2.2} />
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-accent-emerald soft-ping" />
              </div>
              <span className="font-orbitron text-foreground text-[15px] sm:text-base tracking-wider font-bold">
                PURAMA<span className="text-accent-cyan"> AI</span>
              </span>
            </Link>

            <div className="hidden lg:flex items-center gap-1">
              {NAV.map((item) =>
                item.href ? (
                  <a
                    key={item.label}
                    href={item.href}
                    className="px-3 py-1.5 rounded-lg text-[13px] text-foreground/70 hover:text-foreground hover:bg-white/[0.04] font-medium transition-colors"
                  >
                    {item.label}
                  </a>
                ) : (
                  <Link
                    key={item.label}
                    to={item.to!}
                    className="px-3 py-1.5 rounded-lg text-[13px] text-foreground/70 hover:text-foreground hover:bg-white/[0.04] font-medium transition-colors relative"
                  >
                    {item.label}
                    {item.isNew && (
                      <span className="absolute -top-1 -right-1 px-1 py-0.5 rounded text-[8px] font-bold bg-accent-pink/25 text-accent-pink border border-accent-pink/30">
                        NEW
                      </span>
                    )}
                  </Link>
                )
              )}
              {user && (
                <Link to="/dashboard" className="px-3 py-1.5 rounded-lg text-[13px] text-foreground/70 hover:text-accent-cyan font-medium transition-colors">
                  Dashboard
                </Link>
              )}
              {isAdmin && (
                <Link to="/admin/dashboard" className="px-3 py-1.5 rounded-lg text-[13px] text-amber-400/80 hover:text-amber-300 font-medium transition-colors">
                  Admin
                </Link>
              )}
            </div>

            <div className="hidden lg:flex items-center gap-2">
              {!loading && !user ? (
                <>
                  <Link to="/login">
                    <Button variant="ghost" size="sm" className="h-9 text-[13px] text-foreground/75 hover:text-foreground hover:bg-white/[0.04] rounded-lg">
                      Connexion
                    </Button>
                  </Link>
                  <Link to="/signup">
                    <Button size="sm" className="h-9 px-4 text-[13px] font-semibold rounded-lg bg-white text-background hover:bg-white/90 shadow-[0_0_0_1px_rgba(255,255,255,0.1)_inset]">
                      Commencer
                      <ArrowRight className="w-3.5 h-3.5 ml-1" />
                    </Button>
                  </Link>
                </>
              ) : !loading && user ? (
                <Link to="/dashboard">
                  <Button size="sm" className="h-9 px-4 text-[13px] rounded-lg bg-gradient-to-r from-accent-cyan to-accent-purple text-white hover:opacity-90">
                    Dashboard
                    <ArrowRight className="w-3.5 h-3.5 ml-1" />
                  </Button>
                </Link>
              ) : null}
            </div>

            <button
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              className="lg:hidden p-2 rounded-lg text-foreground bg-white/[0.04] border border-white/[0.06]"
              aria-label={isMobileMenuOpen ? 'Fermer le menu' : 'Ouvrir le menu'}
              aria-expanded={isMobileMenuOpen}
            >
              {isMobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </motion.nav>

      {/* Mobile Menu */}
      {isMobileMenuOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="lg:hidden fixed inset-0 bg-background/85 backdrop-blur-md z-[100]"
            onClick={() => setIsMobileMenuOpen(false)}
            aria-hidden="true"
          />
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            transition={{ type: 'spring', damping: 28, stiffness: 260 }}
            className="lg:hidden fixed top-0 right-0 h-full w-[85%] max-w-sm bg-card border-l border-white/[0.06] z-[105] p-6 pt-24 overflow-y-auto"
          >
            <div className="flex flex-col gap-2">
              {[
                { label: 'Agents', href: '#agents-section-wrapper' },
                { label: 'Tarifs', to: '/pricing' },
                { label: 'Forge', to: '/forge' },
                { label: 'Aide', to: '/aide' },
                ...(user ? [{ label: 'Dashboard', to: '/dashboard' }] : []),
                ...(isAdmin ? [{ label: 'Admin', to: '/admin/dashboard' }] : []),
              ].map((item) =>
                item.href ? (
                  <a
                    key={item.label}
                    href={item.href}
                    onClick={() => setIsMobileMenuOpen(false)}
                    className="text-base text-foreground hover:text-accent-cyan p-3 rounded-xl hover:bg-white/[0.04] transition-all font-medium"
                  >
                    {item.label}
                  </a>
                ) : (
                  <Link
                    key={item.label}
                    to={item.to!}
                    onClick={() => setIsMobileMenuOpen(false)}
                    className="text-base text-foreground hover:text-accent-cyan p-3 rounded-xl hover:bg-white/[0.04] transition-all font-medium"
                  >
                    {item.label}
                  </Link>
                )
              )}

              <div className="border-t border-white/[0.06] pt-3 mt-2 flex flex-col gap-2">
                <Link
                  to="/influenceur/inscription"
                  onClick={() => setIsMobileMenuOpen(false)}
                  className="text-foreground/80 hover:text-accent-cyan p-3 rounded-xl hover:bg-white/[0.04] transition-all flex items-center gap-2 text-sm"
                >
                  <Users className="w-4 h-4" />
                  Devenir Influenceur
                </Link>
                {influencer && (
                  <Link
                    to="/influenceur/dashboard"
                    onClick={() => setIsMobileMenuOpen(false)}
                    className="text-foreground/80 hover:text-accent-cyan p-3 rounded-xl hover:bg-white/[0.04] transition-all flex items-center gap-2 text-sm"
                  >
                    <Star className="w-4 h-4" />
                    Espace Influenceur
                  </Link>
                )}
              </div>

              {!loading && !user ? (
                <div className="flex flex-col gap-2 mt-4 pt-4 border-t border-white/[0.06]">
                  <Link to="/login" onClick={() => setIsMobileMenuOpen(false)}>
                    <Button variant="outline" className="w-full h-11 rounded-xl">
                      <LogIn className="w-4 h-4 mr-2" />
                      Connexion
                    </Button>
                  </Link>
                  <Link to="/signup" onClick={() => setIsMobileMenuOpen(false)}>
                    <Button className="w-full h-11 rounded-xl bg-white text-background hover:bg-white/90 font-semibold">
                      <UserPlus className="w-4 h-4 mr-2" />
                      Inscription
                    </Button>
                  </Link>
                </div>
              ) : !loading && user ? (
                <Link to="/dashboard" onClick={() => setIsMobileMenuOpen(false)} className="mt-4">
                  <Button className="w-full h-11 rounded-xl bg-gradient-to-r from-accent-cyan to-accent-purple">
                    Mon Dashboard
                    <ArrowRight className="w-4 h-4 ml-2" />
                  </Button>
                </Link>
              ) : null}
            </div>
          </motion.div>
        </>
      )}

      {/* Hero content */}
      <div className="relative z-10 flex flex-col items-center justify-center min-h-[100svh] px-6 sm:px-8 pt-32 pb-24 sm:pt-36 sm:pb-32">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.25 }}
          className="text-center max-w-4xl mx-auto w-full"
        >
          {/* Eyebrow pill */}
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5, delay: 0.4 }}
            className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full mb-8 bg-white/[0.04] border border-white/[0.08] backdrop-blur-xl"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-accent-emerald soft-ping" />
            <span className="text-[12px] sm:text-[13px] font-medium text-foreground/80 tracking-wide">
              Plateforme française d'agents IA
            </span>
          </motion.div>

          {/* Headline — clean iOS display */}
          <h1 className="font-orbitron font-black leading-[0.92] tracking-[-0.02em] mb-6 sm:mb-8 text-[clamp(2.5rem,9vw,6rem)]">
            <motion.span
              className="block text-foreground"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.5 }}
            >
              Tes agents IA
            </motion.span>
            <motion.span
              className="block gradient-text"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.65 }}
              style={{ textShadow: reduceMotion ? undefined : '0 0 80px rgba(124,58,237,0.3)' }}
            >
              travaillent pour toi
            </motion.span>
          </h1>

          {/* Subtitle */}
          <motion.p
            className="text-[17px] sm:text-lg lg:text-xl text-foreground/60 max-w-xl mx-auto mb-10 sm:mb-12 leading-[1.55]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.7, delay: 0.85 }}
          >
            Email, compta, juridique, partenariats. Configure une fois, laisse Purama gérer le reste.
          </motion.p>

          {/* CTAs */}
          <motion.div
            className="flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-4"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 1 }}
          >
            <Link to={user ? '/dashboard' : '/signup'} className="w-full sm:w-auto">
              <MagneticButton
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 h-[52px] px-7 rounded-2xl bg-white text-background font-semibold text-[15px] shadow-[0_8px_32px_-8px_rgba(255,255,255,0.35),0_0_0_1px_rgba(255,255,255,0.1)_inset] hover:shadow-[0_12px_40px_-8px_rgba(255,255,255,0.5),0_0_0_1px_rgba(255,255,255,0.1)_inset] transition-shadow"
              >
                {user ? 'Aller au Dashboard' : 'Commencer gratuitement'}
                <ArrowRight className="w-4 h-4" />
              </MagneticButton>
            </Link>
            <a href="#agents-section-wrapper" className="w-full sm:w-auto">
              <button className="w-full sm:w-auto inline-flex items-center justify-center gap-2 h-[52px] px-7 rounded-2xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-foreground/85 hover:text-foreground font-semibold text-[15px] transition-colors backdrop-blur-xl">
                Voir les agents
              </button>
            </a>
          </motion.div>
        </motion.div>

        {/* Agents grid — iOS-style glass cards */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 1.1 }}
          className="mt-16 sm:mt-24 w-full max-w-5xl"
        >
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 sm:gap-4">
            {AGENTS.map(({ icon: Icon, label, desc, tint, ring, to }, i) => (
              <motion.div
                key={label}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 1.2 + i * 0.06 }}
              >
                <Link
                  to={to}
                  className="group relative block rounded-3xl p-5 sm:p-6 bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.06] hover:border-white/[0.12] backdrop-blur-xl transition-all duration-300 hover:-translate-y-0.5"
                >
                  <div className={`w-11 h-11 sm:w-12 sm:h-12 rounded-2xl bg-gradient-to-br ${tint} ring-1 ${ring} flex items-center justify-center mb-4`}>
                    <Icon className="w-5 h-5 sm:w-[22px] sm:h-[22px] text-foreground" strokeWidth={1.75} />
                  </div>
                  <div className="text-[15px] sm:text-base font-semibold text-foreground mb-1 tracking-tight">
                    {label}
                  </div>
                  <div className="text-[12px] sm:text-[13px] text-foreground/55 leading-snug">
                    {desc}
                  </div>
                  <ArrowRight className="absolute top-5 right-5 w-4 h-4 text-foreground/30 group-hover:text-foreground/70 group-hover:translate-x-0.5 transition-all" />
                </Link>
              </motion.div>
            ))}
          </div>
        </motion.div>
      </div>
    </div>
  );
}
