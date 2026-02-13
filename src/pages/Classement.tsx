import { useState } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Trophy, Globe, Heart, BookOpen, Stethoscope, Handshake, Palette, Lightbulb, Send, Bot } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useAuth } from '@/hooks/useAuth';
import { useActiveClassement, useClassementResults, usePastClassements, useSubmitCandidature } from '@/hooks/useClassement';
import { AnimatedStarfield } from '@/components/AnimatedStarfield';
import { Footer } from '@/components/Footer';
import { toast } from 'sonner';

const CATEGORIES = [
  { value: 'environnement', label: '🌍 Environnement', icon: Globe },
  { value: 'social', label: '👥 Social', icon: Heart },
  { value: 'education', label: '📚 Éducation', icon: BookOpen },
  { value: 'sante', label: '🏥 Santé', icon: Stethoscope },
  { value: 'solidarite', label: '🤝 Solidarité', icon: Handshake },
  { value: 'culture', label: '🎨 Culture', icon: Palette },
  { value: 'innovation', label: '💡 Innovation', icon: Lightbulb },
  { value: 'autre', label: '🔧 Autre', icon: Lightbulb },
];

const REPARTITION = ['30%', '20%', '15%', '10%', '8%', '3.4%', '3.4%', '3.4%', '3.4%', '3.4%'];
const MEDALS = ['🥇', '🥈', '🥉'];

