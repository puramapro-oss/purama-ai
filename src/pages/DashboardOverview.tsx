import { motion } from 'framer-motion';
import { Brain, MessageSquare, Globe, Zap, ArrowRight, Activity, Clock } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

const statCards = [
  { icon: Brain, label: 'Agents IA actifs', value: '3/5', progress: 60, color: 'text-accent-purple', bgColor: 'bg-accent-purple/10' },
  { icon: MessageSquare, label: 'Conversations ce mois', value: '1 247/2 000', progress: 62, color: 'text-accent-cyan', bgColor: 'bg-accent-cyan/10' },
  { icon: Globe, label: 'Sites en ligne', value: '2', progress: null, color: 'text-accent-blue', bgColor: 'bg-accent-blue/10' },
  { icon: Zap, label: 'Crédits restants', value: '18/30', progress: 60, color: 'text-accent-emerald', bgColor: 'bg-accent-emerald/10' },
];

const mockAgents = [
  { name: 'ShopAssist', domain: '🛍️ E-Commerce', status: 'active', conversations: 342, rating: 4.8, growth: '+12%' },
  { name: 'LegalBot', domain: '⚖️ Juridique', status: 'active', conversations: 156, rating: 4.6, growth: '+8%' },
  { name: 'SupportPro', domain: '🎧 Support', status: 'config', conversations: 0, rating: 0, growth: '-' },
];

const recentActivity = [
  { icon: '🧠', text: 'ShopAssist a géré 23 conversations aujourd\'hui', time: 'il y a 2h' },
  { icon: '📈', text: 'Origin Analytics a généré ton rapport hebdomadaire', time: 'il y a 5h' },
  { icon: '🛡️', text: 'Origin Security a effectué un scan — tout est OK ✅', time: 'hier' },
  { icon: '🎨', text: 'Origin Designer a optimisé le responsive de ton site', time: 'hier' },
  { icon: '💬', text: 'Nouveau message dans la conversation #1247', time: 'il y a 1 jour' },
];

const chartData = Array.from({ length: 7 }, (_, i) => ({
  day: ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'][i],
  conversations: Math.floor(Math.random() * 60) + 120,
  satisfaction: Math.floor(Math.random() * 10) + 88,
  responseTime: Math.floor(Math.random() * 3) + 2,
}));

export default function DashboardOverview() {
  const { user } = useAuth();
  const { data: profile } = useProfile();
  const firstName = profile?.full_name?.split(' ')[0] || 'Utilisateur';

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <motion.h1 initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="text-2xl sm:text-3xl font-orbitron font-bold text-foreground">
            Bonjour, {firstName} 👋
          </motion.h1>
          <p className="text-muted-foreground text-sm">{new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
        </div>
        <Link to="/dashboard" className="btn-primary flex items-center gap-2 text-sm px-4 py-2.5">
          <Zap className="w-4 h-4" /> Créer un Agent IA
        </Link>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {statCards.map((card, i) => (
          <motion.div key={i} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.1 }}>
            <Card className="bg-card border-border">
              <CardContent className="p-5">
                <div className="flex items-center gap-3 mb-3">
                  <div className={`w-10 h-10 rounded-lg ${card.bgColor} flex items-center justify-center`}>
                    <card.icon className={`w-5 h-5 ${card.color}`} />
                  </div>
                  <p className="text-sm text-muted-foreground">{card.label}</p>
                </div>
                <p className="text-2xl font-orbitron font-bold text-foreground">{card.value}</p>
                {card.progress !== null && <Progress value={card.progress} className="mt-2 h-1.5" />}
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* Agents preview */}
      <div>
        <div className="flex justify-between items-center mb-4">
          <h2 className="font-orbitron font-bold text-lg text-foreground">Mes Agents IA</h2>
          <Link to="/dashboard/agents" className="text-accent-cyan text-sm font-semibold hover:underline flex items-center gap-1">Voir tout <ArrowRight className="w-3 h-3" /></Link>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {mockAgents.map((agent, i) => (
            <motion.div key={i} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 + i * 0.1 }}>
              <Card className="bg-card border-border hover:border-accent-cyan/30 transition-all cursor-pointer">
                <CardContent className="p-5">
                  <div className="flex items-center gap-3 mb-3">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center text-lg ${agent.status === 'active' ? 'ring-2 ring-accent-emerald' : 'ring-2 ring-yellow-500'}`} style={{ background: 'linear-gradient(135deg, var(--accent-purple), var(--accent-pink))' }}>
                      {agent.name[0]}
                    </div>
                    <div>
                      <p className="font-semibold text-foreground text-sm">{agent.name}</p>
                      <p className="text-xs text-muted-foreground">{agent.domain}</p>
                    </div>
                    <span className={`ml-auto text-xs font-medium ${agent.status === 'active' ? 'text-accent-emerald' : 'text-yellow-500'}`}>
                      {agent.status === 'active' ? '🟢 Actif' : '🟠 Config'}
                    </span>
                  </div>
                  {agent.status === 'active' && (
                    <div className="flex gap-4 text-xs text-muted-foreground">
                      <span>💬 {agent.conversations}</span>
                      <span>⭐ {agent.rating}/5</span>
                      <span>📈 {agent.growth}</span>
                    </div>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      </div>

      {/* Activity + Chart */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Activity */}
        <Card className="bg-card border-border">
          <CardContent className="p-5">
            <h3 className="font-orbitron font-bold text-foreground mb-4">Activité récente</h3>
            <div className="space-y-3">
              {recentActivity.map((item, i) => (
                <div key={i} className="flex items-start gap-3">
                  <span className="text-lg">{item.icon}</span>
                  <div className="flex-1">
                    <p className="text-sm text-foreground/80">{item.text}</p>
                    <p className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" /> {item.time}</p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Performance Chart */}
        <Card className="bg-card border-border">
          <CardContent className="p-5">
            <h3 className="font-orbitron font-bold text-foreground mb-4">Performance (7 derniers jours)</h3>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={chartData}>
                <XAxis dataKey="day" stroke="var(--muted-foreground)" fontSize={12} />
                <YAxis stroke="var(--muted-foreground)" fontSize={12} />
                <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '12px' }} />
                <Line type="monotone" dataKey="conversations" stroke="var(--accent-cyan)" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="satisfaction" stroke="var(--accent-emerald)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
