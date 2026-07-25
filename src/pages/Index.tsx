import { useEffect } from 'react';
import { Hero } from '@/components/Hero';
import { AIAgents } from '@/components/AIAgents';
import { OriginForgeHero } from '@/components/OriginForgeHero';
import { OriginForgeDemo } from '@/components/OriginForgeDemo';
import { CommunityHighlights } from '@/components/CommunityHighlights';
import { ROICalculator } from '@/components/ROICalculator';
import { PricingSection } from '@/components/PricingSection';
import { Contact } from '@/components/Contact';
import { PuramaComptaSection } from '@/components/PuramaComptaSection';
import { Footer } from '@/components/Footer';
import { Chatbot } from '@/components/Chatbot';
import { ReferralBanner } from '@/components/influencer/ReferralBanner';
import { useReferralTracking } from '@/hooks/useInfluencer';

export default function Index() {
  const { checkAndStoreReferral } = useReferralTracking();

  useEffect(() => {
    checkAndStoreReferral();
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[999] focus:bg-primary focus:text-primary-foreground focus:px-4 focus:py-2 focus:rounded-lg focus:shadow-lg">
        Aller au contenu principal
      </a>
      <ReferralBanner />
      <main id="main" className="relative z-10" role="main">
        <section id="hero" aria-label="Hero">
          <Hero />
        </section>
        <section id="agents-section-wrapper" aria-label="Catalogue d'agents IA" className="scroll-mt-24">
          <AIAgents />
        </section>
        <section id="purama-compta-section" aria-label="Module Compta" className="scroll-mt-24">
          <PuramaComptaSection />
        </section>
        <section id="origin-forge-section" aria-label="Origin Forge" className="scroll-mt-24">
          <OriginForgeHero />
        </section>
        <section id="origin-demo-section" aria-label="Démo Origin Forge" className="scroll-mt-24">
          <OriginForgeDemo />
        </section>
        <section id="community-section" aria-label="Communauté PURAMA" className="scroll-mt-24">
          <CommunityHighlights />
        </section>
        <section id="roi-section" aria-label="Calculateur d'économies" className="scroll-mt-24">
          <ROICalculator />
        </section>
        <section id="pricing-section" aria-label="Tarifs" className="scroll-mt-24">
          <PricingSection />
        </section>
        <section id="contact-wrapper" aria-label="Contact" className="scroll-mt-24">
          <Contact />
        </section>
      </main>
      <Footer />
      <Chatbot />
    </div>
  );
}
