import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2, Crown, TrendingUp, Infinity as InfinityIcon, Sparkles, Mail, Check } from 'lucide-react';
import { toast } from 'sonner';

const TIERS = [
  { slug: 'bronze',  template: 'ambassadeur-bronze',  icon: TrendingUp,   label: 'Bronze',  rate: 10, minReferrals: 10,    color: 'from-amber-700 to-amber-500',  highlight: 'Point d\'entrée : commission 10% à vie' },
  { slug: 'argent',  template: 'ambassadeur-argent',  icon: TrendingUp,   label: 'Argent',  rate: 15, minReferrals: 25,    color: 'from-slate-400 to-slate-200',  highlight: 'Commission 15% + accès anticipé 7 jours' },
  { slug: 'or',      template: 'ambassadeur-or',      icon: Crown,        label: 'Or',      rate: 20, minReferrals: 50,    color: 'from-yellow-500 to-amber-300',  highlight: 'Commission 20% + page perso dédiée' },
  { slug: 'platine', template: 'ambassadeur-platine', icon: Sparkles,     label: 'Platine', rate: 25, minReferrals: 100,   color: 'from-violet-500 to-purple-300', highlight: 'Commission 25% + priorité features + événements VIP' },
  { slug: 'eternel', template: 'ambassadeur-eternel', icon: InfinityIcon, label: 'Éternel', rate: 30, minReferrals: 10000, color: 'from-fuchsia-600 via-purple-500 to-indigo-500', highlight: 'Commission 30% à vie, transmission héréditaire' },
] as const;

type TierSlug = typeof TIERS[number]['slug'];

interface Form {
  fullName: string;
  address: string;
  postalCode: string;
  city: string;
  country: string;
  phone: string;
  siret: string;
  iban: string;
  socialLinks: string;
  heirPrimaryName: string;
  heirPrimaryEmail: string;
  heirPrimaryRelation: string;
}

const EMPTY_FORM: Form = {
  fullName: '', address: '', postalCode: '', city: '', country: 'France',
  phone: '', siret: '', iban: '', socialLinks: '',
  heirPrimaryName: '', heirPrimaryEmail: '', heirPrimaryRelation: '',
};

