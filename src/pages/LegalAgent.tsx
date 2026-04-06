import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Scale, Power, Settings, FileText, Briefcase, AlertTriangle,
  MessageSquare, Loader2, ArrowRight, Sparkles, BookOpen, Bell,
  CalendarClock, DollarSign,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { TutorialOverlay, type TutorialStep } from '@/components/shared/TutorialOverlay';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import {
  getLegalConfig, updateLegalConfig,
  listDocuments, listCases, listImpayes, listVeille,
  formatEUR,
  type LegalConfig, type LegalDocument, type LegalCase,
  type LegalImpaye, type LegalVeille,
} from '@/lib/legal';

export default function LegalAgent() {
  const { user } = useAuth();
  const [config, setConfig] = useState<LegalConfig | null>(null);
  const [docs, setDocs] = useState<LegalDocument[]>([]);
  const [cases, setCases] = useState<LegalCase[]>([]);
  const [impayes, setImpayes] = useState<LegalImpaye[]>([]);
  const [veille, setVeille] = useState<LegalVeille[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingToggle, setSavingToggle] = useState(false);

  const refresh = async () => {
    if (!user) return;
    try {
      const [c, d, cs, i, v] = await Promise.all([
        getLegalConfig(user.id),
        listDocuments(user.id),
        listCases(user.id),
        listImpayes(user.id),
        listVeille(user.id, 10),
      ]);
      setConfig(c);
      setDocs(d);
      setCases(cs);
      setImpayes(i);
      setVeille(v);
    } catch (e) {
      toast.error('Erreur de chargement', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const handleToggle = async (next: boolean) => {
    if (!user || !config) return;
    setSavingToggle(true);
    try {
      const updated = await updateLegalConfig(user.id, { is_active: next });
      setConfig(updated);
      toast.success(next ? '⚖️ Agent juridique activé' : 'Agent en pause');
    } catch (e) {
      toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
    } finally { setSavingToggle(false); }
  };

  if (loading || !config) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="w-8 h-8 text-accent-cyan animate-spin" />
      </div>
    );
  }

  const openCases = cases.filter(c => c.status === 'open' || c.status === 'in_progress');
  const overdueImpayes = impayes.filter(i => !['paid', 'closed'].includes(i.status));
  const totalImpayes = overdueImpayes.reduce((s, i) => s + Number(i.amount), 0);
  const unreadVeille = veille.filter(v => !v.is_read);
  const urgentVeille = veille.filter(v => v.severity === 'urgent' || v.severity === 'action_required');

  const tutorialSteps: TutorialStep[] = [
    { selector: null, title: 'Bienvenue dans l\'Agent Juridique ⚖️', body: 'Ton avocat IA disponible 24/7. Droit français + européen + jurisprudence à jour. Génère contrats, monte des dossiers, surveille la veille juridique.' },
    { selector: null, title: 'Pose une question via le chat', body: 'Le chat IA cite les articles de loi exacts et la jurisprudence pertinente. Pose tes questions en langage naturel.' },
    { selector: null, title: 'Génère 30+ types de documents', body: 'CDI, CGV, statuts, mise en demeure, bail... L\'IA produit des documents complets et conformes en 15s.' },
    { selector: null, title: 'Monte un dossier complet', body: 'Décris des faits → l\'IA produit analyse, stratégie, jurisprudence, probabilité de succès, prescription.' },
    { selector: null, title: 'Veille juridique automatique', body: 'L\'agent surveille Légifrance / Cour de cassation chaque jour et t\'alerte sur les changements qui te concernent.' },
  ];

  return (
    <div className="space-y-8 max-w-5xl mx-auto pb-12">
      <TutorialOverlay storageKey="legal-agent" steps={tutorialSteps} />
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col sm:flex-row sm:items-center gap-4 sm:justify-between"
      >
        <div>
          <h1 className="text-2xl sm:text-3xl font-orbitron font-bold text-foreground flex items-center gap-3">
            <Scale className="w-7 h-7 text-accent-purple" />
            Agent Juridique
            {config.is_active ? (
              <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30">Actif</Badge>
            ) : (
              <Badge variant="secondary">En pause</Badge>
            )}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Ton avocat IA disponible 24/7 — droit français, européen, jurisprudence à jour.
          </p>
        </div>
        <div className="flex gap-2">
          <Link to="/dashboard/legal-agent/chat">
            <Button>
              <MessageSquare className="w-4 h-4 mr-2" /> Poser une question
            </Button>
          </Link>
        </div>
      </motion.div>

      {/* Toggle */}
      <Card className="bg-card border-border">
        <CardContent className="p-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-accent-purple/10 flex items-center justify-center">
              <Power className="w-6 h-6 text-accent-purple" />
            </div>
            <div>
              <p className="font-semibold text-foreground">Veille juridique 24/7</p>
              <p className="text-xs text-muted-foreground">
                Alertes lois, deadlines, prescriptions, documents à renouveler.
              </p>
            </div>
          </div>
          <Switch checked={config.is_active} onCheckedChange={handleToggle} disabled={savingToggle} />
        </CardContent>
      </Card>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'Documents', value: docs.length, icon: FileText, color: 'text-accent-cyan', bg: 'bg-accent-cyan/10' },
          { label: 'Dossiers ouverts', value: openCases.length, icon: Briefcase, color: 'text-accent-purple', bg: 'bg-accent-purple/10' },
          { label: 'Impayés', value: formatEUR(totalImpayes), icon: DollarSign, color: 'text-yellow-400', bg: 'bg-yellow-500/10' },
          { label: 'Alertes', value: unreadVeille.length, icon: Bell, color: 'text-red-400', bg: 'bg-red-500/10' },
        ].map((s, i) => (
          <motion.div key={s.label} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
            <Card className="bg-card border-border">
              <CardContent className="p-4">
                <div className={`w-9 h-9 rounded-xl ${s.bg} flex items-center justify-center mb-2`}>
                  <s.icon className={`w-4 h-4 ${s.color}`} />
                </div>
                <p className="text-xl font-orbitron font-bold text-foreground truncate">{s.value}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">{s.label}</p>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* Quick links */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <QuickLink to="/dashboard/legal-agent/chat" icon={MessageSquare} label="Chat IA" />
        <QuickLink to="/dashboard/legal-agent/documents" icon={FileText} label="Documents" />
        <QuickLink to="/dashboard/legal-agent/cases" icon={Briefcase} label="Dossiers" badge={openCases.length} badgeLabel="ouverts" />
        <QuickLink to="/dashboard/legal-agent/impayes" icon={DollarSign} label="Impayés" badge={overdueImpayes.length} badgeLabel="en retard" />
        <QuickLink to="/dashboard/legal-agent/veille" icon={Bell} label="Veille" badge={unreadVeille.length} badgeLabel="non lues" />
      </div>

      {/* Veille urgente */}
      {urgentVeille.length > 0 && (
        <Card className="border-red-500/30 bg-red-500/5">
          <CardContent className="p-5">
            <h2 className="font-semibold text-foreground flex items-center gap-2 mb-3">
              <AlertTriangle className="w-5 h-5 text-red-400" /> Alertes urgentes
            </h2>
            <div className="space-y-2">
              {urgentVeille.slice(0, 3).map(v => (
                <Link key={v.id} to="/dashboard/legal-agent/veille" className="block p-3 rounded-lg border border-border bg-card hover:bg-secondary/30">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge className="bg-red-500/15 text-red-400 border-red-500/30 text-[10px]">{v.severity}</Badge>
                    <p className="text-sm font-medium text-foreground">{v.title}</p>
                  </div>
                  {v.action_required && <p className="text-[11px] text-muted-foreground mt-1">{v.action_required}</p>}
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Documents récents */}
      <Card className="bg-card border-border">
        <CardContent className="p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-orbitron font-bold text-foreground flex items-center gap-2">
              <FileText className="w-5 h-5 text-accent-cyan" /> Documents récents
            </h2>
            <Link to="/dashboard/legal-agent/documents" className="text-xs text-accent-cyan hover:underline flex items-center gap-1">
              Tout voir <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          {docs.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              Aucun document. <Link to="/dashboard/legal-agent/documents" className="text-accent-cyan hover:underline">Génère ton premier document</Link>
            </div>
          ) : (
            <div className="space-y-2">
              {docs.slice(0, 5).map(d => (
                <Link
                  key={d.id}
                  to="/dashboard/legal-agent/documents"
                  className="flex items-center gap-3 p-3 rounded-lg border border-border bg-secondary/20 hover:bg-secondary/40 transition-colors"
                >
                  <div className="w-9 h-9 rounded-lg bg-accent-cyan/10 flex items-center justify-center flex-shrink-0">
                    <FileText className="w-4 h-4 text-accent-cyan" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{d.title}</p>
                    <p className="text-[11px] text-muted-foreground">{d.type} · {new Date(d.created_at).toLocaleDateString('fr-FR')}</p>
                  </div>
                  <Badge variant="outline" className="text-[10px]">{d.status}</Badge>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dossiers */}
      {openCases.length > 0 && (
        <Card className="bg-card border-border">
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-orbitron font-bold text-foreground flex items-center gap-2">
                <Briefcase className="w-5 h-5 text-accent-purple" /> Dossiers en cours
              </h2>
              <Link to="/dashboard/legal-agent/cases" className="text-xs text-accent-cyan hover:underline flex items-center gap-1">
                Tout voir <ArrowRight className="w-3 h-3" />
              </Link>
            </div>
            <div className="space-y-2">
              {openCases.slice(0, 4).map(c => (
                <Link
                  key={c.id}
                  to="/dashboard/legal-agent/cases"
                  className="flex items-center gap-3 p-3 rounded-lg border border-border bg-secondary/20 hover:bg-secondary/40"
                >
                  <Briefcase className="w-4 h-4 text-accent-purple flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{c.title}</p>
                    <p className="text-[11px] text-muted-foreground">{c.type} · {c.priority}</p>
                  </div>
                  {c.ai_success_probability !== null && (
                    <span className="text-xs text-accent-purple">{c.ai_success_probability}%</span>
                  )}
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function QuickLink({
  to, icon: Icon, label, badge, badgeLabel,
}: {
  to: string;
  icon: typeof Scale;
  label: string;
  badge?: number;
  badgeLabel?: string;
}) {
  return (
    <Link to={to}>
      <Card className="bg-card border-border hover:border-accent-purple/30 transition-all h-full">
        <CardContent className="p-4 flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-accent-purple/10 flex items-center justify-center flex-shrink-0">
            <Icon className="w-4 h-4 text-accent-purple" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">{label}</p>
            {badge !== undefined && badge > 0 && (
              <p className="text-[11px] text-yellow-400">{badge} {badgeLabel}</p>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
