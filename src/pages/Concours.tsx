import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Trophy, Clock, Users, Ticket, Gift, Bot, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { useAuth } from '@/hooks/useAuth';
import { useActiveConcours, usePastConcours, useMyParticipations } from '@/hooks/useConcours';
import { AnimatedStarfield } from '@/components/AnimatedStarfield';
import { Footer } from '@/components/Footer';

function Countdown({ targetDate }: { targetDate: string }) {
  const [timeLeft, setTimeLeft] = useState({ days: 0, hours: 0, minutes: 0, seconds: 0 });

  useEffect(() => {
    const calc = () => {
      const diff = new Date(targetDate).getTime() - Date.now();
      if (diff <= 0) return { days: 0, hours: 0, minutes: 0, seconds: 0 };
      return {
        days: Math.floor(diff / 86400000),
        hours: Math.floor((diff % 86400000) / 3600000),
        minutes: Math.floor((diff % 3600000) / 60000),
        seconds: Math.floor((diff % 60000) / 1000),
      };
    };
    setTimeLeft(calc());
    const id = setInterval(() => setTimeLeft(calc()), 1000);
    return () => clearInterval(id);
  }, [targetDate]);

  return (
    <div className="flex gap-2 justify-center">
      {Object.entries(timeLeft).map(([key, val]) => (
        <div key={key} className="bg-secondary/60 rounded-lg px-3 py-2 text-center min-w-[56px]">
          <div className="font-orbitron text-xl font-bold text-accent-cyan">{String(val).padStart(2, '0')}</div>
          <div className="text-[10px] text-muted-foreground uppercase">{key === 'days' ? 'Jours' : key === 'hours' ? 'Heures' : key === 'minutes' ? 'Min' : 'Sec'}</div>
        </div>
      ))}
    </div>
  );
}

