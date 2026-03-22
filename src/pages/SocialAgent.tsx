import { Link } from 'react-router-dom';
import { Bot, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AnimatedStarfield } from '@/components/AnimatedStarfield';
import { PuramaSocialAgent } from '@/components/agent/PuramaSocialAgent';

export default function SocialAgent() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <AnimatedStarfield />

      {/* Header */}
      <header className="relative z-20 py-4">
        <div className="container mx-auto px-6 sm:px-8 lg:px-12 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 text-muted-foreground hover:text-accent-cyan transition-colors">
            <ArrowLeft className="w-5 h-5" />
            <span className="text-sm font-space">Retour</span>
          </Link>
          <Link to="/" className="flex items-center gap-2">
            <Bot className="w-8 h-8 text-accent-cyan" />
            <span className="font-orbitron text-xl font-bold">PURAMA<span className="text-accent-cyan"> AI</span></span>
          </Link>
          <Link to="/login">
            <Button variant="outline" className="border-accent-cyan/30 text-accent-cyan hover:bg-accent-cyan/10">
              Connexion
            </Button>
          </Link>
        </div>
      </header>

      {/* Agent */}
      <main className="relative z-10 container mx-auto px-4 sm:px-6 lg:px-8 pb-8">
        <PuramaSocialAgent />
      </main>
    </div>
  );
}
