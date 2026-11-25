import { useEffect, useLayoutEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Loader2, Users, TrendingUp, DollarSign, Award } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { useRequestScope, useScopedState } from '@/hooks/useRequestScope';
import { createRequestScope } from '@/lib/request-scope';
import { PartnerAffiliationAdmissions } from '@/components/partner/PartnerAffiliationAdmissions';
import {
  listActivePartners, listCommissions,
  formatEUR, PARTNER_LEVELS,
  type PartnerActive, type PartnerCommission,
} from '@/lib/partner';

export default function PartnerAgentPartners() {
  const { user } = useAuth();
  const userId = user?.id;
  const ownerKey = userId ?? '';
  const captureOwner = useRequestScope(ownerKey);
  const [partners, setPartners] = useScopedState<PartnerActive[]>(ownerKey, []);
  const [commissions, setCommissions] = useScopedState<PartnerCommission[]>(ownerKey, []);
  const [loading, setLoading] = useScopedState(ownerKey, true);
  const [loadError, setLoadError] = useScopedState(ownerKey, false);
  const [requests] = useState(createRequestScope);

  useLayoutEffect(() => {
    setLoading(Boolean(ownerKey));
    setLoadError(false);
    setPartners([]);
    setCommissions([]);
    return () => requests.invalidate();
  }, [ownerKey, requests, setLoading, setLoadError, setPartners, setCommissions]);

  const refresh = async () => {
    if (!userId) return;
    const isCurrent = captureOwner();
    const request = requests.begin('load');
    if (!request) return;
    setLoading(true);
    setLoadError(false);
    try {
      const [p, c] = await Promise.all([
        listActivePartners(userId),
        listCommissions(userId),
      ]);
      if (!isCurrent() || !request.current()) return;
      if (p.some(row => row.user_id !== userId) || c.some(row => row.user_id !== userId)) {
        throw new Error('Compte de chargement incohérent');
      }
      setPartners(p);
      setCommissions(c);
    } catch {
      if (isCurrent() && request.current()) setLoadError(true);
    } finally {
      if (request.finish() && isCurrent()) setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  if (!user) return <p className="py-12 text-center text-muted-foreground">Connectez-vous pour retrouver vos partenaires.</p>;

  const pendingCommissions = commissions.filter(c => c.status === 'pending');

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}>
        <Link to="/dashboard/partner-agent" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-1">
          <ArrowLeft className="w-3 h-3" /> Retour
        </Link>
        <h1 className="text-2xl font-orbitron font-bold text-foreground flex items-center gap-2">
          <Users className="w-6 h-6 text-accent-cyan" /> Partenaires et commissions
        </h1>
      </motion.div>

      <PartnerAffiliationAdmissions ownerId={ownerKey} />

      {loading && <div className="flex justify-center py-20"><Loader2 aria-label="Chargement des partenaires" className="w-8 h-8 animate-spin text-accent-cyan" /></div>}
      {!loading && loadError && <div role="alert" className="space-y-4 py-12 text-center">
        <p>Impossible de charger les partenaires et commissions. Aucun montant ne peut être confirmé.</p>
        <Button onClick={() => void refresh()}>Réessayer le chargement</Button>
      </div>}
      {!loading && !loadError && <>
      {partners.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            Aucun partenaire référencé. Les contrats signés restent suivis dans Prospects ; un dossier de raccordement ne confirme ni activation ni versement.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {partners.map(p => {
            const legacyProgram = p.outreach_profile === 'legacy';
            const lvl = PARTNER_LEVELS[p.level] ?? PARTNER_LEVELS.starter;
            const nextLvl = legacyProgram ? nextLevelInfo(p.total_conversions) : null;
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
                        {legacyProgram ? <Badge className="text-[10px]">{lvl.emoji} {lvl.label}</Badge>
                          : <Badge className="text-[10px]" variant="secondary">{p.outreach_profile === 'media_affiliate' ? 'Convention médias' : 'Programme à rapprocher'}</Badge>}
                        {!p.is_active && <Badge className="text-[10px]" variant="secondary">Inactif</Badge>}
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
                          <p className="text-[10px] text-muted-foreground mb-1">Programme historique : avantages soumis aux conditions du contrat.</p>
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
                      {!legacyProgram && <p className="text-[10px] text-muted-foreground mt-3">
                        Les commissions et avantages applicables sont ceux de la convention du partenaire.
                        Aucun bonus du programme historique n’est déduit des conversions.
                      </p>}

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
      </>}
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
