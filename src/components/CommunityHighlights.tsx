import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Users, Trophy, Gift } from 'lucide-react';

const highlights = [
  {
    icon: Users,
    emoji: '🤝',
    title: 'Parrainage',
    description: 'Parraine tes amis et gagne 50% du 1er mois + 10% à vie. Débloque des paliers exclusifs !',
    link: '/parrainage',
    cta: 'Parrainer maintenant',
    gradient: 'from-[var(--accent-cyan)] to-[var(--accent-blue)]',
    glowColor: 'rgba(0, 240, 255, 0.3)',
  },
  {
    icon: Gift,
    emoji: '🎰',
    title: 'Jeux Concours',
    description: 'Chaque semaine et chaque mois, une cagnotte à remporter. Plus tu parraines, plus tu as de chances !',
    link: '/concours',
    cta: 'Voir les concours',
    gradient: 'from-[var(--accent-purple)] to-[var(--accent-pink)]',
    glowColor: 'rgba(124, 58, 237, 0.3)',
  },
  {
    icon: Trophy,
    emoji: '🏆',
    title: 'Classement Impact',
    description: "Soumets un projet à impact positif, l'IA l'évalue et les meilleurs se partagent 7% du CA.",
    link: '/classement',
    cta: 'Découvrir le classement',
    gradient: 'from-[var(--accent-pink)] to-[var(--accent-purple)]',
    glowColor: 'rgba(244, 114, 182, 0.3)',
  },
];

export function CommunityHighlights() {
  return (
    <section className="py-20 px-4 relative overflow-hidden">
      {/* Section header */}
      <motion.div
        className="text-center mb-14 max-w-3xl mx-auto"
        initial={{ opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.6 }}
      >
        <h2 className="font-orbitron gradient-text mb-4">
          Rejoins la communauté PURAMA
        </h2>
        <p className="text-muted-foreground text-lg">
          Parraine, participe aux concours et crée des projets à impact. Gagne de l'argent en contribuant à un monde meilleur.
        </p>
      </motion.div>

      {/* Cards grid */}
      <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-6">
        {highlights.map((item, i) => (
          <motion.div
            key={item.title}
            initial={{ opacity: 0, y: 40 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: i * 0.15 }}
          >
            <Link
              to={item.link}
              className="group block h-full futuristic-card p-7 text-center"
            >
              {/* Icon */}
              <div
                className={`mx-auto mb-5 w-16 h-16 rounded-2xl bg-gradient-to-br ${item.gradient} flex items-center justify-center text-3xl transition-transform duration-300 group-hover:scale-110`}
                style={{ boxShadow: `0 0 25px ${item.glowColor}` }}
              >
                {item.emoji}
              </div>

              <h3 className="font-orbitron text-foreground text-xl mb-3">
                {item.title}
              </h3>
              <p className="text-muted-foreground text-sm leading-relaxed mb-5">
                {item.description}
              </p>

              <span className="inline-block text-primary font-semibold text-sm group-hover:underline">
                {item.cta} →
              </span>
            </Link>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
