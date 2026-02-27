import { motion } from 'framer-motion';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Link } from 'react-router-dom';
import { Search, Zap, MessageSquare, BarChart3, Pencil, TestTube } from 'lucide-react';
import { useState } from 'react';

const mockAgents = [
  { id: '1', name: 'ShopAssist', domain: '🛍️ E-Commerce', status: 'active', totalConv: 1240, monthConv: 342, rating: 4.8, responseTime: '1.2s', skills: ['Support client', 'Recommandations', 'Suivi commandes', 'FAQ', 'Retours', 'Avis', 'Upselling'], created: '15 janv. 2026', lastActive: 'il y a 3 min' },
  { id: '2', name: 'LegalBot', domain: '⚖️ Juridique', status: 'active', totalConv: 560, monthConv: 156, rating: 4.6, responseTime: '2.1s', skills: ['Questions juridiques', 'RGPD', 'Contrats', 'Conseil'], created: '22 janv. 2026', lastActive: 'il y a 15 min' },
  { id: '3', name: 'SupportPro', domain: '🎧 Support', status: 'config', totalConv: 0, monthConv: 0, rating: 0, responseTime: '-', skills: ['Tickets', 'FAQ', 'Escalade'], created: '27 fév. 2026', lastActive: 'jamais' },
];

export default function DashboardAgents() {
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  const filtered = mockAgents.filter(a => {
    if (filter === 'active' && a.status !== 'active') return false;
    if (filter === 'inactive' && a.status !== 'config') return false;
    if (search && !a.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-orbitron font-bold text-foreground">Mes Agents IA</h1>
          <p className="text-muted-foreground text-sm">2 agents actifs sur 5 disponibles (Plan Pro)</p>
        </div>
        <Link to="/dashboard" className="btn-primary flex items-center gap-2 text-sm px-4 py-2.5">
          <Zap className="w-4 h-4" /> Créer un nouvel Agent
        </Link>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex gap-2">
          {[{ label: 'Tous', value: 'all' }, { label: 'Actifs', value: 'active' }, { label: 'Inactifs', value: 'inactive' }].map(f => (
            <button key={f.value} onClick={() => setFilter(f.value)} className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${filter === f.value ? 'bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30' : 'bg-secondary/50 text-muted-foreground'}`}>{f.label}</button>
          ))}
        </div>
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Rechercher un agent..." className="w-full pl-9 pr-3 py-2 bg-secondary/50 border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:border-accent-cyan/50" />
        </div>
      </div>

      {/* Agent cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {filtered.map((agent, i) => (
          <motion.div key={agent.id} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.1 }}>
            <Card className="bg-card border-border hover:border-accent-cyan/30 transition-all">
              <CardContent className="p-5">
                {/* Header */}
                <div className="flex items-center gap-3 mb-4">
                  <div className={`w-14 h-14 rounded-full flex items-center justify-center text-xl font-bold ${agent.status === 'active' ? 'ring-2 ring-accent-emerald ring-offset-2 ring-offset-card' : 'ring-2 ring-yellow-500 ring-offset-2 ring-offset-card'}`} style={{ background: 'linear-gradient(135deg, var(--accent-purple), var(--accent-pink))' }}>
                    {agent.name[0]}
                  </div>
                  <div className="flex-1">
                    <p className="font-orbitron font-bold text-foreground">{agent.name}</p>
                    <p className="text-xs text-muted-foreground">{agent.domain}</p>
                  </div>
                  <span className={`text-xs font-medium ${agent.status === 'active' ? 'text-accent-emerald' : 'text-yellow-500'}`}>
                    {agent.status === 'active' ? '🟢 Actif' : '🟠 En configuration'}
                  </span>
                </div>

                {/* Stats */}
                <div className="grid grid-cols-4 gap-3 mb-4">
                  {[
                    { label: 'Total', value: agent.totalConv },
                    { label: 'Ce mois', value: agent.monthConv },
                    { label: 'Satisfaction', value: agent.rating ? `${agent.rating}/5` : '-' },
                    { label: 'Temps rép.', value: agent.responseTime },
                  ].map(s => (
                    <div key={s.label} className="text-center">
                      <p className="text-sm font-semibold text-foreground">{s.value}</p>
                      <p className="text-[10px] text-muted-foreground">{s.label}</p>
                    </div>
                  ))}
                </div>

                {/* Skills */}
                <div className="flex flex-wrap gap-1.5 mb-4">
                  {agent.skills.slice(0, 4).map(s => (
                    <span key={s} className="px-2 py-0.5 rounded text-[11px] bg-accent-purple/10 text-accent-purple border border-accent-purple/20">{s}</span>
                  ))}
                  {agent.skills.length > 4 && <span className="px-2 py-0.5 rounded text-[11px] text-muted-foreground">+{agent.skills.length - 4} autres</span>}
                </div>

                {/* Actions */}
                <div className="flex flex-wrap gap-2 mb-3">
                  <button className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs bg-secondary/50 text-foreground/80 hover:bg-secondary transition-colors"><MessageSquare className="w-3 h-3" /> Conversations</button>
                  <button className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs bg-secondary/50 text-foreground/80 hover:bg-secondary transition-colors"><BarChart3 className="w-3 h-3" /> Analytics</button>
                  <button className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs bg-secondary/50 text-foreground/80 hover:bg-secondary transition-colors"><Pencil className="w-3 h-3" /> Modifier</button>
                  <button className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs bg-secondary/50 text-foreground/80 hover:bg-secondary transition-colors"><TestTube className="w-3 h-3" /> Tester</button>
                </div>

                {/* Footer */}
                <div className="flex justify-between items-center text-[11px] text-muted-foreground pt-3 border-t border-border/50">
                  <span>Créé le {agent.created}</span>
                  <span>Dernière activité : {agent.lastActive}</span>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
