import { motion, useInView } from 'framer-motion';
import { Star } from 'lucide-react';
import { useRef, useState, useEffect } from 'react';
import { Link } from 'react-router-dom';

const testimonials = [
  { name: 'Marie L.', role: 'E-commerce mode', stars: 5, text: "J'ai créé mon agent support en 30 secondes. Il gère 80% de mes tickets et mes clientes adorent ses conseils style.", badge: 'Agent actif depuis 3 mois' },
  { name: 'Thomas R.', role: 'Agence digitale', stars: 5, text: "Origin Forge a remplacé 3 outils que je payais 200€/mois. Mes 5 agents gèrent toutes les agences de mes clients.", badge: '5 agents déployés' },
  { name: 'Sophie D.', role: 'Agent immobilier', stars: 5, text: "Mon agent IA qualifie mes prospects pendant que je dors. J'ai doublé mes rendez-vous en un mois.", badge: '1 200 conversations/mois' },
  { name: 'Karim B.', role: 'Restaurant', stars: 5, text: "Notre ChefBot prend les réservations et recommande les plats. Les clients pensent parler à un vrai serveur.", badge: '98% de satisfaction' },
  { name: 'Claire M.', role: 'Cabinet avocat', stars: 5, text: "Mon agent juridique répond aux questions courantes de mes clients. Je me concentre sur les vrais dossiers.", badge: 'Agent actif 24/7' },
];

const stats = [
  { value: 12847, label: 'Agents créés', suffix: '+' },
  { value: 3200000, label: 'Conversations gérées', suffix: '+', display: '3.2M' },
  { value: 98.7, label: 'Taux de satisfaction', suffix: '%' },
  { value: 47, label: 'Temps moyen de création', suffix: 's' },
];

function AnimatedCounter({ target, suffix, display }: { target: number; suffix: string; display?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const isInView = useInView(ref, { once: true });
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!isInView) return;
    if (display) { setCount(target); return; }
    const duration = 2000;
    const start = performance.now();
    const animate = (now: number) => {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setCount(Math.floor(eased * target));
      if (progress < 1) requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  }, [isInView, target, display]);

  return (
    <span ref={ref} className="font-orbitron font-bold text-3xl sm:text-4xl text-accent-cyan neon-text-cyan">
      {display && isInView ? display : count.toLocaleString()}{suffix}
    </span>
  );
}

export function OriginForgeSocialProof() {
  return (
    <section className="relative py-20 overflow-hidden">
      <div className="absolute inset-0 grid-pattern opacity-15" />
      <div className="container mx-auto px-6 relative z-10">
        <motion.h2 initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="text-3xl sm:text-4xl font-orbitron font-bold text-center mb-12">
          <span className="text-foreground">Ils ont forgé leur </span>
          <span className="gradient-text">Agent IA</span>
        </motion.h2>

        {/* Testimonials carousel - horizontal scroll */}
        <div className="flex gap-5 overflow-x-auto pb-4 snap-x snap-mandatory scrollbar-hide -mx-6 px-6">
          {testimonials.map((t, i) => (
            <motion.div key={i} initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.1 }} className="futuristic-card p-6 min-w-[300px] max-w-[340px] snap-center flex-shrink-0">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-full bg-gradient-to-r from-accent-purple to-accent-pink flex items-center justify-center text-sm font-bold text-foreground">{t.name[0]}</div>
                <div>
                  <p className="font-semibold text-foreground text-sm">{t.name}</p>
                  <p className="text-xs text-muted-foreground">{t.role}</p>
                </div>
              </div>
              <div className="flex gap-0.5 mb-3">
                {Array(t.stars).fill(0).map((_, j) => <Star key={j} className="w-4 h-4 fill-yellow-400 text-yellow-400" />)}
              </div>
              <p className="text-sm text-foreground/80 leading-relaxed mb-3">"{t.text}"</p>
              <span className="inline-block px-2.5 py-1 rounded-full bg-accent-emerald/10 text-accent-emerald text-xs font-medium border border-accent-emerald/20">{t.badge}</span>
            </motion.div>
          ))}
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mt-14">
          {stats.map((s, i) => (
            <motion.div key={i} initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.1 }} className="text-center">
              <AnimatedCounter target={s.value} suffix={s.suffix} display={s.display} />
              <p className="text-muted-foreground text-sm mt-1">{s.label}</p>
            </motion.div>
          ))}
        </div>

        <motion.div initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} viewport={{ once: true }} transition={{ delay: 0.5 }} className="text-center mt-10">
          <Link to="/forge" className="btn-primary inline-flex items-center gap-2 px-6 py-3">
            Rejoins les entrepreneurs qui ont forgé leur IA →
          </Link>
        </motion.div>
      </div>
    </section>
  );
}
