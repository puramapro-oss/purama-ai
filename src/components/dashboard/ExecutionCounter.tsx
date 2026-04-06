import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Zap, Sparkles } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import {
  getUsageSnapshot, colorForPercent, textColorForPercent, formatExecutions,
  type UsageSnapshot,
} from '@/lib/usage';

interface Props {
  /**
   * Compact = sidebar (small footprint).
   * Wide = dashboard card.
   */
  variant?: 'compact' | 'wide';
}

export function ExecutionCounter({ variant = 'compact' }: Props) {
  const { user } = useAuth();
  const [snap, setSnap] = useState<UsageSnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    (async () => {
      try {
        const s = await getUsageSnapshot(user.id);
        if (alive) setSnap(s);
      } catch (e) {
        console.warn('[ExecutionCounter]', e);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    // Refresh every 60s
    const t = setInterval(async () => {
      if (!user) return;
      try {
        const s = await getUsageSnapshot(user.id);
        if (alive) setSnap(s);
      } catch { /* silent */ }
    }, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [user?.id]);

  if (loading || !snap) {
    if (variant === 'compact') {
      return (
        <div className="px-3 py-2.5 rounded-lg bg-secondary/30 border border-border animate-pulse">
          <div className="h-2 bg-muted rounded mb-2" />
          <div className="h-1 bg-muted rounded" />
        </div>
      );
    }
    return null;
  }

  const barColor = colorForPercent(snap.percent);
  const textColor = textColorForPercent(snap.percent);

  if (variant === 'compact') {
    return (
      <Link to="/dashboard/billing" className="block group">
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="px-3 py-2.5 rounded-lg bg-secondary/30 border border-border hover:border-accent-cyan/30 transition-colors"
        >
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-1.5">
              <Zap className={`w-3 h-3 ${textColor}`} />
              <span className="text-[10px] font-semibold text-foreground">
                {formatExecutions(snap.used)}
                <span className="text-muted-foreground font-normal"> / {formatExecutions(snap.limit)}</span>
              </span>
            </div>
            <span className="text-[9px] text-muted-foreground">{snap.plan.name}</span>
          </div>
          <div className="h-1 bg-secondary rounded-full overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${snap.percent}%` }}
              transition={{ duration: 0.8, ease: 'easeOut' }}
              className={`h-full bg-gradient-to-r ${barColor} rounded-full`}
            />
          </div>
          <p className="text-[9px] text-muted-foreground/70 mt-1">
            Reset dans {snap.days_until_reset}j
          </p>
        </motion.div>
      </Link>
    );
  }

  // Wide variant for dashboard
  return (
    <Link to="/dashboard/billing">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-xl bg-card border border-border hover:border-accent-cyan/30 transition-colors p-5"
      >
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className={`w-9 h-9 rounded-xl bg-secondary/40 flex items-center justify-center`}>
              <Zap className={`w-4 h-4 ${textColor}`} />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Exécutions ce mois</p>
              <p className="text-sm font-semibold text-foreground">
                {snap.used.toLocaleString('fr-FR')} <span className="text-muted-foreground font-normal">/ {snap.limit.toLocaleString('fr-FR')}</span>
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className={`text-xl font-orbitron font-bold ${textColor}`}>{snap.percent}%</p>
            <p className="text-[10px] text-muted-foreground">Plan {snap.plan.name}</p>
          </div>
        </div>
        <div className="h-2 bg-secondary rounded-full overflow-hidden">
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: `${snap.percent}%` }}
            transition={{ duration: 1, ease: 'easeOut' }}
            className={`h-full bg-gradient-to-r ${barColor} rounded-full`}
          />
        </div>
        <div className="flex items-center justify-between mt-3 text-[11px] text-muted-foreground">
          <span>Reset le 1er du mois (dans {snap.days_until_reset}j)</span>
          {snap.percent >= 80 && (
            <span className="flex items-center gap-1 text-accent-purple">
              <Sparkles className="w-3 h-3" /> Upgrade ?
            </span>
          )}
        </div>
      </motion.div>
    </Link>
  );
}
