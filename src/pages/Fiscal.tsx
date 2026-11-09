// ─── /fiscal · Assistant fiscal 4 profils + seuils + rappels (V4.1) ──────
import { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Calculator, User, Briefcase, Building2, HelpCircle,
  CheckCircle2, AlertCircle, Loader2, FileText, ShieldCheck,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { verifySiret, formatSiret, type VerifySiretResult } from '@/lib/insee';
import { toast } from 'sonner';

type Profile = 'particulier_occasionnel' | 'particulier_bnc' | 'autoentrepreneur' | 'entreprise';

const PROFILES: Array<{ id: Profile; label: string; hint: string; icon: typeof User }> = [
  { id: 'particulier_occasionnel', label: 'Particulier occasionnel', hint: 'Je prépare le suivi de mes revenus occasionnels', icon: User },
  { id: 'particulier_bnc',        label: 'Particulier BNC',         hint: 'Je renseigne mon profil de revenus non commerciaux', icon: User },
  { id: 'autoentrepreneur',       label: 'Auto-entrepreneur',        hint: 'Je renseigne mon SIRET et mon activité', icon: Briefcase },
  { id: 'entreprise',             label: 'Entreprise',               hint: 'Je renseigne les informations de ma structure', icon: Building2 },
];

export default function Fiscal() {
  const { user } = useAuth();
  const userId = user?.id;
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [siret, setSiret] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [verifyState, setVerifyState] = useState<{ loading: boolean; result?: VerifySiretResult }>({ loading: false });
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    setProfile(null);
    setSiret('');
    setCompanyName('');
    (async () => {
      try {
        const { data, error } = await supabase.schema('public').from('user_tax_profiles')
          .select('profile_type, siret, company_name').eq('user_id', userId).maybeSingle();
        if (error) throw error;
        if (cancelled) return;
        setProfile(PROFILES.find(option => option.id === data?.profile_type)?.id ?? null);
        setSiret(data?.siret ?? '');
        setCompanyName(data?.company_name ?? '');
      } catch {
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [userId, loadAttempt]);

  const handleVerifySiret = async () => {
    if (!siret.trim()) return;
    setVerifyState({ loading: true });
    const result = await verifySiret(siret);
    setVerifyState({ loading: false, result });
    if (result.valid && result.etablissement) {
      setCompanyName(result.etablissement.denominationUniteLegale ?? '');
      if (!result.active) toast.warning('Établissement fermé — vérifie le SIRET.');
      else toast.success('SIRET vérifié auprès de l\'INSEE.');
    } else {
      toast.error(result.error ?? 'SIRET invalide.');
    }
  };

  const handleSave = async () => {
    if (!user || !profile) return;
    setSaving(true);
    try {
      const { error } = await supabase.schema('public').from('user_tax_profiles').upsert({
        user_id: user.id,
        profile_type: profile,
        siret: siret.trim() || null,
        company_name: companyName.trim() || null,
        onboarded_at: new Date().toISOString(),
      });
      if (error) throw error;
      toast.success('Profil fiscal enregistré.');
    } catch {
      toast.error('Impossible d’enregistrer le profil fiscal. Réessaie dans un instant.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-accent-cyan" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground py-12 px-4">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-3 mb-2">
          <Calculator className="w-8 h-8 text-accent-cyan" />
          <h1 className="text-3xl sm:text-4xl font-orbitron font-bold">Assistant fiscal</h1>
        </div>
        <p className="text-muted-foreground mb-8">
          Renseigne ton profil et les informations utiles à la préparation de tes démarches.
        </p>

        {loadError && (
          <Card className="mb-6 border-destructive/40" role="alert">
            <CardContent className="p-5 space-y-3">
              <p className="flex items-center gap-2"><AlertCircle className="w-4 h-4" /> Impossible de charger ton profil fiscal.</p>
              <Button variant="outline" onClick={() => setLoadAttempt(attempt => attempt + 1)}>Réessayer</Button>
            </CardContent>
          </Card>
        )}

        {/* A wallet balance is not an annual income statement. No reliable annual source is available here. */}
        <Card className="mb-6 bg-secondary/30 border-accent-cyan/20">
          <CardContent className="p-5">
            <div>
              <p className="text-xs text-muted-foreground">Gains cumulés cette année</p>
              <p className="text-lg font-semibold">Montant annuel indisponible</p>
              <p className="text-sm text-muted-foreground mt-2">Consulte tes relevés de revenus pour préparer ta déclaration.</p>
            </div>
          </CardContent>
        </Card>

        {/* Choix profil */}
        <h2 className="font-orbitron font-bold mb-3 flex items-center gap-2">
          <HelpCircle className="w-5 h-5" /> Quel est ton profil ?
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-8">
          {PROFILES.map((p) => {
            const Icon = p.icon;
            const active = profile === p.id;
            return (
              <button
                key={p.id}
                onClick={() => setProfile(p.id)}
                className={`text-left p-4 rounded-lg border transition-all ${
                  active
                    ? 'border-accent-cyan bg-accent-cyan/10'
                    : 'border-border/50 hover:border-accent-cyan/50 bg-secondary/20'
                }`}
              >
                <div className="flex items-start gap-3">
                  <Icon className="w-5 h-5 text-accent-cyan mt-0.5" />
                  <div>
                    <p className="font-bold">{p.label}</p>
                    <p className="text-xs text-muted-foreground mt-1">{p.hint}</p>
                  </div>
                  {active && <CheckCircle2 className="w-5 h-5 text-accent-cyan ml-auto shrink-0" />}
                </div>
              </button>
            );
          })}
        </div>

        {/* Formulaire SIRET si AE ou entreprise */}
        {(profile === 'autoentrepreneur' || profile === 'entreprise') && (
          <Card className="mb-6 bg-secondary/30">
            <CardContent className="p-5 space-y-4">
              <h3 className="font-bold flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-accent-cyan" /> Vérification SIRET via INSEE
              </h3>
              <div className="flex gap-2">
                <Input
                  placeholder="14 chiffres — ex: 123 456 789 00012"
                  value={siret}
                  onChange={(e) => setSiret(e.target.value)}
                  maxLength={17}
                />
                <Button onClick={handleVerifySiret} disabled={verifyState.loading || !siret.trim()}>
                  {verifyState.loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Vérifier'}
                </Button>
              </div>
              {verifyState.result?.etablissement && (
                <div className="p-3 rounded bg-emerald-500/10 border border-emerald-500/30 text-sm">
                  <p className="font-bold">{verifyState.result.etablissement.denominationUniteLegale}</p>
                  <p className="text-xs text-muted-foreground">
                    SIRET : {formatSiret(verifyState.result.etablissement.siret)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {verifyState.result.etablissement.adresse.voie},{' '}
                    {verifyState.result.etablissement.adresse.codePostal}{' '}
                    {verifyState.result.etablissement.adresse.commune}
                  </p>
                  {!verifyState.result.active && (
                    <p className="text-amber-400 text-xs mt-1">⚠️ Établissement fermé</p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Flow info par profil */}
        {profile && (
          <Card className="mb-6 bg-accent-purple/5 border-accent-purple/20">
            <CardContent className="p-5">
              <h3 className="font-bold mb-2 flex items-center gap-2">
                <FileText className="w-4 h-4 text-accent-purple" /> Préparer ton profil
              </h3>
              <FlowInfo profile={profile} />
            </CardContent>
          </Card>
        )}

        <Button
          onClick={handleSave}
          disabled={!profile || saving || loadError}
          size="lg"
          className="w-full bg-gradient-to-r from-accent-purple to-accent-cyan"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
          Enregistrer mon profil fiscal
        </Button>

        {/* Mention légale */}
        <p className="text-xs text-muted-foreground mt-6 p-4 border border-border/30 rounded">
          Cette page enregistre ton profil ; elle ne transmet aucune déclaration fiscale ou sociale.
          Les obligations dépendent de la nature des revenus et de ta situation. Consulte les{' '}
          <a href="https://www.impots.gouv.fr/revenus-de-plateformes-collaboratives-0" target="_blank" rel="noopener noreferrer" className="underline">
            informations de l’administration fiscale
          </a>{' '}
          ou un professionnel pour déterminer les démarches applicables.
        </p>
      </div>
    </div>
  );
}

function FlowInfo({ profile }: { profile: Profile }) {
  const content: Record<Profile, React.ReactNode> = {
    particulier_occasionnel: (
      <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
        <li>Conserve le récapitulatif annuel de tes revenus.</li>
        <li>Vérifie leur caractère imposable et leur catégorie auprès de l’administration fiscale.</li>
      </ul>
    ),
    particulier_bnc: (
      <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
        <li>Enregistre le profil correspondant à ta situation.</li>
        <li>Rassemble les relevés utiles à ta déclaration et vérifie le régime applicable.</li>
      </ul>
    ),
    autoentrepreneur: (
      <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
        <li>Renseigne et vérifie ton SIRET.</li>
        <li>Enregistre les informations de ton activité pour préparer tes démarches.</li>
      </ul>
    ),
    entreprise: (
      <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
        <li>Renseigne le SIRET et vérifie l’identité de ta structure.</li>
        <li>Conserve tes justificatifs et prépare tes démarches avec ton service comptable.</li>
      </ul>
    ),
  };
  return <>{content[profile]}</>;
}
