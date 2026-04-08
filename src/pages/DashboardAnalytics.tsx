import { Card, CardContent } from '@/components/ui/card';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { useMemo, useState } from 'react';
import { Loader2, BarChart3 } from 'lucide-react';
import { useAgents } from '@/hooks/useAgents';
import { useAgentDailySeries, useAgentStats } from '@/hooks/useAgentStats';

const COLORS = ['#00f0ff', '#7c3aed', '#f472b6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444'];

export default function DashboardAnalytics() {
  const [period, setPeriod] = useState<7 | 30 | 90>(30);

  const { data: agents = [] } = useAgents();
  const { statsByAgent, isLoading: statsLoading } = useAgentStats();
  const { series, isLoading: seriesLoading } = useAgentDailySeries(period);

  const isLoading = statsLoading || seriesLoading;

  // Top agents by total executions
  const topAgents = useMemo(() => {
    return agents
      .map((a) => ({
        name: a.name,
        conversations: statsByAgent.get(a.id)?.total ?? 0,
      }))
      .filter((a) => a.conversations > 0)
      .sort((a, b) => b.conversations - a.conversations)
      .slice(0, 5);
  }, [agents, statsByAgent]);

  // Domain (category) repartition
  const domainData = useMemo(() => {
    const totals = new Map<string, number>();
    agents.forEach((a) => {
      const count = statsByAgent.get(a.id)?.total ?? 0;
      if (count > 0) {
        totals.set(a.category, (totals.get(a.category) ?? 0) + count);
      }
    });
    const arr = Array.from(totals.entries()).map(([name, value], i) => ({
      name,
      value,
      color: COLORS[i % COLORS.length],
    }));
    return arr;
  }, [agents, statsByAgent]);

  const totalThisPeriod = series.reduce((s, d) => s + d.value, 0);

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-orbitron font-bold text-foreground">Analytics</h1>
          <p className="text-muted-foreground text-sm">Vue globale de vos performances</p>
        </div>
        <div className="flex gap-2">
          {[
            { label: '7j', value: 7 as const },
            { label: '30j', value: 30 as const },
            { label: '90j', value: 90 as const },
          ].map((p) => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                period === p.value
                  ? 'bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30'
                  : 'bg-secondary/50 text-muted-foreground hover:text-foreground'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading && (
        <div className="flex justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      )}

      {!isLoading && totalThisPeriod === 0 && topAgents.length === 0 && (
        <Card className="bg-card border-border">
          <CardContent className="p-10 text-center">
            <BarChart3 className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="font-orbitron font-bold text-foreground mb-2">
              Aucune donnée pour le moment
            </h3>
            <p className="text-sm text-muted-foreground">
              Vos statistiques apparaîtront dès que vous commencerez à utiliser vos agents.
            </p>
          </CardContent>
        </Card>
      )}

      {!isLoading && (totalThisPeriod > 0 || topAgents.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Conversations time series */}
          <Card className="bg-card border-border">
            <CardContent className="p-5">
              <div className="flex items-baseline justify-between mb-4">
                <h3 className="font-orbitron font-semibold text-foreground text-sm">
                  Exécutions par jour
                </h3>
                <span className="text-xs text-muted-foreground">
                  {totalThisPeriod} sur {period}j
                </span>
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={series}>
                  <XAxis dataKey="day" stroke="var(--muted-foreground)" fontSize={10} />
                  <YAxis stroke="var(--muted-foreground)" fontSize={10} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--card)',
                      border: '1px solid var(--border)',
                      borderRadius: '8px',
                      fontSize: '12px',
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="value"
                    stroke="var(--accent-cyan)"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Total counter */}
          <Card className="bg-card border-border">
            <CardContent className="p-5 flex flex-col items-center justify-center min-h-[260px]">
              <h3 className="font-orbitron font-semibold text-foreground text-sm mb-6">
                Total exécutions ({period}j)
              </h3>
              <div className="text-6xl font-orbitron font-bold text-foreground">
                {totalThisPeriod}
              </div>
              <p className="text-xs text-muted-foreground mt-3">
                {topAgents.length} agent{topAgents.length > 1 ? 's' : ''} actif
                {topAgents.length > 1 ? 's' : ''}
              </p>
            </CardContent>
          </Card>

          {/* Top agents */}
          {topAgents.length > 0 && (
            <Card className="bg-card border-border">
              <CardContent className="p-5">
                <h3 className="font-orbitron font-semibold text-foreground text-sm mb-4">
                  Top agents
                </h3>
                <ResponsiveContainer width="100%" height={Math.max(150, topAgents.length * 40)}>
                  <BarChart data={topAgents} layout="vertical">
                    <XAxis
                      type="number"
                      stroke="var(--muted-foreground)"
                      fontSize={10}
                      allowDecimals={false}
                    />
                    <YAxis
                      type="category"
                      dataKey="name"
                      stroke="var(--muted-foreground)"
                      fontSize={11}
                      width={100}
                    />
                    <Tooltip
                      contentStyle={{
                        background: 'var(--card)',
                        border: '1px solid var(--border)',
                        borderRadius: '8px',
                        fontSize: '12px',
                      }}
                    />
                    <Bar
                      dataKey="conversations"
                      fill="var(--accent-purple)"
                      radius={[0, 4, 4, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}

          {/* Domain repartition */}
          {domainData.length > 0 && (
            <Card className="bg-card border-border">
              <CardContent className="p-5">
                <h3 className="font-orbitron font-semibold text-foreground text-sm mb-4">
                  Répartition par catégorie
                </h3>
                <ResponsiveContainer width="100%" height={150}>
                  <PieChart>
                    <Pie
                      data={domainData}
                      cx="50%"
                      cy="50%"
                      innerRadius={40}
                      outerRadius={65}
                      dataKey="value"
                    >
                      {domainData.map((entry) => (
                        <Cell key={entry.name} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        background: 'var(--card)',
                        border: '1px solid var(--border)',
                        borderRadius: '8px',
                        fontSize: '12px',
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex flex-wrap gap-3 justify-center mt-2">
                  {domainData.map((d) => (
                    <span
                      key={d.name}
                      className="flex items-center gap-1.5 text-xs text-muted-foreground capitalize"
                    >
                      <span
                        className="w-2.5 h-2.5 rounded-full"
                        style={{ backgroundColor: d.color }}
                      />
                      {d.name} ({d.value})
                    </span>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
