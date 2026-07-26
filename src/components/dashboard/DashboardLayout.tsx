import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Home, Brain, BarChart3, CreditCard, Settings,
  Menu, LogOut, Bot, ChevronLeft, ArrowLeft, Shield, Globe2, Mail, Calculator, Handshake, Scale, Sparkles,
  Wallet, Star, Gift, Ticket, HelpCircle, BookOpen, Wind, Heart, Users
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ExecutionCounter } from '@/components/dashboard/ExecutionCounter';
import { SUPER_ADMIN_EMAIL } from '@/lib/constants';

const ADMIN_EMAIL = SUPER_ADMIN_EMAIL;

const navItems = [
  { tKey: 'nav.home', icon: Home, to: '/dashboard' },
  { tKey: 'nav.agents', icon: Brain, to: '/dashboard/agents' },
  { tKey: 'nav.analytics', icon: BarChart3, to: '/dashboard/analytics' },
  { tKey: 'nav.subscription', icon: CreditCard, to: '/dashboard/billing' },
  { tKey: 'nav.social', icon: Globe2, to: '/dashboard/social' },
  { tKey: 'nav.emailAgent', icon: Mail, to: '/dashboard/email-agent' },
  { tKey: 'nav.comptaAgent', icon: Calculator, to: '/dashboard/compta-agent' },
  { tKey: 'nav.partnerAgent', icon: Handshake, to: '/dashboard/partner-agent' },
  { tKey: 'nav.legalAgent', icon: Scale, to: '/dashboard/legal-agent' },
  { tKey: 'nav.creatorAgent', icon: Sparkles, to: '/dashboard/creator-agent' },
  { tKey: 'nav.employees', icon: Users, to: '/dashboard/employees' },
  { tKey: 'nav.wallet', icon: Wallet, to: '/dashboard/wallet' },
  { tKey: 'nav.points', icon: Star, to: '/dashboard/boutique' },
  { tKey: 'nav.dailyGift', icon: Gift, to: '/dashboard/daily-gift' },
  { tKey: 'nav.lottery', icon: Ticket, to: '/dashboard/tirage' },
  { tKey: 'nav.breathe', icon: Wind, to: '/dashboard/breathe' },
  { tKey: 'nav.gratitude', icon: Heart, to: '/dashboard/gratitude' },
  { tKey: 'nav.help', icon: HelpCircle, to: '/dashboard/aide' },
  { tKey: 'nav.guide', icon: BookOpen, to: '/dashboard/guide' },
  { tKey: 'nav.settings', icon: Settings, to: '/dashboard/settings' },
];

export function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const { user, signOut } = useAuth();
  const { data: profile } = useProfile();
  const location = useLocation();

  const isActive = (path: string) =>
    location.pathname === path ||
    (path !== '/dashboard' && location.pathname.startsWith(path + '/'));

  const SidebarContent = () => (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className="p-4 flex items-center gap-2">
        <Bot className="w-7 h-7 text-accent-cyan flex-shrink-0" />
        {sidebarOpen && (
          <span className="font-orbitron text-foreground font-bold">
            PURAMA <span className="text-accent-cyan">AI</span>
          </span>
        )}
      </div>

      <div className="h-px bg-border mx-4" />

      {/* Nav */}
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {navItems.map(item => (
          <Link
            key={item.to}
            to={item.to}
            onClick={() => setMobileSidebarOpen(false)}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all text-sm font-medium ${
              isActive(item.to)
                ? 'bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/20'
                : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
            }`}
          >
            <item.icon className="w-5 h-5 flex-shrink-0" />
            {sidebarOpen && <span>{t(item.tKey)}</span>}
          </Link>
        ))}
      </nav>

      {/* Admin link */}
      {user?.email === ADMIN_EMAIL && (
        <div className="px-3 pb-2">
          <Link
            to="/admin/dashboard"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-red-400 hover:bg-red-500/10 border border-red-500/20 transition-all"
          >
            <Shield className="w-5 h-5 flex-shrink-0" />
            {sidebarOpen && <span>Admin Panel</span>}
          </Link>
        </div>
      )}

      <div className="h-px bg-border mx-4" />

      {/* Execution counter */}
      {sidebarOpen && (
        <div className="px-3 pb-2">
          <ExecutionCounter variant="compact" />
        </div>
      )}

      {/* User */}
      <div className="p-3 border-t border-border">
        <div className="flex items-center gap-3 px-2">
          <div className="w-8 h-8 rounded-full bg-gradient-to-r from-accent-purple to-accent-pink flex items-center justify-center text-xs font-bold text-foreground flex-shrink-0">
            {profile?.full_name?.[0] || user?.email?.[0]?.toUpperCase() || 'U'}
          </div>
          {sidebarOpen && (
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground truncate">{profile?.full_name || 'Utilisateur'}</p>
              <p className="text-xs text-muted-foreground truncate">{user?.email}</p>
            </div>
          )}
        </div>
        <div className="flex gap-2 mt-2">
          <Link to="/" className="flex-1">
            <Button variant="ghost" size="sm" className="w-full text-xs text-muted-foreground">
              <ArrowLeft className="w-3 h-3 mr-1" /> {sidebarOpen ? 'Retour' : ''}
            </Button>
          </Link>
          {sidebarOpen && (
            <Button variant="ghost" size="sm" onClick={() => signOut()} className="text-xs text-muted-foreground hover:text-red-400">
              <LogOut className="w-3 h-3" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-background flex">
      {/* Desktop Sidebar */}
      <aside className={`hidden md:flex flex-col border-r border-border bg-card transition-all duration-300 ${sidebarOpen ? 'w-56' : 'w-16'}`}>
        <SidebarContent />
      </aside>

      {/* Mobile sidebar */}
      {mobileSidebarOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="md:hidden fixed inset-0 bg-background/80 backdrop-blur-sm z-40"
            onClick={() => setMobileSidebarOpen(false)}
          />
          <motion.aside
            initial={{ x: -280 }}
            animate={{ x: 0 }}
            className="md:hidden fixed left-0 top-0 bottom-0 w-56 bg-card border-r border-border z-50"
          >
            <SidebarContent />
          </motion.aside>
        </>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-h-screen overflow-x-hidden">
        {/* Mobile header */}
        <header className="md:hidden flex items-center justify-between p-4 border-b border-border bg-card">
          <button onClick={() => setMobileSidebarOpen(true)} className="text-foreground">
            <Menu className="w-6 h-6" />
          </button>
          <span className="font-orbitron font-bold text-foreground">
            PURAMA <span className="text-accent-cyan">AI</span>
          </span>
          <div className="w-6" />
        </header>

        {/* Toggle desktop */}
        <div className="hidden md:block p-2">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="p-1.5 rounded-lg hover:bg-secondary/50 text-muted-foreground"
          >
            <Menu className="w-4 h-4" />
          </button>
        </div>

        <main className="flex-1 p-4 md:p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
