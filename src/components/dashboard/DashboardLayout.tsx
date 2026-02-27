import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { 
  Home, Brain, Globe, Smartphone, Bot, BarChart3, CreditCard, Settings, 
  Zap, ChevronLeft, Menu, X, LogOut
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { Button } from '@/components/ui/button';

const navItems = [
  { label: 'Vue d\'ensemble', icon: Home, to: '/dashboard' },
  { label: 'Mes Agents IA', icon: Brain, to: '/dashboard/agents', badge: '3' },
  { label: 'Mes Sites', icon: Globe, to: '/dashboard/sites' },
  { label: 'Mes Applications', icon: Smartphone, to: '/dashboard/apps' },
  { label: 'Agents Automatiques', icon: Bot, to: '/dashboard/auto-agents', badge: '6' },
  { label: 'Analytics', icon: BarChart3, to: '/dashboard/analytics' },
  { label: 'Abonnement & Crédits', icon: CreditCard, to: '/dashboard/billing' },
  { label: 'Paramètres', icon: Settings, to: '/dashboard/settings' },
];

export function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const { user, signOut } = useAuth();
  const { data: profile } = useProfile();
  const location = useLocation();

  const isActive = (path: string) => location.pathname === path;

  const SidebarContent = () => (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className="p-4 flex items-center gap-2">
        <Bot className="w-7 h-7 text-accent-cyan flex-shrink-0" />
        {sidebarOpen && <span className="font-orbitron text-foreground font-bold">PURAMA <span className="text-accent-cyan">AI</span></span>}
      </div>

      <div className="h-px bg-border mx-4" />

      {/* Nav items */}
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
            {sidebarOpen && (
              <>
                <span className="flex-1">{item.label}</span>
                {item.badge && (
                  <span className="px-1.5 py-0.5 rounded-full bg-accent-purple/20 text-accent-purple text-xs">{item.badge}</span>
                )}
              </>
            )}
          </Link>
        ))}
      </nav>

      <div className="h-px bg-border mx-4" />

      {/* Create Agent Button */}
      <div className="p-3">
        <Link to="/dashboard" className={`flex items-center gap-2 px-3 py-2.5 rounded-lg bg-gradient-to-r from-accent-cyan/20 to-accent-purple/20 border border-accent-cyan/30 text-accent-cyan text-sm font-semibold hover:from-accent-cyan/30 hover:to-accent-purple/30 transition-all ${!sidebarOpen ? 'justify-center' : ''}`}>
          <Zap className="w-4 h-4 flex-shrink-0" />
          {sidebarOpen && <span>Origin Forge — Créer</span>}
        </Link>
      </div>

      {/* User Profile */}
      <div className="p-3 border-t border-border">
        <div className="flex items-center gap-3 px-2">
          <div className="w-8 h-8 rounded-full bg-gradient-to-r from-accent-purple to-accent-pink flex items-center justify-center text-xs font-bold text-foreground flex-shrink-0">
            {profile?.full_name?.[0] || user?.email?.[0]?.toUpperCase() || 'U'}
          </div>
          {sidebarOpen && (
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground truncate">{profile?.full_name || 'Utilisateur'}</p>
              <p className="text-xs text-muted-foreground">Plan Pro</p>
            </div>
          )}
        </div>
        <div className="flex gap-2 mt-2">
          <Link to="/" className="flex-1">
            <Button variant="ghost" size="sm" className="w-full text-xs text-muted-foreground">
              <ChevronLeft className="w-3 h-3 mr-1" /> {sidebarOpen ? 'Retour au site' : ''}
            </Button>
          </Link>
          {sidebarOpen && (
            <Button variant="ghost" size="sm" onClick={() => signOut()} className="text-xs text-muted-foreground">
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
      <aside className={`hidden md:flex flex-col border-r border-border bg-card transition-all duration-300 ${sidebarOpen ? 'w-64' : 'w-16'}`}>
        <SidebarContent />
      </aside>

      {/* Mobile sidebar */}
      {mobileSidebarOpen && (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="md:hidden fixed inset-0 bg-background/80 backdrop-blur-sm z-40" onClick={() => setMobileSidebarOpen(false)} />
          <motion.aside initial={{ x: -280 }} animate={{ x: 0 }} className="md:hidden fixed left-0 top-0 bottom-0 w-64 bg-card border-r border-border z-50">
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
          <span className="font-orbitron font-bold text-foreground">PURAMA <span className="text-accent-cyan">AI</span></span>
          <div className="w-6" />
        </header>

        {/* Toggle sidebar on desktop */}
        <div className="hidden md:block p-2">
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="p-1.5 rounded-lg hover:bg-secondary/50 text-muted-foreground">
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
