import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Calculator, Receipt, CreditCard, TrendingUp, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

const highlights = [
  { icon: Calculator, title: 'Saisie IA', desc: 'OCR + IA pour une saisie automatique en < 3 secondes' },
  { icon: Receipt, title: 'Facturation', desc: 'Factures, devis et relances automatiques conformes' },
  { icon: CreditCard, title: 'Banque', desc: 'Rapprochement bancaire multi-banques en temps réel' },
  { icon: TrendingUp, title: 'Pilotage', desc: 'Tableaux de bord financiers et prévisions IA' },
];

export function PuramaComptaSection() {
  return (
    <div className="relative py-24 overflow-hidden">
      <div className="container mx-auto px-6 sm:px-8 lg:px-12">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          {/* Left - Text */}
          <motion.div
            initial={{ opacity: 0, x: -30 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.8 }}
          >
            <div className="inline-flex items-center gap-2 glass-effect px-4 py-2 rounded-full mb-6">
              <Calculator className="w-4 h-4 text-accent-cyan" />
              <span className="text-sm font-space text-accent-cyan">Nouveau</span>
            </div>
            <h2 className="text-3xl sm:text-4xl lg:text-5xl font-orbitron font-bold mb-6">
              <span className="gradient-text">Purama Compta</span>
              <br />
              <span className="text-foreground text-2xl sm:text-3xl">Votre DAF Virtuel IA</span>
            </h2>
            <p className="text-muted-foreground font-space text-lg leading-relaxed mb-8">
              Automatisez 80% de votre comptabilité grâce à l'IA. Saisie OCR, rapprochement bancaire, déclarations fiscales et pilotage financier — tout-en-un.
            </p>
            <Link to="/purama-compta">
              <Button className="btn-primary text-lg px-8 py-4 group">
                Découvrir Purama Compta
                <ArrowRight className="w-5 h-5 ml-2 group-hover:translate-x-1 transition-transform" />
              </Button>
            </Link>
          </motion.div>

          {/* Right - Feature cards */}
          <motion.div
            className="grid grid-cols-1 sm:grid-cols-2 gap-4"
            initial={{ opacity: 0, x: 30 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.8, delay: 0.2 }}
          >
            {highlights.map((item, i) => (
              <motion.div
                key={i}
                className="futuristic-card p-6 group"
                whileHover={{ y: -6, scale: 1.03 }}
                transition={{ duration: 0.3 }}
              >
                <div className="w-10 h-10 rounded-lg bg-accent-cyan/10 flex items-center justify-center mb-3 group-hover:scale-110 transition-transform">
                  <item.icon className="w-5 h-5 text-accent-cyan" />
                </div>
                <h3 className="font-orbitron font-semibold text-foreground mb-1">{item.title}</h3>
                <p className="text-sm text-muted-foreground font-space">{item.desc}</p>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </div>
    </div>
  );
}