export default function Classement() {
  const { user } = useAuth();
  const { data: activeClassement } = useActiveClassement();
  const { data: results } = useClassementResults(activeClassement?.id);
  const { data: pastClassements } = usePastClassements();
  const submitMutation = useSubmitCandidature();

  const [open, setOpen] = useState(false);
  const [siteUrl, setSiteUrl] = useState('');
  const [description, setDescription] = useState('');
  const [categorie, setCategorie] = useState('');

  const handleSubmit = async () => {
    if (!activeClassement) return;
    if (!siteUrl || !description || !categorie) {
      toast.error('Veuillez remplir tous les champs.');
      return;
    }
    if (description.length < 100) {
      toast.error('La description doit contenir au moins 100 caractères.');
      return;
    }
    try {
      await submitMutation.mutateAsync({
        classement_id: activeClassement.id,
        site_url: siteUrl,
        description_impact: description,
        categorie_impact: categorie,
      });
      toast.success('Candidature enregistrée ! Résultats en fin de mois.');
      setOpen(false);
      setSiteUrl('');
      setDescription('');
      setCategorie('');
    } catch {
      toast.error('Erreur lors de la soumission. Veuillez réessayer.');
    }
  };

  // For terminated classements, show results
  const terminatedResults = activeClassement?.statut === 'termine' ? results : [];

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AnimatedStarfield />

      <nav className="fixed top-0 left-0 right-0 z-50 bg-background/80 backdrop-blur-xl border-b border-accent-cyan/20">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2">
            <Bot className="w-7 h-7 text-accent-cyan" />
            <span className="font-orbitron text-lg font-bold text-foreground">PURAMA<span className="text-accent-cyan"> AI</span></span>
          </Link>
          <div className="flex items-center gap-3">
            {user ? (
              <Link to="/dashboard"><Button size="sm" className="bg-gradient-to-r from-primary to-accent hover:opacity-90">Dashboard</Button></Link>
            ) : (
              <Link to="/signup"><Button size="sm" className="bg-gradient-to-r from-primary to-accent hover:opacity-90">S'inscrire</Button></Link>
            )}
          </div>
        </div>
      </nav>

      <main className="relative z-10 pt-24 pb-20">
        {/* Hero */}
        <section className="max-w-5xl mx-auto px-6 text-center mb-16">
          <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}>
            <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 mb-6 text-sm px-4 py-1.5">
              <Trophy className="w-4 h-4 mr-2" />
              Classement Mensuel
            </Badge>
          </motion.div>
          <motion.h1 initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="text-4xl sm:text-5xl lg:text-6xl font-orbitron font-black mb-6">
            🏆 PURAMA{' '}
            <span className="gradient-text">IMPACT</span>
          </motion.h1>
          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }} className="text-lg text-muted-foreground max-w-2xl mx-auto mb-8">
            Crée un site qui change le monde. L'IA récompense les meilleurs projets à impact positif.
          </motion.p>

          {activeClassement && activeClassement.statut === 'actif' && user && (
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
                  <Button size="lg" className="bg-gradient-to-r from-amber-500 to-orange-500 hover:opacity-90 text-white font-bold">
                    🚀 Déposer ma candidature
                  </Button>
                </motion.div>
              </DialogTrigger>
              <DialogContent className="glass-effect border-accent-cyan/20 max-w-lg">
                <DialogHeader>
                  <DialogTitle className="font-orbitron text-lg">🏆 Déposer ma candidature</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 mt-4">
                  <div>
                    <label className="text-sm font-medium text-foreground mb-1 block">URL du site *</label>
                    <Input
                      value={siteUrl}
                      onChange={e => setSiteUrl(e.target.value)}
                      placeholder="https://mon-site.purama.app"
                      className="bg-input"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-foreground mb-1 block">Catégorie d'impact *</label>
                    <Select value={categorie} onValueChange={setCategorie}>
                      <SelectTrigger className="bg-input">
                        <SelectValue placeholder="Choisir une catégorie" />
                      </SelectTrigger>
                      <SelectContent>
                        {CATEGORIES.map(c => (
                          <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-foreground mb-1 block">Décris l'impact de ton projet *</label>
                    <Textarea
                      value={description}
                      onChange={e => setDescription(e.target.value)}
                      placeholder="Mon site aide les associations locales à..."
                      rows={4}
                      maxLength={1000}
                      className="bg-input"
                    />
                    <span className="text-xs text-muted-foreground">{description.length}/1000 (min 100)</span>
                  </div>
                  <div className="flex gap-3 justify-end">
                    <Button variant="ghost" onClick={() => setOpen(false)}>Annuler</Button>
                    <Button
                      onClick={handleSubmit}
                      disabled={submitMutation.isPending}
                      className="bg-gradient-to-r from-amber-500 to-orange-500 hover:opacity-90"
                    >
                      <Send className="w-4 h-4 mr-2" />
                      {submitMutation.isPending ? 'Envoi...' : 'Soumettre'}
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          )}
        </section>

        {/* Cagnotte info */}
        {activeClassement && (
          <section className="max-w-3xl mx-auto px-6 mb-16">
            <Card className="glass-effect p-8 text-center border-amber-500/20">
              <div className="text-sm text-muted-foreground mb-2">Cagnotte du mois ({activeClassement.mois})</div>
              <div className="text-4xl font-orbitron font-black text-amber-400 mb-4">{Number(activeClassement.cagnotte || 0).toFixed(0)} €</div>
              <div className="text-xs text-muted-foreground">7% du chiffre d'affaires mensuel — Répartition sur le Top 10</div>
              <div className="flex flex-wrap justify-center gap-2 mt-4">
                {REPARTITION.map((r, i) => (
                  <Badge key={i} variant="secondary" className="text-xs">
                    {i < 3 ? MEDALS[i] : `${i + 1}e`} {r}
                  </Badge>
                ))}
              </div>
            </Card>
          </section>
        )}

        {/* Categories */}
        <section className="max-w-5xl mx-auto px-6 mb-16">
          <h2 className="font-orbitron text-2xl font-bold text-center mb-8 text-foreground">Catégories d'impact</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {CATEGORIES.map((cat, i) => (
              <motion.div key={cat.value} initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.05 }}>
                <Card className="glass-effect p-4 text-center border-border/20 hover:border-accent-cyan/30 transition-all">
                  <div className="text-2xl mb-2">{cat.label.split(' ')[0]}</div>
                  <div className="text-xs font-medium text-foreground">{cat.label.split(' ').slice(1).join(' ')}</div>
                </Card>
              </motion.div>
            ))}
          </div>
        </section>

        {/* Results / Podium */}
        {terminatedResults && terminatedResults.length > 0 && (
          <section className="max-w-4xl mx-auto px-6 mb-16">
            <h2 className="font-orbitron text-2xl font-bold text-center mb-8 text-foreground">🏆 Résultats</h2>
            <div className="space-y-3">
              {terminatedResults.map((c, i) => (
                <motion.div key={c.id} initial={{ opacity: 0, x: -20 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.05 }}>
                  <Card className={`p-4 border ${i < 3 ? 'border-amber-500/30 bg-amber-500/5' : 'border-border/20'}`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="font-orbitron font-bold text-lg w-8">{i < 3 ? MEDALS[i] : `${i + 1}`}</span>
                        <div>
                          <a href={c.site_url} target="_blank" rel="noopener noreferrer" className="text-accent-cyan hover:underline text-sm font-medium">{c.site_url}</a>
                          <div className="flex items-center gap-2 mt-0.5">
                            <Badge variant="secondary" className="text-xs">{CATEGORIES.find(cat => cat.value === c.categorie_impact)?.label || c.categorie_impact}</Badge>
                            <span className="text-xs text-muted-foreground">Score: {c.score_ia}/100</span>
                          </div>
                        </div>
                      </div>
                      <span className="font-orbitron font-bold text-amber-400">{Number(c.gains || 0).toFixed(0)} €</span>
                    </div>
                  </Card>
                </motion.div>
              ))}
            </div>
          </section>
        )}

        {/* Past classements */}
        {pastClassements && pastClassements.length > 0 && (
          <section className="max-w-4xl mx-auto px-6 mb-16">
            <h2 className="font-orbitron text-2xl font-bold text-center mb-8 text-foreground">Historique</h2>
            <div className="space-y-3">
              {pastClassements.map(cl => (
                <Card key={cl.id} className="glass-effect p-4 border-border/20">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="font-medium text-foreground">{cl.mois}</span>
                      <Badge variant="secondary" className="ml-2 text-xs">Terminé</Badge>
                    </div>
                    <span className="font-orbitron text-amber-400 font-bold">{Number(cl.cagnotte || 0).toFixed(0)} €</span>
                  </div>
                </Card>
              ))}
            </div>
          </section>
        )}

        {/* CTA */}
        {!user && (
          <section className="max-w-3xl mx-auto px-6 text-center">
            <Card className="glass-effect p-10 border-amber-500/20">
              <h2 className="font-orbitron text-2xl font-bold mb-4 text-foreground">Crée un projet à impact</h2>
              <p className="text-muted-foreground mb-6">Inscris-toi, utilise nos agents IA, et soumets ton site pour le prochain classement !</p>
              <Link to="/signup">
                <Button size="lg" className="bg-gradient-to-r from-amber-500 to-orange-500 hover:opacity-90 text-white">
                  <Trophy className="w-5 h-5 mr-2" /> Rejoindre le classement
                </Button>
              </Link>
            </Card>
          </section>
        )}
      </main>

      <Footer />
    </div>
  );
}
