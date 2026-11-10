import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Bot, CreditCard, RefreshCw, ShieldCheck, Users, CircleAlert, Wallet, History } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { SUPER_ADMIN_EMAIL, isSuperAdmin } from '@/lib/constants';
import { dashboardMetricLabel, loadFounderDashboard, type FounderDashboardSnapshot } from '@/lib/founder-dashboard';

type LoadState = {
  ownerId: string | null;
  snapshot: FounderDashboardSnapshot | null;
  pending: boolean;
  error: string | null;
};

const EMPTY: LoadState = { ownerId: null, snapshot: null, pending: false, error: null };

export default function AdminDashboard() {
  const { user, session, loading: authLoading } = useAuth();
  const [state, setState] = useState<LoadState>(EMPTY);
  const [refresh, setRefresh] = useState(0);
  const [automatic, setAutomatic] = useState(true);
  const ownerId = user?.id ?? null;
  const canView = Boolean(user?.email_confirmed_at && isSuperAdmin(user?.email));

  useEffect(() => {
    if (!canView || !ownerId) {
      setState(EMPTY);
      return;
    }
    const controller = new AbortController();
    let active = true;
    setState({ ownerId, snapshot: null, pending: true, error: null });
    loadFounderDashboard(
      (options) => supabase.functions.invoke('founder-dashboard', options),
      controller.signal,
    ).then((snapshot) => {
      if (active) setState({ ownerId, snapshot, pending: false, error: null });
    }).catch((error: unknown) => {
      if (active && !controller.signal.aborted) {
        setState({
          ownerId, snapshot: null, pending: false,
          error: error instanceof Error ? error.message : 'Lecture indisponible. Réessayez.',
        });
      }
    });
    return () => { active = false; controller.abort(); };
  }, [canView, ownerId, session?.access_token, refresh]);

  useEffect(() => {
    if (!canView || !automatic) return;
    const update = () => {
      if (document.visibilityState === 'visible') setRefresh((value) => value + 1);
    };
    const interval = window.setInterval(update, 60000);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', update);
    };
  }, [canView, automatic]);

  if (authLoading) {
    return <main className="min-h-screen flex items-center justify-center" role="status">Vérification du compte…</main>;
  }
  if (!canView) {
    return (
      <main className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="text-center max-w-md">
          <ShieldCheck className="w-12 h-12 mx-auto mb-4 text-amber-400" aria-hidden="true" />
          <h1 className="text-2xl font-bold mb-3">Espace privé</h1>
          <p className="text-muted-foreground mb-6">Cet espace est réservé au compte propriétaire vérifié.</p>
          <Button asChild><Link to="/dashboard">Retour à mon espace</Link></Button>
        </div>
      </main>
    );
  }

  // A different session never sees a previous owner's in-memory snapshot.
  const current = state.ownerId === ownerId ? state : EMPTY;
  const snapshot = current.snapshot;
  const partial = snapshot && (
    Object.values(snapshot.metrics).some((metric) => metric.status !== 'available')
    || snapshot.recentProfiles.status !== 'available'
  );
  const indicators = [
    { key: 'profiles' as const, title: 'Profils enregistrés', detail: 'Périmètre PURAMA AI', Icon: Users },
    { key: 'activeSubscriptions' as const, title: 'Abonnements marqués actifs', detail: 'Hors gratuit et essais · aucun encaissement déduit', Icon: CreditCard },
    { key: 'enabledAgents' as const, title: 'Agents activés au catalogue', detail: 'Ne mesure pas les agents en cours d’exécution', Icon: Bot },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="max-w-6xl mx-auto px-4 py-4 flex flex-wrap gap-3 items-center justify-between">
          <Button variant="ghost" asChild><Link to="/dashboard"><ArrowLeft className="w-4 h-4 mr-2" aria-hidden="true" />Mon espace</Link></Button>
          <span className="text-xs text-muted-foreground break-all">{SUPER_ADMIN_EMAIL}</span>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 py-8 sm:py-12">
        <div className="flex flex-wrap items-start justify-between gap-5 mb-6">
          <div>
            <p className="text-amber-400 text-xs uppercase tracking-widest font-semibold mb-2">PURAMA · Espace fondateur</p>
            <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Votre centre de pilotage</h1>
            <p className="mt-3 text-muted-foreground max-w-2xl">Les chiffres disponibles, leur provenance et les connexions qui restent à compléter.</p>
          </div>
          <Button onClick={() => setRefresh((value) => value + 1)} disabled={current.pending} aria-label="Actualiser le tableau de bord">
            <RefreshCw className={`w-4 h-4 mr-2 ${current.pending ? 'animate-spin' : ''}`} aria-hidden="true" />Actualiser
          </Button>
        </div>

        <section className="rounded-xl border border-border bg-card p-4 mb-6" aria-label="État des données">
          <div className="flex flex-wrap justify-between items-center gap-3">
            <p className="text-sm" role="status" aria-live="polite">
              {current.pending ? 'Lecture sécurisée en cours…' : snapshot
                ? `Dernière lecture : ${new Date(snapshot.observedAt).toLocaleString('fr-FR')}`
                : 'Aucune lecture confirmée pour cette session.'}
            </p>
            <Button variant="outline" size="sm" aria-pressed={automatic} onClick={() => setAutomatic((value) => !value)}>
              Actualisation automatique : {automatic ? 'activée' : 'désactivée'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-2">Périmètre actuel : PURAMA AI. Les autres services et les finances de l’entreprise ne sont pas encore consolidés ici.</p>
          <p className="text-xs text-muted-foreground mt-1">Actualisation toutes les minutes lorsque cet écran est visible.</p>
        </section>

        {current.error && (
          <div role="alert" className="rounded-xl border border-amber-400/30 bg-amber-400/5 p-4 mb-6 flex gap-3">
            <CircleAlert className="w-5 h-5 shrink-0 text-amber-400" aria-hidden="true" />
            <p className="text-sm">{current.error}</p>
          </div>
        )}
        {partial && <p role="status" className="mb-5 text-sm text-amber-300">Certaines sources sont indisponibles. Les valeurs manquantes restent affichées « — ».</p>}

        <section className="grid gap-4 md:grid-cols-3 mb-8" aria-label="Indicateurs vérifiables" aria-busy={current.pending}>
          {indicators.map(({ key, title, detail, Icon }) => (
            <Card key={key} className="bg-card border-border">
              <CardContent className="p-5">
                <Icon className="w-5 h-5 text-amber-400 mb-5" aria-hidden="true" />
                <h2 className="text-sm font-medium">{title}</h2>
                <p className="text-3xl font-bold my-3 tabular-nums" data-testid={key}>{dashboardMetricLabel(snapshot?.metrics[key])}</p>
                <p className="text-xs text-muted-foreground">{snapshot?.metrics[key].status === 'unavailable' ? 'Source indisponible · ' : ''}{detail}</p>
              </CardContent>
            </Card>
          ))}
        </section>

        <div className="grid gap-5 lg:grid-cols-2 mb-8">
          <Card className="bg-card border-border">
            <CardContent className="p-6">
              <Wallet className="w-6 h-6 text-amber-400 mb-4" aria-hidden="true" />
              <h2 className="font-semibold text-lg">Argent entrant et sortant</h2>
              <p className="text-xs text-amber-300 mt-2 mb-4">Connexions à finaliser</p>
              <p className="text-sm text-muted-foreground">Encaissements, dépenses, remboursements, commissions et trésorerie disponible nécessitent leurs sources vérifiées. Aucun montant n’est estimé automatiquement ici.</p>
              <p className="text-sm text-muted-foreground mt-3">Les comptes de l’association et de la société devront rester distincts, avec une vue consolidée sans compter deux fois les transferts.</p>
              <Button variant="outline" className="mt-5" asChild><Link to="/dashboard/compta-agent">Ouvrir mon espace comptable</Link></Button>
            </CardContent>
          </Card>
          <Card className="bg-card border-border">
            <CardContent className="p-6">
              <Bot className="w-6 h-6 text-amber-400 mb-4" aria-hidden="true" />
              <h2 className="font-semibold text-lg">IAO et employés IA</h2>
              <p className="text-xs text-amber-300 mt-2 mb-4">Commandes globales non reliées à cette vue</p>
              <p className="text-sm text-muted-foreground">L’espace existant permet de consulter vos employés IA et leurs actions. Les modifications de l’entreprise, les tests et les retours arrière doivent être reliés à une exécution contrôlée et à une preuve de résultat.</p>
              <Button variant="outline" className="mt-5" asChild><Link to="/dashboard/employees">Voir mes employés IA</Link></Button>
            </CardContent>
          </Card>
        </div>

        <Card className="bg-card border-border">
          <CardContent className="p-6">
            <div className="flex gap-3 items-center mb-5">
              <History className="w-5 h-5 text-amber-400" aria-hidden="true" />
              <h2 className="font-semibold text-lg">Derniers profils enregistrés</h2>
            </div>
            {!snapshot || snapshot.recentProfiles.status === 'unavailable' ? (
              <p className="text-sm text-muted-foreground">{current.pending ? 'Chargement…' : 'Liste indisponible.'}</p>
            ) : snapshot.recentProfiles.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucun profil enregistré dans cette source.</p>
            ) : (
              <ul className="divide-y divide-border">
                {snapshot.recentProfiles.items.map((profile) => (
                  <li key={profile.id} className="py-3 flex flex-wrap justify-between gap-2">
                    <span className="text-sm break-words min-w-0">{profile.full_name || 'Profil sans nom'}</span>
                    <span className="text-xs text-muted-foreground">{profile.created_at ? new Date(profile.created_at).toLocaleDateString('fr-FR') : 'Date indisponible'}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
