import { useEffect } from 'react';
import { Hero } from '@/components/Hero';
import { AIAgents } from '@/components/AIAgents';
import { ROICalculator } from '@/components/ROICalculator';
import { Pricing } from '@/components/Pricing';
import { Contact } from '@/components/Contact';
import { Footer } from '@/components/Footer';
import { Chatbot } from '@/components/Chatbot';
import { ReferralBanner } from '@/components/influencer/ReferralBanner';
import { AnimatedStarfield } from '@/components/AnimatedStarfield';
import { useReferralTracking } from '@/hooks/useInfluencer';

export default function Index() {
  const { checkAndStoreReferral } = useReferralTracking();

  useEffect(() => {
    checkAndStoreReferral();
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Global animated starfield */}
      <AnimatedStarfield />
      
      {/* Skip link for accessibility */}
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[999] focus:bg-primary focus:text-primary-foreground focus:px-4 focus:py-2 focus:rounded-lg focus:shadow-lg">
        Aller au contenu principal
      </a>
      <ReferralBanner />
      <main id="main" className="relative z-10" role="main">
        <section id="hero" aria-label="Hero section">
          <Hero />
        </section>
        <section id="agents-section-wrapper" aria-label="AI Agents section">
          <AIAgents />
        </section>
        <section id="roi-section" aria-label="Calculateur d'économies">
          <ROICalculator />
        </section>
        <section id="pricing-section" aria-label="Tarifs">
          <Pricing />
        </section>
        <section id="contact-wrapper" aria-label="Contact">
          <Contact />
        </section>
      </main>
      <Footer />
      <Chatbot />
    </div>
  );
}