export default function AmbassadeurRejoindre() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [selectedTier, setSelectedTier] = useState<TierSlug | null>(null);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [cguAccepted, setCguAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [contractId, setContractId] = useState<string | null>(null);

  if (authLoading) return <div className="p-8"><Loader2 className="animate-spin" /></div>;
  if (!user) { navigate('/login?next=/ambassadeur/rejoindre'); return null; }

  const tier = TIERS.find(t => t.slug === selectedTier);

  function onFormChange<K extends keyof Form>(key: K, value: Form[K]) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  function validateStep2(): string | null {
    if (!form.fullName.trim()) return 'Nom complet requis';
    if (!form.address.trim()) return 'Adresse requise';
    if (!form.city.trim()) return 'Ville requise';
    if (!form.postalCode.trim()) return 'Code postal requis';
    if (!form.iban.trim() || form.iban.replace(/\s/g, '').length < 15) return 'IBAN invalide';
    if (selectedTier === 'eternel' && !form.heirPrimaryName.trim()) {
      return 'Pour Éternel, merci de désigner au moins un héritier';
    }
    return null;
  }

  async function handleSubmit() {
    if (!tier || !user) return;
    if (!cguAccepted) { toast.error('Acceptez les conditions pour continuer'); return; }

    setSubmitting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Session expirée');

      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/contracts-create`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          app_slug: 'purama_ai',
          template_slug: tier.template,
          signer: {
            email: user.email ?? '',
            name: form.fullName,
          },
          metadata: {
            address: form.address,
            city: form.city,
            postal_code: form.postalCode,
            country: form.country,
            phone: form.phone,
            siret: form.siret,
            iban: form.iban,
            social_links: form.socialLinks,
            tier: tier.slug,
            heir_primary: tier.slug === 'eternel' ? {
              name: form.heirPrimaryName,
              email: form.heirPrimaryEmail,
              relation: form.heirPrimaryRelation,
            } : null,
          },
          variables: {
            commission_rate: String(tier.rate),
            user_iban: form.iban,
          },
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

      setContractId(data.contract_id);
      setStep(4);
      toast.success('Contrat envoyé ! Vérifie ta boîte mail.');
    } catch (err) {
      toast.error(`Erreur : ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-background via-background to-muted/20 py-8 px-4">
      <div className="max-w-4xl mx-auto">
        <header className="text-center mb-10">
          <Badge className="mb-3 bg-gradient-to-r from-fuchsia-600 to-purple-600 text-white">Programme Ambassadeur</Badge>
          <h1 className="text-4xl font-semibold mb-2">Rejoins les ambassadeurs Purama</h1>
          <p className="text-muted-foreground max-w-xl mx-auto">Commission récurrente, badges, avantages exclusifs. Signature électronique eIDAS en 2 minutes.</p>
        </header>

        <Stepper current={step} />

        {step === 1 && (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4 mt-8">
            {TIERS.map(t => {
              const Icon = t.icon;
              const selected = t.slug === selectedTier;
              return (
                <Card
                  key={t.slug}
                  onClick={() => setSelectedTier(t.slug)}
                  className={`cursor-pointer transition-all ${selected ? 'ring-2 ring-primary shadow-lg scale-[1.02]' : 'hover:shadow-md'}`}
                >
                  <CardHeader>
                    <div className={`h-14 w-14 rounded-xl bg-gradient-to-br ${t.color} flex items-center justify-center mb-3`}>
                      <Icon className="h-7 w-7 text-white" />
                    </div>
                    <CardTitle className="flex items-center justify-between">
                      {t.label}
                      {selected && <Check className="h-5 w-5 text-primary" />}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-3xl font-bold mb-1">{t.rate}%</div>
                    <div className="text-xs text-muted-foreground mb-3">commission récurrente</div>
                    <p className="text-sm">{t.highlight}</p>
                    <div className="text-xs text-muted-foreground mt-3">
                      {t.minReferrals >= 10000 ? 'Palier ultime' : `À partir de ${t.minReferrals} filleuls`}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {step === 2 && tier && (
          <Card className="mt-8">
            <CardHeader>
              <CardTitle>Tes informations — Palier {tier.label}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid md:grid-cols-2 gap-4">
                <Field label="Nom complet *" value={form.fullName} onChange={v => onFormChange('fullName', v)} placeholder="Prénom NOM" />
                <Field label="Téléphone" value={form.phone} onChange={v => onFormChange('phone', v)} placeholder="+33 6 …" />
                <Field label="Adresse *" value={form.address} onChange={v => onFormChange('address', v)} placeholder="Rue + numéro" className="md:col-span-2" />
                <Field label="Code postal *" value={form.postalCode} onChange={v => onFormChange('postalCode', v)} />
                <Field label="Ville *" value={form.city} onChange={v => onFormChange('city', v)} />
                <Field label="Pays" value={form.country} onChange={v => onFormChange('country', v)} />
                <Field label="SIRET (si pro)" value={form.siret} onChange={v => onFormChange('siret', v)} placeholder="14 chiffres" />
                <Field label="IBAN *" value={form.iban} onChange={v => onFormChange('iban', v)} placeholder="FR76…" className="md:col-span-2" />
              </div>
              <Label>Réseaux sociaux (liens, un par ligne)</Label>
              <Textarea
                value={form.socialLinks}
                onChange={e => onFormChange('socialLinks', e.target.value)}
                placeholder="https://instagram.com/…"
                rows={3}
              />
              {tier.slug === 'eternel' && (
                <Card className="bg-fuchsia-50 dark:bg-fuchsia-950/30 border-fuchsia-200 dark:border-fuchsia-900/40">
                  <CardHeader>
                    <CardTitle className="text-base">Héritier principal (palier Éternel)</CardTitle>
                  </CardHeader>
                  <CardContent className="grid md:grid-cols-3 gap-4">
                    <Field label="Nom" value={form.heirPrimaryName} onChange={v => onFormChange('heirPrimaryName', v)} />
                    <Field label="Email" value={form.heirPrimaryEmail} onChange={v => onFormChange('heirPrimaryEmail', v)} />
                    <Field label="Lien (enfant, époux...)" value={form.heirPrimaryRelation} onChange={v => onFormChange('heirPrimaryRelation', v)} />
                  </CardContent>
                </Card>
              )}
            </CardContent>
          </Card>
        )}

        {step === 3 && tier && (
          <Card className="mt-8">
            <CardHeader>
              <CardTitle>Revue & signature</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="bg-muted/50 rounded-lg p-5 space-y-3 text-sm">
                <Summary label="Palier">{tier.label} — {tier.rate}% commission récurrente</Summary>
                <Summary label="Nom">{form.fullName}</Summary>
                <Summary label="Email (signature)">{user.email}</Summary>
                <Summary label="Adresse">{form.address}, {form.postalCode} {form.city}, {form.country}</Summary>
                <Summary label="IBAN">{form.iban}</Summary>
                {form.siret && <Summary label="SIRET">{form.siret}</Summary>}
                {tier.slug === 'eternel' && form.heirPrimaryName && (
                  <Summary label="Héritier">{form.heirPrimaryName} ({form.heirPrimaryRelation})</Summary>
                )}
              </div>

              <div className="space-y-3 text-xs text-muted-foreground p-4 bg-background rounded-lg border">
                <p><strong>Signature électronique (art. 1366 Code civil)</strong> — Après validation, tu recevras un email DocuSeal avec un lien de signature sécurisé.</p>
                <p><strong>Horodatage blockchain</strong> — Le contrat signé sera horodaté sur Bitcoin via OpenTimestamps, preuve légale vérifiable.</p>
                <p><strong>Juridiction</strong> — Tribunal de Besançon. Droit français applicable.</p>
                <p><strong>RGPD</strong> — Données conservées 10 ans (obligation comptable). DPO : dpo@purama.dev.</p>
              </div>

              <label className="flex items-start gap-3 cursor-pointer">
                <Checkbox checked={cguAccepted} onCheckedChange={v => setCguAccepted(!!v)} />
                <span className="text-sm">
                  J'ai lu et j'accepte les conditions du programme Ambassadeur Purama et je confirme l'exactitude des informations fournies.
                </span>
              </label>
            </CardContent>
          </Card>
        )}

        {step === 4 && (
          <Card className="mt-8">
            <CardContent className="py-12 text-center">
              <div className="h-20 w-20 mx-auto mb-6 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                <Mail className="h-10 w-10 text-emerald-600" />
              </div>
              <h2 className="text-2xl font-semibold mb-2">Contrat envoyé par email</h2>
              <p className="text-muted-foreground max-w-md mx-auto">
                Vérifie ta boîte mail <strong>{user.email}</strong>. Tu recevras un lien DocuSeal pour signer ton contrat Ambassadeur <strong>{tier?.label}</strong>.
              </p>
              {contractId && (
                <p className="text-xs text-muted-foreground mt-4">Référence : <code>{contractId.slice(0, 8)}</code></p>
              )}
              <div className="mt-8 flex gap-3 justify-center">
                <Button variant="outline" onClick={() => navigate('/dashboard')}>Retour au dashboard</Button>
                <Button onClick={() => window.location.reload()}>Rejoindre un autre palier</Button>
              </div>
            </CardContent>
          </Card>
        )}

        {step !== 4 && (
          <div className="mt-6 flex justify-between">
            <Button
              variant="ghost"
              disabled={step === 1}
              onClick={() => setStep(s => (s - 1) as 1 | 2 | 3)}
            >
              Précédent
            </Button>
            <Button
              disabled={submitting || (step === 1 && !selectedTier) || (step === 3 && !cguAccepted)}
              onClick={() => {
                if (step === 2) {
                  const err = validateStep2();
                  if (err) { toast.error(err); return; }
                }
                if (step === 3) { handleSubmit(); return; }
                setStep(s => (s + 1) as 2 | 3);
              }}
            >
              {submitting ? <Loader2 className="animate-spin h-4 w-4 mr-2" /> : null}
              {step === 3 ? 'Signer le contrat' : 'Continuer'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function Stepper({ current }: { current: number }) {
  const steps = ['Palier', 'Infos', 'Revue', 'Confirmation'];
  return (
    <div className="flex items-center gap-2 justify-center max-w-xl mx-auto">
      {steps.map((label, i) => {
        const n = i + 1;
        const done = n < current;
        const active = n === current;
        return (
          <div key={label} className="flex items-center gap-2 flex-1">
            <div className={`h-8 w-8 rounded-full flex items-center justify-center text-xs font-semibold
              ${done ? 'bg-emerald-500 text-white'
                : active ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground'}`}>
              {done ? <Check className="h-4 w-4" /> : n}
            </div>
            <span className={`text-xs ${active ? 'font-semibold' : 'text-muted-foreground'}`}>{label}</span>
            {i < steps.length - 1 && <div className="flex-1 h-[1px] bg-border" />}
          </div>
        );
      })}
    </div>
  );
}

function Field({ label, value, onChange, placeholder, className }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; className?: string;
}) {
  return (
    <div className={className}>
      <Label>{label}</Label>
      <Input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} className="mt-1" />
    </div>
  );
}

function Summary({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <span className="text-muted-foreground min-w-[100px]">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  );
}
