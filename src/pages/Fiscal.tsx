// ─── /fiscal · Assistant fiscal 4 profils + seuils + rappels (V4.1) ──────
import { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
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
  { id: 'particulier_occasionnel', label: 'Particulier occasionnel', hint: "Je gagne peu (< 305€/an)", icon: User },
  { id: 'particulier_bnc',        label: 'Particulier BNC',         hint: '305€ à 77 700€/an, pas de SIRET', icon: User },
  { id: 'autoentrepreneur',       label: 'Auto-entrepreneur',        hint: "J'ai mon SIRET — Purama déclare à l'URSSAF pour moi", icon: Briefcase },
  { id: 'entreprise',             label: 'Entreprise',               hint: 'SASU, SARL, asso — Factur-X auto vers Pennylane', icon: Building2 },
];

const THRESHOLDS = {
  occasional: 305,     // pas de déclaration en-dessous
  bnc_micro: 77_700,   // abattement 34% auto
  tva_franchise: 36_800,
  bic_micro: 188_700,
} as const;

export default function Fiscal() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [siret, setSiret] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [verifyState, setVerifyState] = useState<{ loading: boolean; result?: VerifySiretResult }>({ loading: false });
  const [yearlyEarned, setYearlyEarned] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const [{ data: p }, { data: w }] = await Promise.all([
        supabase.from('user_tax_profiles').select('profile_type, siret, company_name').eq('user_id', user.id).maybeSingle(),
        supabase.from('profiles').select('wallet_balance').eq('id', user.id).maybeSingle(),
      ]);
      if (p?.profile_type) setProfile(p.profile_type as Profile);
      if (p?.siret) setSiret(p.siret);
      if (p?.company_name) setCompanyName(p.company_name);
      if (w?.wallet_balance) setYearlyEarned(Number(w.wallet_balance));
      setLoading(false);
    })();
  }, [user]);

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
    const { error } = await supabase.from('user_tax_profiles').upsert({
      user_id: user.id,
      profile_type: profile,
      siret: siret.trim() || null,
      company_name: companyName.trim() || null,
      onboarded_at: new Date().toISOString(),
    });
    setSaving(false);
    if (error) toast.error(error.message);
    else toast.success('Profil fiscal enregistré.');
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
          Purama déclare tout pour toi selon ton profil. Zéro paperasse, zéro stress.
        </p>

        {/* Compteur gains annuels */}
        <Card className="mb-6 bg-secondary/30 border-accent-cyan/20">
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">Gains cumulés cette année</p>
              <p className="text-2xl font-bold">{yearlyEarned.toFixed(2)}€</p>
            </div>
            <div className="text-right">
              {yearlyEarned < THRESHOLDS.occasional && (
                <Badge className="bg-emerald-500/20 text-emerald-400">Aucune déclaration requise</Badge>
              )}
              {yearlyEarned >= THRESHOLDS.occasional && yearlyEarned < THRESHOLDS.bnc_micro && (
                <Badge className="bg-amber-500/20 text-amber-400">Seuil de déclaration franchi</Badge>
              )}
              {yearlyEarned >= THRESHOLDS.bnc_micro && (
                <Badge className="bg-red-500/20 text-red-400">Micro-BNC dépassé — passage AE/entreprise</Badge>
              )}
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
                <FileText className="w-4 h-4 text-accent-purple" /> Ce que Purama fait pour toi
              </h3>
              <FlowInfo profile={profile} />
            </CardContent>
          </Card>
        )}

        <Button
          onClick={handleSave}
          disabled={!profile || saving}
          size="lg"
          className="w-full bg-gradient-to-r from-accent-purple to-accent-cyan"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
          Enregistrer mon profil fiscal
        </Button>

        {/* Mention légale */}
        <p className="text-xs text-muted-foreground mt-6 p-4 border border-border/30 rounded">
          ⚖️ <b>Mention légale</b> — Les gains perçus via Purama peuvent être soumis à l'impôt sur le revenu
          selon ta situation fiscale et le montant perçu. En France, un seuil de déclaration s'applique à partir
          de 3 000€ de revenus annuels via des plateformes numériques. Purama t'informera automatiquement
          lorsque tu approcheras de ce seuil. Purama ne saurait être tenu responsable des obligations fiscales
          individuelles de ses utilisateurs. Consulte un conseiller fiscal pour ta situation personnelle.
        </p>
      </div>
    </div>
  );
}

function FlowInfo({ profile }: { profile: Profile }) {
  const content: Record<Profile, React.ReactNode> = {
    particulier_occasionnel: (
      <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
        <li>Tant que tu gagnes moins de 305€/an sur Purama : <b>aucune déclaration</b>.</li>
        <li>Purama t'alerte automatiquement à 250€ (80% du seuil).</li>
        <li>Au-delà : bascule automatique sur le profil "Particulier BNC".</li>
      </ul>
    ),
    particulier_bnc: (
      <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
        <li>Purama pré-remplit ta case 5KU du formulaire 2042-C-PRO en mars.</li>
        <li>Lien 1-click vers impots.gouv.fr pré-rempli · <b>abattement 34% auto</b>.</li>
        <li>Effort total : ~10 secondes en mars. Rappel par email en février.</li>
      </ul>
    ),
    autoentrepreneur: (
      <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
        <li>Mandat URSSAF signé une fois via DocuSeal (2 minutes).</li>
        <li>API URSSAF Tierce Déclaration activée → <b>déclarations trimestrielles 100% auto</b>.</li>
        <li>Cotisations prélevées directement — tu ne fais plus jamais rien.</li>
      </ul>
    ),
    entreprise: (
      <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
        <li>Connexion Pennylane via OAuth (1 clic).</li>
        <li><b>Factur-X</b> générée automatiquement sur chaque paiement Purama.</li>
        <li>EDI-TDFC activable si pas d'expert-comptable · TVA calculée auto.</li>
      </ul>
    ),
  };
  return <>{content[profile]}</>;
}
