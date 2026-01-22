import { useEffect } from 'react';
import { Hero } from '@/components/Hero';
import { AIAgents } from '@/components/AIAgents';
import { Features } from '@/components/Features';
import { ROICalculator } from '@/components/ROICalculator';
import { AgentComparator } from '@/components/AgentComparator';
import { Pricing } from '@/components/Pricing';
import { Contact } from '@/components/Contact';
import { Footer } from '@/components/Footer';
import { Chatbot } from '@/components/Chatbot';
import { ReferralBanner } from '@/components/influencer/ReferralBanner';
import { useReferralTracking } from '@/hooks/useInfluencer';

export default function Index() {
  const { checkAndStoreReferral } = useReferralTracking();

  useEffect(() => {
    // Check for referral code in URL and store it
    checkAndStoreReferral();
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <ReferralBanner />
      <main className="relative" role="main">
        <section id="hero" aria-label="Hero section">
          <Hero />
        </section>
        <section id="agents-section" aria-label="AI Agents section">
          <AIAgents />
        </section>
        <section id="features-section" aria-label="Features section">
          <Features />
        </section>
        <section id="roi-section" aria-label="ROI Calculator section">
          <ROICalculator />
        </section>
        <section id="comparator-section" aria-label="Agent Comparator section">
          <AgentComparator />
        </section>
        <section id="pricing-section" aria-label="Pricing section">
          <Pricing />
        </section>
        <section id="contact-section" aria-label="Contact section">
          <Contact />
        </section>
      </main>
      <Footer />
      <Chatbot />
    </div>
  );
}
