import { useState } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Copy, Link2, Share2, Users, Gift, Trophy, ArrowRight, Check, Lock, ChevronDown, ChevronUp, Bot } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { useAuth } from '@/hooks/useAuth';
import { useReferralProfile, useMyReferrals, useMyReferralCommissions, PALIERS } from '@/hooks/useReferral';
import { AnimatedStarfield } from '@/components/AnimatedStarfield';
import { Footer } from '@/components/Footer';
import { toast } from 'sonner';

const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  visible: (i: number) => ({ opacity: 1, y: 0, transition: { delay: i * 0.1, duration: 0.6 } }),
};

export default function Parrainage() {
  const { user } = useAuth();
  const { data: profile } = useReferralProfile();
  const { data: referrals } = useMyReferrals();
  const { data: commissions } = useMyReferralCommissions();
  const [faqOpen, setFaqOpen] = useState<number | null>(null);

  const code = profile?.code_parrainage || 'PURAMA-XXXXXXXX';
  const link = `${window.location.origin}/signup?ref=${code}`;
  const nbFilleuls = profile?.nombre_filleuls || 0;
  const totalGains = profile?.gains_totaux || 0;

  const totalCommissions = commissions?.reduce((sum, c) => sum + Number(c.montant || 0), 0) || 0;
  const pendingCommissions = commissions?.filter(c => c.statut === 'en_attente').reduce((sum, c) => sum + Number(c.montant || 0), 0) || 0;

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast.success(`${label} copié !`);
  };

  const currentPalierIndex = PALIERS.findIndex(p => p.filleuls > nbFilleuls);
  const nextPalier = PALIERS[currentPalierIndex] || PALIERS[PALIERS.length - 1];
  const progressToNext = currentPalierIndex >= 0
    ? (nbFilleuls / nextPalier.filleuls) * 100
    : 100;

  const faqs = [
    { q: 'Combien je gagne par filleul ?', a: '50% du 1er mois + 10% à vie sur chaque abonnement actif.' },
    { q: 'Comment mon filleul utilise le code ?', a: "À l'inscription via le lien de parrainage ou en entrant le code manuellement." },
    { q: 'Quand suis-je payé ?', a: 'Chaque mois par virement, dès que vous atteignez 50€ de commissions.' },
    { q: "Y a-t-il une limite de filleuls ?", a: 'Non, parrainez autant que vous voulez !' },
    { q: "Les places de concours s'accumulent ?", a: 'Oui, chaque parrainage ajoute des places de façon permanente.' },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AnimatedStarfield />

      {/* Navbar mini */}
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
        <section className="max-w-5xl mx-auto px-6 text-center mb-20">
          <motion.div initial="hidden" animate="visible" variants={fadeUp} custom={0}>
            <Badge className="bg-accent-purple/20 text-accent-purple border-accent-purple/30 mb-6 text-sm px-4 py-1.5">
              <Gift className="w-4 h-4 mr-2" />
              Programme de Parrainage
            </Badge>
          </motion.div>
          <motion.h1 variants={fadeUp} custom={1} initial="hidden" animate="visible" className="text-4xl sm:text-5xl lg:text-6xl font-orbitron font-black mb-6">
            Parraine tes amis,{' '}
            <span className="gradient-text">gagne de l'argent</span> 💰
          </motion.h1>
          <motion.p variants={fadeUp} custom={2} initial="hidden" animate="visible" className="text-lg text-muted-foreground max-w-2xl mx-auto mb-10">
            50% du 1er mois + 10% à vie sur chaque filleul abonné. Plus tu parraines, plus tu gagnes !
          </motion.p>
        </section>

        {/* Mon code */}
        {user && (
          <motion.section initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }} className="max-w-3xl mx-auto px-6 mb-16">
            <Card className="glass-effect p-8 text-center border-accent-cyan/20">
              <h2 className="font-orbitron text-xl font-bold mb-6 text-foreground">Mon code parrainage</h2>
              <div className="bg-secondary/50 rounded-xl p-6 mb-6 border border-accent-cyan/10">
                <span className="font-orbitron text-2xl sm:text-3xl font-black text-accent-cyan tracking-wider">{code}</span>
              </div>
              <div className="flex flex-wrap justify-center gap-3 mb-6">
                <Button onClick={() => copyToClipboard(code, 'Code')} variant="outline" className="border-accent-cyan/30 hover:bg-accent-cyan/10">
                  <Copy className="w-4 h-4 mr-2" /> Copier le code
                </Button>
                <Button onClick={() => copyToClipboard(link, 'Lien')} variant="outline" className="border-accent-purple/30 hover:bg-accent-purple/10">
                  <Link2 className="w-4 h-4 mr-2" /> Copier le lien
                </Button>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                {[
                  { label: 'WhatsApp', url: `https://wa.me/?text=${encodeURIComponent(`Rejoins PURAMA AI avec -50% sur ton 1er mois ! ${link}`)}`, color: 'bg-green-600' },
                  { label: 'Twitter', url: `https://twitter.com/intent/tweet?text=${encodeURIComponent(`Découvrez PURAMA AI ! -50% avec mon code : ${code} ${link}`)}`, color: 'bg-blue-500' },
                  { label: 'Email', url: `mailto:?subject=${encodeURIComponent('PURAMA AI - 50% de réduction')}&body=${encodeURIComponent(`Salut ! Utilise mon code ${code} pour -50% sur ton 1er mois : ${link}`)}`, color: 'bg-orange-500' },
                ].map(s => (
                  <a key={s.label} href={s.url} target="_blank" rel="noopener noreferrer">
                    <Button size="sm" className={`${s.color} hover:opacity-80 text-white`}>
                      <Share2 className="w-3 h-3 mr-1" /> {s.label}
                    </Button>
                  </a>
                ))}
              </div>
            </Card>
          </motion.section>
        )}

        {/* Stats */}
        {user && (
          <section className="max-w-4xl mx-auto px-6 mb-16">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[
                { label: 'Total gagné', value: `${totalGains.toFixed(2)} €`, icon: '💰' },
                { label: 'Filleuls', value: nbFilleuls.toString(), icon: '👥' },
                { label: 'En attente', value: `${pendingCommissions.toFixed(2)} €`, icon: '⏳' },
              ].map((stat, i) => (
                <motion.div key={i} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 + i * 0.1 }}>
                  <Card className="glass-effect p-6 text-center border-accent-cyan/10">
                    <div className="text-3xl mb-2">{stat.icon}</div>
                    <div className="text-2xl font-orbitron font-bold text-accent-cyan">{stat.value}</div>
                    <div className="text-sm text-muted-foreground mt-1">{stat.label}</div>
                  </Card>
                </motion.div>
              ))}
            </div>
          </section>
        )}

        {/* Paliers */}
        <section className="max-w-5xl mx-auto px-6 mb-16">
          <h2 className="font-orbitron text-2xl font-bold text-center mb-8 text-foreground">Paliers de récompenses</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {PALIERS.map((p, i) => {
              const unlocked = nbFilleuls >= p.filleuls;
              return (
                <motion.div key={i} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.1 * i }}>
                  <Card className={`p-5 border transition-all duration-300 ${unlocked ? 'border-accent-cyan/50 bg-accent-cyan/5 shadow-lg shadow-accent-cyan/10' : 'border-border/30 bg-card/50 opacity-60'}`}>
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-lg font-bold">{p.nom}</span>
                      {unlocked ? <Check className="w-5 h-5 text-accent-cyan" /> : <Lock className="w-4 h-4 text-muted-foreground" />}
                    </div>
                    <div className="text-sm text-muted-foreground mb-3">{p.filleuls} filleuls</div>
                    <p className="text-xs text-foreground/80">{p.prime}</p>
                    {!unlocked && (
                      <div className="mt-3">
                        <Progress value={Math.min((nbFilleuls / p.filleuls) * 100, 100)} className="h-1.5" />
                        <span className="text-xs text-muted-foreground mt-1 block">{nbFilleuls}/{p.filleuls}</span>
                      </div>
                    )}
                  </Card>
                </motion.div>
              );
            })}
          </div>
        </section>

        {/* How it works */}
        <section className="max-w-4xl mx-auto px-6 mb-16">
          <h2 className="font-orbitron text-2xl font-bold text-center mb-10 text-foreground">Comment ça marche</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {[
              { icon: '📤', title: 'Partage ton code', desc: 'Envoie ton code unique à tes amis par email, WhatsApp ou réseaux sociaux.' },
              { icon: '👥', title: "Tes amis s'inscrivent", desc: "Ils bénéficient de -50% sur leur 1er mois d'abonnement." },
              { icon: '💰', title: "Tu gagnes de l'argent", desc: "50% du 1er mois + 10% à vie tant qu'ils sont abonnés." },
            ].map((step, i) => (
              <motion.div key={i} initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.15 }}>
                <Card className="glass-effect p-6 text-center border-accent-cyan/10 h-full">
                  <div className="text-4xl mb-4">{step.icon}</div>
                  <h3 className="font-orbitron font-bold text-lg mb-2 text-foreground">{step.title}</h3>
                  <p className="text-sm text-muted-foreground">{step.desc}</p>
                </Card>
              </motion.div>
            ))}
          </div>
        </section>

        {/* Filleuls list */}
        {user && referrals && referrals.length > 0 && (
          <section className="max-w-4xl mx-auto px-6 mb-16">
            <h2 className="font-orbitron text-2xl font-bold text-center mb-8 text-foreground">Mes filleuls</h2>
            <Card className="glass-effect border-accent-cyan/10 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/30 text-muted-foreground">
                      <th className="p-4 text-left">Email</th>
                      <th className="p-4 text-left">Statut</th>
                      <th className="p-4 text-right">Commission</th>
                    </tr>
                  </thead>
                  <tbody>
                    {referrals.map(r => (
                      <tr key={r.id} className="border-b border-border/10">
                        <td className="p-4 text-foreground">{r.filleul_email ? `${r.filleul_email.slice(0, 3)}***@***` : '—'}</td>
                        <td className="p-4">
                          <Badge variant={r.statut === 'abonne' ? 'default' : 'secondary'} className={r.statut === 'abonne' ? 'bg-accent-cyan/20 text-accent-cyan' : ''}>
                            {r.statut === 'abonne' ? 'Abonné' : r.statut === 'inscrit' ? 'Inscrit' : 'En attente'}
                          </Badge>
                        </td>
                        <td className="p-4 text-right text-accent-cyan font-mono">{Number(r.commission_premier_mois || 0).toFixed(2)} €</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </section>
        )}

        {/* FAQ */}
        <section className="max-w-3xl mx-auto px-6 mb-16">
          <h2 className="font-orbitron text-2xl font-bold text-center mb-8 text-foreground">Questions fréquentes</h2>
          <div className="space-y-3">
            {faqs.map((faq, i) => (
              <Card key={i} className="glass-effect border-border/20 overflow-hidden cursor-pointer" onClick={() => setFaqOpen(faqOpen === i ? null : i)}>
                <div className="p-4 flex items-center justify-between">
                  <span className="font-medium text-foreground">{faq.q}</span>
                  {faqOpen === i ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                </div>
                {faqOpen === i && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} className="px-4 pb-4 text-sm text-muted-foreground">
                    {faq.a}
                  </motion.div>
                )}
              </Card>
            ))}
          </div>
        </section>

        {/* CTA */}
        {!user && (
          <section className="max-w-3xl mx-auto px-6 text-center">
            <Card className="glass-effect p-10 border-accent-cyan/20">
              <h2 className="font-orbitron text-2xl font-bold mb-4 text-foreground">Prêt à gagner ?</h2>
              <p className="text-muted-foreground mb-6">Inscrivez-vous et commencez à parrainer dès maintenant !</p>
              <Link to="/signup">
                <Button size="lg" className="bg-gradient-to-r from-primary to-accent hover:opacity-90">
                  <Users className="w-5 h-5 mr-2" /> S'inscrire gratuitement
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
