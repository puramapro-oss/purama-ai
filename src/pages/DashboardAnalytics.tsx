import { motion } from 'framer-motion';
import { Card, CardContent } from '@/components/ui/card';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell } from 'recharts';
import { useState } from 'react';

const conversationsData = Array.from({ length: 30 }, (_, i) => ({ day: i + 1, value: Math.floor(Math.random() * 80) + 40 }));
const topAgents = [
  { name: 'ShopAssist', conversations: 342 },
  { name: 'LegalBot', conversations: 156 },
  { name: 'SupportPro', conversations: 89 },
];
const domainData = [
  { name: 'E-commerce', value: 40, color: '#00f0ff' },
  { name: 'Support', value: 30, color: '#7c3aed' },
  { name: 'Juridique', value: 20, color: '#f472b6' },
  { name: 'Autre', value: 10, color: '#3b82f6' },
];

export default function DashboardAnalytics() {
  const [period, setPeriod] = useState('30j');

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-orbitron font-bold text-foreground">Analytics</h1>
          <p className="text-muted-foreground text-sm">Vue globale de vos performances</p>
        </div>
        <div className="flex gap-2">
          {['7j', '30j', '90j'].map(p => (
            <button key={p} onClick={() => setPeriod(p)} className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${period === p ? 'bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30' : 'bg-secondary/50 text-muted-foreground hover:text-foreground'}`}>{p}</button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Conversations */}
        <Card className="bg-card border-border">
          <CardContent className="p-5">
            <h3 className="font-orbitron font-semibold text-foreground text-sm mb-4">Conversations par jour</h3>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={conversationsData}>
                <XAxis dataKey="day" stroke="var(--muted-foreground)" fontSize={10} />
                <YAxis stroke="var(--muted-foreground)" fontSize={10} />
                <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '12px' }} />
                <Line type="monotone" dataKey="value" stroke="var(--accent-cyan)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Satisfaction gauge */}
        <Card className="bg-card border-border">
          <CardContent className="p-5 flex flex-col items-center justify-center">
            <h3 className="font-orbitron font-semibold text-foreground text-sm mb-6">Satisfaction moyenne</h3>
            <div className="relative w-32 h-32">
              <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
                <circle cx="18" cy="18" r="15.9" fill="none" stroke="var(--secondary)" strokeWidth="3" />
                <circle cx="18" cy="18" r="15.9" fill="none" stroke="var(--accent-emerald)" strokeWidth="3" strokeDasharray={`${94 * 100 / 100}, 100`} strokeLinecap="round" />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-3xl font-orbitron font-bold text-foreground">94%</span>
              </div>
            </div>
            <p className="text-xs text-accent-emerald mt-3">+2% vs mois précédent</p>
          </CardContent>
        </Card>

        {/* Top agents */}
        <Card className="bg-card border-border">
          <CardContent className="p-5">
            <h3 className="font-orbitron font-semibold text-foreground text-sm mb-4">Top agents</h3>
            <ResponsiveContainer width="100%" height={150}>
              <BarChart data={topAgents} layout="vertical">
                <XAxis type="number" stroke="var(--muted-foreground)" fontSize={10} />
                <YAxis type="category" dataKey="name" stroke="var(--muted-foreground)" fontSize={11} width={80} />
                <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '12px' }} />
                <Bar dataKey="conversations" fill="var(--accent-purple)" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Domain repartition */}
        <Card className="bg-card border-border">
          <CardContent className="p-5">
            <h3 className="font-orbitron font-semibold text-foreground text-sm mb-4">Répartition par domaine</h3>
            <ResponsiveContainer width="100%" height={150}>
              <PieChart>
                <Pie data={domainData} cx="50%" cy="50%" innerRadius={40} outerRadius={65} dataKey="value">
                  {domainData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                </Pie>
                <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '12px' }} />
              </PieChart>
            </ResponsiveContainer>
            <div className="flex flex-wrap gap-3 justify-center mt-2">
              {domainData.map(d => (
                <span key={d.name} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: d.color }} /> {d.name}
                </span>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
