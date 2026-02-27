import { motion } from 'framer-motion';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { useState } from 'react';

const autoAgents = [
  { name: 'Origin Designer', emoji: '🎨', color: '#A855F7', desc: 'Optimise le design, responsive, couleurs, typographie', tasks: ['Ajustement contrastes', 'Optimisation mobile', 'Suggestions design', 'A/B testing'], stats: '47 optimisations ce mois', tier: 'pro' },
  { name: 'Origin Content', emoji: '📝', color: '#3B82F6', desc: 'Génère et optimise le contenu SEO, descriptions, articles', tasks: ['Rédaction pages', 'SEO', 'Traduction auto', 'Blog'], stats: '23 articles générés', tier: 'pro' },
  { name: 'Origin Analytics', emoji: '📈', color: '#10B981', desc: 'Analyse performances, trafic, conversions, rapports', tasks: ['Dashboard analytics', 'Rapports hebdo', 'Alertes', 'Suggestions'], stats: '12 rapports générés', tier: 'pro' },
  { name: 'Origin Security', emoji: '🛡️', color: '#EF4444', desc: 'Sécurité, sauvegardes, surveillance menaces', tasks: ['Scans sécurité', 'Sauvegardes auto', 'SSL', 'Protection DDoS'], stats: '3 scans cette semaine', tier: 'business' },
  { name: 'Origin Marketing', emoji: '🚀', color: '#F59E0B', desc: 'Marketing automatisé, réseaux sociaux, emails', tasks: ['Posts sociaux', 'Email marketing', 'Campagnes pub', 'Landing pages'], stats: '156 posts planifiés', tier: 'business' },
  { name: 'Origin Support', emoji: '🤝', color: '#06B6D4', desc: 'Support client, FAQ, tickets, chat', tasks: ['Réponses auto', 'Tickets', 'FAQ dynamique', 'Satisfaction'], stats: '89 tickets résolus', tier: 'business' },
];

export default function DashboardAutoAgents() {
  const [activeAgents, setActiveAgents] = useState<Record<string, boolean>>({ 'Origin Designer': true, 'Origin Content': true, 'Origin Analytics': false });
  const userPlan = 'pro'; // This would come from subscription hook

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-orbitron font-bold text-foreground mb-2">Agents Automatiques Origin</h1>
        <p className="text-muted-foreground text-sm">6 agents qui travaillent 24/7 pour optimiser ton business</p>
        <span className="inline-block mt-2 px-3 py-1 rounded-full bg-accent-purple/10 text-accent-purple text-xs font-medium border border-accent-purple/20">
          Plan Pro : 3/6 agents disponibles
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
        {autoAgents.map((agent, i) => {
          const locked = agent.tier === 'business' && userPlan === 'pro';
          return (
            <motion.div key={i} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.1 }}>
              <Card className={`bg-card border-border relative overflow-hidden ${locked ? 'opacity-60' : ''}`}>
                {locked && (
                  <div className="absolute inset-0 bg-background/60 backdrop-blur-sm z-10 flex flex-col items-center justify-center">
                    <p className="text-sm font-semibold text-foreground">🔒 Disponible en Business</p>
                    <button className="btn-primary text-xs mt-2 px-3 py-1.5">Passer en Business</button>
                  </div>
                )}
                <CardContent className="p-5">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <motion.div animate={{ scale: [1, 1.05, 1] }} transition={{ duration: 2, repeat: Infinity }} className="w-11 h-11 rounded-xl flex items-center justify-center text-xl" style={{ backgroundColor: agent.color + '20', boxShadow: `0 0 15px ${agent.color}30` }}>
                        {agent.emoji}
                      </motion.div>
                      <div>
                        <p className="font-semibold text-foreground text-sm">{agent.name}</p>
                        <p className="text-xs text-muted-foreground">{agent.stats}</p>
                      </div>
                    </div>
                    {!locked && (
                      <Switch checked={activeAgents[agent.name] || false} onCheckedChange={v => setActiveAgents(prev => ({ ...prev, [agent.name]: v }))} />
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mb-3">{agent.desc}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {agent.tasks.map(task => (
                      <span key={task} className="px-2 py-1 rounded text-[11px] bg-secondary/50 text-foreground/70">{task}</span>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
