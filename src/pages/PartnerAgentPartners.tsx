import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Loader2, Users, TrendingUp, DollarSign, Award } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import {
  listActivePartners, listCommissions,
  formatEUR, PARTNER_LEVELS,
  type PartnerActive, type PartnerCommission,
} from '@/lib/partner';

export default function PartnerAgentPartners() {
  const { user } = useAuth();
  const [partners, setPartners] = useState<PartnerActive[]>([]);
  const [commissions, setCommissions] = useState<PartnerCommission[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const [p, c] = await Promise.all([
          listActivePartners(user.id),
          listCommissions(user.id),
        ]);
        setPartners(p);
        setCommissions(c);
      } catch (e) {
        toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
      } finally {
        setLoading(false);
      }
    })();
  }, [user?.id]);

  if (loading) {
    return <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-accent-cyan" /></div>;
  }

  const pendingCommissions = commissions.filter(c => c.status === 'pending');

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}>
        <Link to="/dashboard/partner-agent" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-1">
          <ArrowLeft className="w-3 h-3" /> Retour
        </Link>
        <h1 className="text-2xl font-orbitron font-bold text-foreground flex items-center gap-2">
          <Users className="w-6 h-6 text-accent-cyan" /> Partenaires actifs
        </h1>
      </motion.div>

      {partners.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            Aucun partenaire actif. Dès qu'un prospect signe un contrat, il apparaîtra ici avec son code de parrainage.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {partners.map(p => {
            const lvl = PARTNER_LEVELS[p.level];
            const nextLvl = nextLevelInfo(p.total_conversions);
            return (
              <Card key={p.id} className="bg-card border-border">
                <CardContent className="p-5">
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 rounded-full bg-gradient-to-br from-accent-purple to-accent-cyan flex items-center justify-center text-lg font-bold text-foreground flex-shrink-0">
                      {p.partner_name[0]?.toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-semibold text-foreground">{p.partner_name}</p>
                        <Badge className="text-[10px]">{lvl.emoji} {lvl.label}</Badge>
                      </div>
                      <p className="text-[11px] text-muted-foreground">{p.partner_email}</p>
                      <code className="text-[10px] text-accent-cyan mt-1 block">{p.referral_link}</code>

                      {/* Stats grid */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
                        <Stat icon={TrendingUp} label="Clics" value={p.total_clicks.toString()} />
                        <Stat icon={Users} label="Inscrits" value={p.total_signups.toString()} />
                        <Stat icon={Award} label="Conversions" value={p.total_conversions.toString()} />
                        <Stat icon={DollarSign} label="CA généré" value={formatEUR(p.total_revenue_generated)} />
                      </div>

                      {/* Progression next level */}
                      {nextLvl && (
                        <div className="mt-3">
                          <div className="flex items-center justify-between mb-1">
                            <p className="text-[10px] text-muted-foreground">Vers {nextLvl.label} ({nextLvl.emoji} {nextLvl.reward})</p>
                            <p className="text-[10px] text-foreground">{p.total_conversions}/{nextLvl.min}</p>
                          </div>
                          <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                            <div
                              className="h-full bg-gradient-to-r from-accent-purple to-accent-cyan"
                              style={{ width: `${Math.min(100, (p.total_conversions / nextLvl.min) * 100)}%` }}
                            />
                          </div>
                        </div>
                      )}

                      <div className="flex items-center gap-3 mt-3 text-[11px]">
                        <span className="text-emerald-400">{formatEUR(p.total_commission_earned)} gagné</span>
                        <span className="text-muted-foreground">·</span>
                        <span className="text-yellow-400">{formatEUR(p.total_commission_earned - p.total_commission_paid)} en attente</span>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {pendingCommissions.length > 0 && (
        <Card className="border-yellow-500/30 bg-yellow-500/5">
          <CardContent className="p-5">
            <h2 className="font-semibold text-foreground flex items-center gap-2 mb-3">
              <DollarSign className="w-5 h-5 text-yellow-400" /> Commissions à payer
            </h2>
            <div className="space-y-2">
              {pendingCommissions.map(c => (
                <div key={c.id} className="flex items-center justify-between p-3 rounded-lg bg-card border border-border">
                  <div>
                    <p className="text-sm font-medium text-foreground">{c.source_customer_email}</p>
                    <p className="text-[11px] text-muted-foreground">{c.type} · {c.percentage}% · {new Date(c.created_at).toLocaleDateString('fr-FR')}</p>
                  </div>
                  <p className="text-sm font-orbitron font-bold text-yellow-400">{formatEUR(c.amount)}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stat({ icon: Icon, label, value }: { icon: typeof Users; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 p-2 rounded-lg bg-secondary/30 border border-border">
      <Icon className="w-3 h-3 text-accent-cyan" />
      <div>
        <p className="text-[9px] text-muted-foreground">{label}</p>
        <p className="text-xs font-semibold text-foreground">{value}</p>
      </div>
    </div>
  );
}

function nextLevelInfo(conversions: number) {
  const levels = [
    { label: 'Argent', min: 50, emoji: '🥈', reward: 'Mug + bonus 5%' },
    { label: 'Or', min: 150, emoji: '🥇', reward: 'Sweat + bonus 10%' },
    { label: 'Platine', min: 250, emoji: '💎', reward: 'AirPods + 1% equity' },
    { label: 'Diamant', min: 500, emoji: '🔷', reward: 'iPad + 5% equity' },
    { label: 'Titan', min: 1000, emoji: '🚗', reward: 'Tesla' },
    { label: 'Éternel', min: 5000, emoji: '♾️', reward: '1% Purama à vie' },
  ];
  return levels.find(l => conversions < l.min) ?? null;
}
