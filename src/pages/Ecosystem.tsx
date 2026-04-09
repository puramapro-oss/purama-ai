import { motion } from 'framer-motion';
import { Globe, ArrowRight, Copy, Scale, TrendingUp, PiggyBank, Brain, Sparkles } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useCrossPromos } from '@/hooks/useFaq';
import { toast } from 'sonner';
import { AnimatedStarfield } from '@/components/AnimatedStarfield';
import { Footer } from '@/components/Footer';

const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  visible: (i: number) => ({ opacity: 1, y: 0, transition: { delay: i * 0.1, duration: 0.6 } }),
};

const iconMap: Record<string, typeof Scale> = {
  Scale,
  TrendingUp,
  PiggyBank,
  Brain,
  Sparkles,
};

const PURAMA_APPS = [
  { slug: 'purama_ai', name: 'Purama AI', description: 'Agents IA autonomes pour automatiser ton business', color: '#8B5CF6', url: 'https://purama-ai.purama.dev' },
  { slug: 'jurispurama', name: 'JurisPurama', description: 'Assistant juridique IA — contrats, veille, recouvrement', color: '#6D28D9', url: 'https://jurispurama.purama.dev' },
  { slug: 'midas', name: 'MIDAS', description: 'Trading IA — analyses de marché et signaux automatisés', color: '#F59E0B', url: 'https://midas.purama.dev' },
  { slug: 'kash', name: 'KASH', description: 'Épargne intelligente — optimise et automatise ton épargne', color: '#F59E0B', url: 'https://kash.purama.dev' },
  { slug: 'akasha', name: 'AKASHA', description: 'Multi-expert IA — recherche, analyse et création', color: '#00d4ff', url: 'https://akasha.purama.dev' },
  { slug: 'kaia', name: 'KAÏA', description: 'Bien-être mental — méditation guidée par IA', color: '#06B6D4', url: 'https://kaia.purama.dev' },
  { slug: 'vida', name: 'VIDA', description: 'Santé connectée — suivi et conseils personnalisés', color: '#10B981', url: 'https://vida.purama.dev' },
  { slug: 'prana', name: 'PRANA', description: 'Coach sportif IA — programmes et suivi fitness', color: '#F472B6', url: 'https://prana.purama.dev' },
  { slug: 'lingora', name: 'Lingora', description: 'Apprends les langues avec un tuteur IA natif', color: '#3B82F6', url: 'https://lingora.purama.dev' },
  { slug: 'sutra', name: 'SUTRA', description: 'Production vidéo IA — scénarios et storyboards', color: '#8B5CF6', url: 'https://sutra.purama.dev' },
  { slug: 'exodus', name: 'EXODUS', description: 'Développement personnel et bien-être quotidien', color: '#22C55E', url: 'https://exodus.purama.dev' },
  { slug: 'lumios', name: 'LUMIOS', description: 'Consultant IA pour entrepreneurs et freelances', color: '#14B8A6', url: 'https://lumios.purama.dev' },
];

export default function Ecosystem() {
  const { data: promos = [] } = useCrossPromos();

  const copyCoupon = () => {
    navigator.clipboard.writeText('CROSS50');
    toast.success('Code CROSS50 copié ! -50% sur toutes les apps Purama');
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AnimatedStarfield />

      {/* Nav */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-background/80 backdrop-blur-xl border-b border-accent-cyan/20">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <a href="/" className="font-orbitron font-bold text-foreground">
            PURAMA <span className="text-accent-cyan">AI</span>
          </a>
          <a href="/dashboard">
            <Button variant="outline" size="sm">Dashboard</Button>
          </a>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-6 pt-28 pb-16">
        {/* Hero */}
        <motion.div initial="hidden" animate="visible" variants={fadeUp} custom={0} className="text-center mb-16">
          <Badge className="bg-accent-cyan/20 text-accent-cyan mb-4">Écosystème Purama</Badge>
          <h1 className="text-4xl md:text-5xl font-orbitron font-bold text-foreground mb-4">
            Un univers d'apps <span className="text-transparent bg-clip-text bg-gradient-to-r from-accent-purple to-accent-cyan">propulsées par l'IA</span>
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            Chaque app Purama est un expert IA dans son domaine. Un seul compte, des possibilités infinies.
          </p>
        </motion.div>

        {/* Cross-promo coupon */}
        <motion.div variants={fadeUp} initial="hidden" animate="visible" custom={1} className="mb-12">
          <Card className="bg-gradient-to-r from-accent-purple/10 to-accent-cyan/10 border-accent-purple/20">
            <CardContent className="pt-6 flex flex-col md:flex-row items-center justify-between gap-4">
              <div>
                <h3 className="text-xl font-bold text-foreground">-50% sur toutes les apps</h3>
                <p className="text-muted-foreground">Utilise le code CROSS50 pour -50% sur ton 1er mois sur n'importe quelle app Purama</p>
              </div>
              <Button onClick={copyCoupon} className="bg-gradient-to-r from-accent-purple to-accent-cyan shrink-0">
                <Copy className="w-4 h-4 mr-2" />
                Copier CROSS50
              </Button>
            </CardContent>
          </Card>
        </motion.div>

        {/* Apps grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {PURAMA_APPS.map((app, i) => (
            <motion.div key={app.slug} variants={fadeUp} initial="hidden" animate="visible" custom={i + 2}>
              <Card className="bg-card/50 backdrop-blur border-border hover:border-white/10 transition-all group h-full">
                <CardContent className="pt-6 flex flex-col h-full">
                  <div className="flex items-center gap-3 mb-3">
                    <div
                      className="w-10 h-10 rounded-xl flex items-center justify-center font-orbitron font-bold text-sm"
                      style={{ backgroundColor: `${app.color}20`, color: app.color }}
                    >
                      {app.name[0]}
                    </div>
                    <div>
                      <h3 className="font-bold text-foreground">{app.name}</h3>
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground flex-1">{app.description}</p>
                  <a href={app.url} target="_blank" rel="noopener noreferrer" className="mt-4 inline-block">
                    <Button variant="ghost" size="sm" className="text-accent-cyan group-hover:text-foreground transition-colors">
                      Découvrir <ArrowRight className="w-4 h-4 ml-1" />
                    </Button>
                  </a>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      </div>

      <Footer />
    </div>
  );
}
