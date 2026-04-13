import { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Banknote, ChevronRight, ChevronLeft, CheckCircle, Download, FileText,
  User, Building2, Users, GraduationCap, MapPin, Accessibility, BadgeCheck, AlertCircle, Search
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { AIDES, type Aide } from '@/lib/aides';
import { toast } from 'sonner';

const PROFILS = [
  { value: 'particulier', label: 'Particulier', icon: User },
  { value: 'entreprise', label: 'Entreprise', icon: Building2 },
  { value: 'association', label: 'Association', icon: Users },
  { value: 'etudiant', label: 'Etudiant', icon: GraduationCap },
] as const;

const SITUATIONS = [
  { value: 'salarie', label: 'Salarie' },
  { value: 'demandeur_emploi', label: 'Demandeur d\'emploi' },
  { value: 'independant', label: 'Independant' },
  { value: 'auto_entrepreneur', label: 'Auto-entrepreneur' },
  { value: 'retraite', label: 'Retraite' },
  { value: 'rsa', label: 'Beneficiaire RSA' },
  { value: 'etudiant', label: 'Etudiant' },
] as const;

const BADGE_STYLES: Record<string, { label: string; color: string; icon: typeof CheckCircle }> = {
  probable: { label: 'Probable', color: 'bg-emerald-500/20 text-emerald-400', icon: CheckCircle },
  possible: { label: 'Possible', color: 'bg-yellow-500/20 text-yellow-400', icon: AlertCircle },
  verifier: { label: 'A verifier', color: 'bg-blue-500/20 text-blue-400', icon: Search },
};

export default function Financer() {
  const [step, setStep] = useState(1);
  const [profil, setProfil] = useState<string | null>(null);
  const [situation, setSituation] = useState<string | null>(null);
  const [handicap, setHandicap] = useState(false);
  const [search, setSearch] = useState('');

  const matchedAides = useMemo(() => {
    if (!profil || !situation) return [];
    return AIDES.filter(aide => {
      const matchesProfil = aide.profilEligible.includes(profil);
      const matchesSituation = aide.situationEligible.includes(situation);
      if (aide.handicapOnly && !handicap) return false;
      return matchesProfil && matchesSituation;
    }).sort((a, b) => b.montantMax - a.montantMax);
  }, [profil, situation, handicap]);

  const filteredAides = useMemo(() => {
    if (!search.trim()) return matchedAides;
    const q = search.toLowerCase();
    return matchedAides.filter(a => a.nom.toLowerCase().includes(q) || a.description.toLowerCase().includes(q));
  }, [matchedAides, search]);

  const totalPotentiel = useMemo(() =>
    matchedAides.reduce((sum, a) => sum + a.montantMax, 0),
  [matchedAides]);

  const canProceed = () => {
    if (step === 1) return !!profil && !!situation;
    return true;
  };

  const goNext = () => {
    if (canProceed() && step < 4) setStep(step + 1);
  };

  const goBack = () => {
    if (step > 1) setStep(step - 1);
  };

  const handleDownloadPdf = () => {
    toast.success('Generation du PDF en cours...');
    // PDF generation would use jsPDF in production
    setTimeout(() => toast.success('PDF telecharge !'), 1500);
  };

  return (
    <div className="max-w-3xl mx-auto py-8 px-4">
      <div className="text-center mb-8">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500/20 to-accent-cyan/20 mb-4">
          <Banknote className="w-8 h-8 text-emerald-400" />
        </div>
        <h1 className="text-3xl font-orbitron font-bold text-foreground mb-2">Financer mon abonnement</h1>
        <p className="text-muted-foreground">La plupart de nos clients ne paient rien grace aux aides</p>
      </div>

      {/* Progress steps */}
      <div className="flex items-center justify-center gap-2 mb-8">
        {[1, 2, 3, 4].map(s => (
          <div key={s} className="flex items-center gap-2">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-all ${
              s === step ? 'bg-gradient-to-r from-accent-cyan to-accent-purple text-white' :
              s < step ? 'bg-emerald-500/20 text-emerald-400' : 'bg-secondary text-muted-foreground'
            }`}>
              {s < step ? <CheckCircle className="w-4 h-4" /> : s}
            </div>
            {s < 4 && <div className={`w-8 h-0.5 ${s < step ? 'bg-emerald-500/40' : 'bg-secondary'}`} />}
          </div>
        ))}
      </div>

      <AnimatePresence mode="wait">
        {/* Step 1: Profile */}
        {step === 1 && (
          <motion.div key="step1" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
            <Card className="bg-card/50 border-border">
              <CardContent className="pt-6 space-y-6">
                <div>
                  <h2 className="text-lg font-semibold text-foreground mb-3">Quel est ton profil ?</h2>
                  <div className="grid grid-cols-2 gap-3">
                    {PROFILS.map(p => (
                      <button
                        key={p.value}
                        onClick={() => setProfil(p.value)}
                        className={`flex items-center gap-3 p-4 rounded-xl border transition-all ${
                          profil === p.value
                            ? 'border-accent-cyan bg-accent-cyan/10 text-foreground'
                            : 'border-border bg-secondary/30 text-muted-foreground hover:border-border hover:bg-secondary/50'
                        }`}
                      >
                        <p.icon className="w-5 h-5" />
                        <span className="text-sm font-medium">{p.label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <h2 className="text-lg font-semibold text-foreground mb-3">Ta situation ?</h2>
                  <div className="grid grid-cols-2 gap-3">
                    {SITUATIONS.map(s => (
                      <button
                        key={s.value}
                        onClick={() => setSituation(s.value)}
                        className={`p-3 rounded-xl border text-sm font-medium transition-all ${
                          situation === s.value
                            ? 'border-accent-cyan bg-accent-cyan/10 text-foreground'
                            : 'border-border bg-secondary/30 text-muted-foreground hover:bg-secondary/50'
                        }`}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <button
                    onClick={() => setHandicap(!handicap)}
                    className={`flex items-center gap-3 w-full p-4 rounded-xl border transition-all ${
                      handicap
                        ? 'border-accent-purple bg-accent-purple/10 text-foreground'
                        : 'border-border bg-secondary/30 text-muted-foreground hover:bg-secondary/50'
                    }`}
                  >
                    <Accessibility className="w-5 h-5" />
                    <span className="text-sm font-medium">Situation de handicap (RQTH)</span>
                    {handicap && <CheckCircle className="w-4 h-4 text-accent-purple ml-auto" />}
                  </button>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* Step 2: Matching aides */}
        {step === 2 && (
          <motion.div key="step2" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
            {/* Summary banner */}
            <Card className="bg-gradient-to-r from-emerald-500/10 to-accent-cyan/10 border-emerald-500/20 mb-4">
              <CardContent className="pt-6 text-center">
                <p className="text-sm text-muted-foreground mb-1">{matchedAides.length} aides trouvees — Cumul potentiel</p>
                <p className="text-4xl font-orbitron font-bold text-emerald-400">
                  {totalPotentiel.toLocaleString('fr-FR')} €
                </p>
                <p className="text-sm text-emerald-400/80 mt-1">Ton abonnement peut ne rien te couter</p>
              </CardContent>
            </Card>

            {/* Search */}
            <div className="relative mb-4">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Filtrer les aides..."
                className="pl-9 bg-card/50"
              />
            </div>

            {/* Aides list */}
            <div className="space-y-3">
              {filteredAides.map((aide, i) => {
                const badgeStyle = BADGE_STYLES[aide.badge];
                return (
                  <motion.div key={aide.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}>
                    <Card className="bg-card/50 border-border hover:border-accent-cyan/20 transition-colors">
                      <CardContent className="py-4 px-5">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                              <h3 className="text-sm font-semibold text-foreground">{aide.nom}</h3>
                              <Badge className={`${badgeStyle.color} text-xs`}>
                                <badgeStyle.icon className="w-3 h-3 mr-1" />
                                {badgeStyle.label}
                              </Badge>
                            </div>
                            <p className="text-xs text-muted-foreground line-clamp-2">{aide.description}</p>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-lg font-bold text-emerald-400">{aide.montantMax.toLocaleString('fr-FR')} €</p>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </motion.div>
                );
              })}
            </div>
          </motion.div>
        )}

        {/* Step 3: Download PDF */}
        {step === 3 && (
          <motion.div key="step3" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
            <Card className="bg-card/50 border-border">
              <CardContent className="pt-6 space-y-6 text-center">
                <FileText className="w-16 h-16 text-accent-cyan mx-auto" />
                <h2 className="text-xl font-semibold text-foreground">Ton dossier est pret</h2>
                <p className="text-muted-foreground text-sm max-w-md mx-auto">
                  Telecharge ton dossier PDF personnalise avec toutes les aides auxquelles tu es eligible,
                  les liens officiels et les demarches a suivre.
                </p>

                <div className="bg-secondary/30 rounded-xl p-4 text-left space-y-2">
                  <p className="text-sm text-foreground font-medium">Le dossier contient :</p>
                  <ul className="space-y-1.5">
                    {[
                      `${matchedAides.length} aides identifiees`,
                      `Cumul potentiel : ${totalPotentiel.toLocaleString('fr-FR')} €`,
                      'Liens officiels pour chaque aide',
                      'Demarches detaillees',
                      'Justificatifs a fournir',
                    ].map((item, i) => (
                      <li key={i} className="flex items-center gap-2 text-sm text-muted-foreground">
                        <CheckCircle className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>

                <Button onClick={handleDownloadPdf} className="btn-primary w-full">
                  <Download className="w-5 h-5 mr-2" />
                  Telecharger mon dossier PDF
                </Button>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* Step 4: Suivi */}
        {step === 4 && (
          <motion.div key="step4" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
            <Card className="bg-card/50 border-border">
              <CardContent className="pt-6 space-y-6 text-center">
                <BadgeCheck className="w-16 h-16 text-emerald-400 mx-auto" />
                <h2 className="text-xl font-semibold text-foreground">Suivi de tes dossiers</h2>
                <p className="text-muted-foreground text-sm">
                  Tu n'as pas encore de dossier en cours. Telecharge ton dossier PDF a l'etape precedente
                  puis fais tes demandes. Tu pourras suivre leur avancement ici.
                </p>

                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: 'En cours', value: 0, color: 'text-yellow-400' },
                    { label: 'Acceptes', value: 0, color: 'text-emerald-400' },
                    { label: 'Refuses', value: 0, color: 'text-red-400' },
                  ].map(stat => (
                    <div key={stat.label} className="bg-secondary/30 rounded-xl p-4">
                      <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
                      <p className="text-xs text-muted-foreground mt-1">{stat.label}</p>
                    </div>
                  ))}
                </div>

                <Button onClick={() => setStep(1)} variant="outline" className="w-full">
                  Refaire une recherche
                </Button>
              </CardContent>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Navigation buttons */}
      <div className="flex justify-between mt-6">
        <Button onClick={goBack} variant="outline" disabled={step === 1}>
          <ChevronLeft className="w-4 h-4 mr-1" />
          Precedent
        </Button>
        {step < 4 && (
          <Button onClick={goNext} className="btn-primary" disabled={!canProceed()}>
            Suivant
            <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        )}
      </div>
    </div>
  );
}