export default function Concours() {
  const { user } = useAuth();
  const { data: activeConcours } = useActiveConcours();
  const { data: pastConcours } = usePastConcours();
  const { data: myParticipations } = useMyParticipations();

  const semaine = activeConcours?.find(c => c.type === 'semaine');
  const mois = activeConcours?.find(c => c.type === 'mois');

  const getMyPlaces = (concoursId?: string) => {
    if (!concoursId || !myParticipations) return 0;
    return myParticipations.filter(p => p.concours_id === concoursId).reduce((sum, p) => sum + (p.nombre_places || 0), 0);
  };

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
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
            <Badge className="bg-accent-pink/20 text-accent-pink border-accent-pink/30 mb-6 text-sm px-4 py-1.5">
              <Gift className="w-4 h-4 mr-2" />
              Jeux Concours
            </Badge>
          </motion.div>
          <motion.h1 initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="text-4xl sm:text-5xl lg:text-6xl font-orbitron font-black mb-6">
            🎰 Jeux Concours{' '}
            <span className="gradient-text">PURAMA</span>
          </motion.h1>
          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }} className="text-lg text-muted-foreground max-w-2xl mx-auto">
            Chaque semaine et chaque mois, des gains à remporter ! Plus tu parraines, plus tu as de chances de gagner.
          </motion.p>
        </section>

        {/* Active contests */}
        <section className="max-w-5xl mx-auto px-6 mb-16">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Weekly */}
            <motion.div initial={{ opacity: 0, x: -30 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.3 }}>
              <Card className="glass-effect border-accent-cyan/20 p-6 h-full">
                <div className="flex items-center gap-2 mb-4">
                  <Clock className="w-5 h-5 text-accent-cyan" />
                  <h2 className="font-orbitron text-lg font-bold text-foreground">Concours de la Semaine</h2>
                </div>
                {semaine ? (
                  <>
                    <Countdown targetDate={semaine.date_fin} />
                    <div className="mt-6 text-center">
                      <div className="text-3xl font-orbitron font-black text-accent-cyan mb-1">{Number(semaine.cagnotte || 0).toFixed(0)} €</div>
                      <div className="text-sm text-muted-foreground">Cagnotte</div>
                    </div>
                    {user && (
                      <div className="mt-4 p-3 bg-secondary/30 rounded-lg text-center">
                        <div className="flex items-center justify-center gap-2">
                          <Ticket className="w-4 h-4 text-accent-purple" />
                          <span className="text-sm text-foreground">Tes places : <strong className="text-accent-cyan">{getMyPlaces(semaine.id)}</strong></span>
                        </div>
                      </div>
                    )}
                    <div className="mt-4 text-xs text-center text-muted-foreground">
                      🏆 1 gagnant — 100% de la cagnotte
                    </div>
                  </>
                ) : (
                  <div className="text-center py-8">
                    <div className="text-muted-foreground text-sm">Aucun concours en cours cette semaine.</div>
                    <p className="text-xs text-muted-foreground mt-2">Parraine des amis pour gagner des places !</p>
                  </div>
                )}
              </Card>
            </motion.div>

            {/* Monthly */}
            <motion.div initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.4 }}>
              <Card className="glass-effect border-accent-purple/20 p-6 h-full">
                <div className="flex items-center gap-2 mb-4">
                  <Trophy className="w-5 h-5 text-accent-purple" />
                  <h2 className="font-orbitron text-lg font-bold text-foreground">Concours du Mois</h2>
                </div>
                {mois ? (
                  <>
                    <Countdown targetDate={mois.date_fin} />
                    <div className="mt-6 text-center">
                      <div className="text-3xl font-orbitron font-black text-accent-purple mb-1">{Number(mois.cagnotte || 0).toFixed(0)} €</div>
                      <div className="text-sm text-muted-foreground">Cagnotte</div>
                    </div>
                    <div className="mt-4 flex justify-center gap-4 text-sm">
                      <span>🥇 60%</span>
                      <span>🥈 25%</span>
                      <span>🥉 15%</span>
                    </div>
                    {user && (
                      <div className="mt-4 p-3 bg-secondary/30 rounded-lg text-center">
                        <div className="flex items-center justify-center gap-2">
                          <Ticket className="w-4 h-4 text-accent-purple" />
                          <span className="text-sm text-foreground">Tes places : <strong className="text-accent-purple">{getMyPlaces(mois.id)}</strong></span>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-center py-8">
                    <div className="text-muted-foreground text-sm">Aucun concours mensuel en cours.</div>
                    <p className="text-xs text-muted-foreground mt-2">Le prochain commence bientôt !</p>
                  </div>
                )}
              </Card>
            </motion.div>
          </div>
        </section>

        {/* How to get tickets */}
        <section className="max-w-4xl mx-auto px-6 mb-16">
          <h2 className="font-orbitron text-2xl font-bold text-center mb-8 text-foreground">Comment gagner des places</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {[
              { icon: '🤝', title: 'Parraine un ami', desc: '+1 place semaine + 1 place mois (parrain ET filleul)', badge: '+2 places' },
              { icon: '✍️', title: "Inscris-toi", desc: '+1 place semaine + 1 place mois offerte à l\'inscription', badge: '+2 places' },
            ].map((item, i) => (
              <motion.div key={i} initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.1 }}>
                <Card className="glass-effect p-6 border-accent-cyan/10 h-full">
                  <div className="flex items-start gap-4">
                    <div className="text-3xl">{item.icon}</div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-bold text-foreground">{item.title}</h3>
                        <Badge className="bg-accent-cyan/20 text-accent-cyan border-accent-cyan/30 text-xs">{item.badge}</Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">{item.desc}</p>
                    </div>
                  </div>
                </Card>
              </motion.div>
            ))}
          </div>
        </section>

        {/* Past winners */}
        {pastConcours && pastConcours.length > 0 && (
          <section className="max-w-4xl mx-auto px-6 mb-16">
            <h2 className="font-orbitron text-2xl font-bold text-center mb-8 text-foreground">Derniers gagnants</h2>
            <div className="space-y-3">
              {pastConcours.map((c, i) => {
                const gagnants = Array.isArray(c.gagnants) ? c.gagnants : [];
                return (
                  <Card key={c.id} className="glass-effect p-4 border-border/20">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Badge variant="secondary">{c.type === 'semaine' ? '📅 Semaine' : '📆 Mois'}</Badge>
                        <span className="font-medium text-foreground">{c.titre}</span>
                      </div>
                      <span className="text-accent-cyan font-orbitron font-bold">{Number(c.cagnotte || 0).toFixed(0)} €</span>
                    </div>
                    {gagnants.length > 0 && (
                      <div className="mt-2 text-xs text-muted-foreground">
                        {gagnants.length} gagnant{gagnants.length > 1 ? 's' : ''}
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          </section>
        )}

        {/* CTA */}
        {!user && (
          <section className="max-w-3xl mx-auto px-6 text-center">
            <Card className="glass-effect p-10 border-accent-pink/20">
              <h2 className="font-orbitron text-2xl font-bold mb-4 text-foreground">Participe aux concours</h2>
              <p className="text-muted-foreground mb-6">Inscris-toi gratuitement et reçois automatiquement 2 places pour les prochains tirages !</p>
              <Link to="/signup">
                <Button size="lg" className="bg-gradient-to-r from-accent-pink to-accent-purple hover:opacity-90">
                  <Star className="w-5 h-5 mr-2" /> S'inscrire et participer
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
