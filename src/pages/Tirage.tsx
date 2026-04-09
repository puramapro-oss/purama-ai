import { motion } from 'framer-motion';
import { Ticket, Trophy, Calendar, Users, Gift, Clock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useCurrentDraw, useMyTickets, usePastDraws } from '@/hooks/useLottery';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';

const fadeUp = {
  hidden: { opacity: 0, y: 20 },
  visible: (i: number) => ({ opacity: 1, y: 0, transition: { delay: i * 0.08, duration: 0.5 } }),
};

const TICKET_SOURCES = [
  { source: 'Inscription', tickets: '+1', icon: Users },
  { source: 'Parrainage', tickets: '+2', icon: Gift },
  { source: 'Mission complétée', tickets: '+1', icon: Trophy },
  { source: 'Partage social', tickets: '+1', icon: Users },
  { source: 'Avis store', tickets: '+3', icon: Trophy },
  { source: 'Challenge gagné', tickets: '+2', icon: Trophy },
  { source: 'Streak 7j', tickets: '+1', icon: Clock },
  { source: 'Streak 30j', tickets: '+5', icon: Clock },
  { source: 'Abonnement actif', tickets: '+5/mois', icon: Ticket },
  { source: '500 points', tickets: '= 1 ticket', icon: Ticket },
];

const PRIZE_DISTRIBUTION = [
  { rank: '1er', percent: '1,2%' },
  { rank: '2ème', percent: '0,8%' },
  { rank: '3ème', percent: '0,6%' },
  { rank: '4ème', percent: '0,4%' },
  { rank: '5-10ème', percent: '1% total' },
];

export default function Tirage() {
  const { data: currentDraw } = useCurrentDraw();
  const { data: myTickets = [] } = useMyTickets(currentDraw?.id);
  const { data: pastDraws = [] } = usePastDraws();

  const drawDate = currentDraw?.draw_date
    ? format(new Date(currentDraw.draw_date), 'dd MMMM yyyy', { locale: fr })
    : 'Prochain tirage à venir';

  return (
    <div className="space-y-6">
      <motion.div initial="hidden" animate="visible" variants={fadeUp} custom={0}>
        <h1 className="text-2xl font-orbitron font-bold text-foreground flex items-center gap-3">
          <Ticket className="w-7 h-7 text-accent-pink" />
          Tirage mensuel
        </h1>
        <p className="text-muted-foreground mt-1">10 gagnants chaque mois — 4% du CA redistribué</p>
      </motion.div>

      {/* Current draw */}
      <motion.div variants={fadeUp} initial="hidden" animate="visible" custom={1}>
        <Card className="bg-gradient-to-br from-accent-purple/10 via-accent-pink/5 to-accent-cyan/10 border-accent-purple/20">
          <CardContent className="pt-6">
            <div className="flex flex-col md:flex-row items-center justify-between gap-4">
              <div>
                <h2 className="text-xl font-bold text-foreground">Prochain tirage</h2>
                <p className="text-accent-cyan font-orbitron mt-1">{drawDate}</p>
                {currentDraw?.pool_amount && (
                  <p className="text-sm text-muted-foreground mt-1">
                    Cagnotte : <span className="text-green-400 font-bold">{Number(currentDraw.pool_amount).toFixed(2)}€</span>
                  </p>
                )}
              </div>
              <div className="text-center">
                <div className="w-24 h-24 rounded-2xl bg-accent-pink/10 border border-accent-pink/20 flex flex-col items-center justify-center">
                  <Ticket className="w-8 h-8 text-accent-pink mb-1" />
                  <span className="text-2xl font-bold font-orbitron text-foreground">{myTickets.length}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">Mes tickets</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* How to get tickets */}
      <motion.div variants={fadeUp} initial="hidden" animate="visible" custom={2}>
        <Card className="bg-card/50 backdrop-blur border-border">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Gift className="w-5 h-5 text-accent-cyan" />
              Comment gagner des tickets
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {TICKET_SOURCES.map((source) => (
                <div key={source.source} className="flex items-center justify-between p-3 rounded-lg bg-secondary/20">
                  <div className="flex items-center gap-2">
                    <source.icon className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm text-foreground">{source.source}</span>
                  </div>
                  <Badge className="bg-accent-pink/20 text-accent-pink">{source.tickets}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Prize distribution */}
      <motion.div variants={fadeUp} initial="hidden" animate="visible" custom={3}>
        <Card className="bg-card/50 backdrop-blur border-border">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Trophy className="w-5 h-5 text-yellow-400" />
              Répartition des gains
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {PRIZE_DISTRIBUTION.map((prize) => (
                <div key={prize.rank} className="flex items-center justify-between p-3 rounded-lg bg-secondary/20">
                  <span className="text-sm font-medium text-foreground">{prize.rank}</span>
                  <span className="text-sm text-accent-cyan font-mono">{prize.percent} du CA</span>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Les gains sont automatiquement versés sur le wallet des gagnants.
            </p>
          </CardContent>
        </Card>
      </motion.div>

      {/* Past draws */}
      {pastDraws.length > 0 && (
        <motion.div variants={fadeUp} initial="hidden" animate="visible" custom={4}>
          <Card className="bg-card/50 backdrop-blur border-border">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Calendar className="w-5 h-5 text-muted-foreground" />
                Tirages passés
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {pastDraws.map((draw) => (
                  <div key={draw.id} className="flex items-center justify-between p-3 rounded-lg bg-secondary/20">
                    <span className="text-sm text-foreground">
                      {format(new Date(draw.draw_date), 'MMMM yyyy', { locale: fr })}
                    </span>
                    <span className="text-sm text-green-400 font-mono">
                      {Number(draw.pool_amount || 0).toFixed(2)}€ distribués
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}
    </div>
  );
}
