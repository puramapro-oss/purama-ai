import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { 
  AreaChart, 
  Area, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  BarChart,
  Bar,
  Legend
} from 'recharts';
import { format, parseISO, startOfMonth, subMonths } from 'date-fns';
import { fr } from 'date-fns/locale';
import type { Commission } from '@/hooks/useInfluencer';

interface PerformanceChartsProps {
  commissions: Commission[];
}

export function PerformanceCharts({ commissions }: PerformanceChartsProps) {
  const chartData = useMemo(() => {
    // Generate last 6 months
    const months: Date[] = [];
    for (let i = 5; i >= 0; i--) {
      months.push(startOfMonth(subMonths(new Date(), i)));
    }

    // Group commissions by month
    const dataByMonth = months.map(monthDate => {
      const monthKey = format(monthDate, 'yyyy-MM');
      const monthCommissions = commissions.filter(c => {
        const commissionMonth = format(parseISO(c.created_at), 'yyyy-MM');
        return commissionMonth === monthKey;
      });

      const revenue = monthCommissions.reduce((sum, c) => sum + Number(c.commission_amount), 0);
      const sales = monthCommissions.length;
      const pending = monthCommissions.filter(c => c.status === 'pending' || c.status === 'validated')
        .reduce((sum, c) => sum + Number(c.commission_amount), 0);
      const paid = monthCommissions.filter(c => c.status === 'paid')
        .reduce((sum, c) => sum + Number(c.commission_amount), 0);

      return {
        month: format(monthDate, 'MMM', { locale: fr }),
        fullMonth: format(monthDate, 'MMMM yyyy', { locale: fr }),
        revenue,
        sales,
        pending,
        paid,
      };
    });

    return dataByMonth;
  }, [commissions]);

  const hasData = commissions.length > 0;

  type TooltipEntry = { color?: string; name?: string; value?: number; dataKey?: string; payload?: { fullMonth?: string } };
  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: TooltipEntry[] }) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-background/95 backdrop-blur-sm border border-border rounded-lg p-3 shadow-lg">
          <p className="font-medium text-foreground capitalize mb-2">{payload[0]?.payload?.fullMonth}</p>
          {payload.map((entry: TooltipEntry, index: number) => (
            <p key={index} className="text-sm" style={{ color: entry.color }}>
              {entry.name}: {(entry.name?.includes('€') || entry.dataKey?.includes('revenue') || entry.dataKey?.includes('pending') || entry.dataKey?.includes('paid'))
                ? `${entry.value?.toFixed(2)}€`
                : entry.value}
            </p>
          ))}
        </div>
      );
    }
    return null;
  };

  return (
    <div className="grid gap-6 md:grid-cols-2 mb-8">
      {/* Revenue Chart */}
      <Card className="glass-effect">
        <CardHeader>
          <CardTitle className="text-base font-medium">Évolution des revenus</CardTitle>
        </CardHeader>
        <CardContent>
          {hasData ? (
            <ResponsiveContainer width="100%" height={250}>
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                <XAxis 
                  dataKey="month" 
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis 
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value) => `${value}€`}
                />
                <Tooltip content={<CustomTooltip />} />
                <Area
                  type="monotone"
                  dataKey="revenue"
                  name="Revenus"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#colorRevenue)"
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[250px] flex items-center justify-center text-muted-foreground">
              <p className="text-sm">Aucune donnée disponible</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Sales & Status Chart */}
      <Card className="glass-effect">
        <CardHeader>
          <CardTitle className="text-base font-medium">Ventes par mois</CardTitle>
        </CardHeader>
        <CardContent>
          {hasData ? (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                <XAxis 
                  dataKey="month" 
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis 
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip content={<CustomTooltip />} />
                <Legend 
                  wrapperStyle={{ fontSize: '12px' }}
                  iconType="circle"
                  iconSize={8}
                />
                <Bar 
                  dataKey="paid" 
                  name="Payé" 
                  stackId="a"
                  fill="hsl(142 76% 36%)" 
                  radius={[0, 0, 0, 0]}
                />
                <Bar 
                  dataKey="pending" 
                  name="En attente" 
                  stackId="a"
                  fill="hsl(38 92% 50%)" 
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[250px] flex items-center justify-center text-muted-foreground">
              <p className="text-sm">Aucune donnée disponible</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
