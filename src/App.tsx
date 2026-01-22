import { Hero } from './components/Hero'
import { AIAgents } from './components/AIAgents'
import { Features } from './components/Features'
import { Pricing } from './components/Pricing'
import { Contact } from './components/Contact'
import { Footer } from './components/Footer'

export default function App() {
  return (
    <div className="min-h-screen bg-background text-foreground">
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
        <section id="pricing-section" aria-label="Pricing section">
          <Pricing />
        </section>
        <section id="contact-section" aria-label="Contact section">
          <Contact />
        </section>
      </main>
      <Footer />
    </div>
  )
}
