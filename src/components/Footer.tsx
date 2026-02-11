import { Link } from 'react-router-dom'
import { Bot, Linkedin, Twitter, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { resetCookieConsent } from '@/components/CookieConsent'

export function Footer() {
  return (
    <footer className="relative py-16 bg-card border-t border-accent-cyan/10">
      <div className="absolute inset-0 grid-pattern opacity-10" />
      
      <div className="container mx-auto px-6 sm:px-8 lg:px-12 relative z-10">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8 sm:gap-12 mb-12">
          {/* Brand */}
          <div className="md:col-span-1">
            <div className="flex items-center gap-2 mb-4">
              <Bot className="w-8 h-8 text-accent-cyan" />
              <span className="font-orbitron text-xl font-bold text-foreground">
                PURAMA<span className="text-accent-cyan"> AI</span>
              </span>
            </div>
            <p className="text-muted-foreground text-sm leading-relaxed mb-6">
              La plateforme #1 d'agents IA pour automatiser votre entreprise et booster votre productivité.
            </p>
            <div className="flex gap-4">
              {[
                { Icon: Twitter, label: 'Twitter', url: '#' },
                { Icon: Linkedin, label: 'LinkedIn', url: '#' },
              ].map(({ Icon, label, url }) => (
                <a
                  key={label}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={label}
                  className="w-10 h-10 bg-secondary/50 rounded-lg flex items-center justify-center text-muted-foreground hover:text-accent-cyan hover:bg-accent-cyan/10 transition-all"
                >
                  <Icon className="w-5 h-5" />
                </a>
              ))}
            </div>
          </div>

          {/* Product links */}
          <div>
            <h4 className="font-orbitron font-semibold text-foreground mb-4">Produit</h4>
            <ul className="space-y-3">
              {[
                { label: 'Accueil', to: '/' },
                { label: 'Agents IA', to: '/#agents-section' },
                { label: 'Tarifs', to: '/pricing' },
                { label: 'Contact', to: '/#contact-section' },
              ].map((link, i) => (
                <li key={i}>
                  <Link to={link.to} className="text-muted-foreground hover:text-accent-cyan transition-colors text-sm">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Legal links */}
          <div>
            <h4 className="font-orbitron font-semibold text-foreground mb-4">Légal</h4>
            <ul className="space-y-3">
              {[
                { label: 'Mentions légales', to: '/mentions-legales' },
                { label: 'CGV', to: '/cgv' },
                { label: 'CGU', to: '/cgu' },
                { label: 'Politique de confidentialité', to: '/politique-de-confidentialite' },
                { label: 'Politique de cookies', to: '/politique-cookies' },
              ].map((link, i) => (
                <li key={i}>
                  <Link to={link.to} className="text-muted-foreground hover:text-accent-cyan transition-colors text-sm">
                    {link.label}
                  </Link>
                </li>
              ))}
              <li>
                <button
                  onClick={resetCookieConsent}
                  className="text-muted-foreground hover:text-accent-cyan transition-colors text-sm"
                >
                  Gérer les cookies
                </button>
              </li>
            </ul>
          </div>

          {/* Partner */}
          <div>
            <h4 className="font-orbitron font-semibold text-foreground mb-4">Partenaires</h4>
            <p className="text-muted-foreground text-sm mb-4">Rejoignez notre programme partenaire et gagnez des commissions.</p>
            <Button asChild className="bg-gradient-to-r from-accent-purple to-accent-cyan hover:opacity-90">
              <Link to="/influenceur/inscription" className="flex items-center gap-2">
                <Users className="w-4 h-4" />
                Devenir Partenaire
              </Link>
            </Button>
          </div>
        </div>

        {/* Bottom */}
        <div className="pt-8 border-t border-accent-cyan/10 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-muted-foreground text-sm">
            © 2025–2026 Purama AI — Tous droits réservés.
          </p>
          <p className="text-muted-foreground text-xs">
            Sans engagement, résiliable à tout moment.
          </p>
        </div>
      </div>
    </footer>
  )
}
