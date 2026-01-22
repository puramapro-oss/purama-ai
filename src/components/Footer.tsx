'use client'

import { Bot, Github, Linkedin, Twitter } from 'lucide-react'

export function Footer() {
  return (
    <footer className="relative py-16 bg-card border-t border-accent-cyan/10">
      <div className="absolute inset-0 grid-pattern opacity-10" />
      
      <div className="container mx-auto px-6 sm:px-8 lg:px-12 relative z-10">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-12 mb-12">
          {/* Brand */}
          <div className="md:col-span-1">
            <div className="flex items-center gap-2 mb-4">
              <Bot className="w-8 h-8 text-accent-cyan" />
              <span className="font-orbitron text-xl font-bold text-foreground">
                AI<span className="text-accent-cyan">AGENTS</span>
              </span>
            </div>
            <p className="text-muted-foreground text-sm leading-relaxed mb-6">
              La plateforme #1 d'agents IA pour automatiser votre entreprise et booster votre productivité.
            </p>
            <div className="flex gap-4">
              {[Twitter, Linkedin, Github].map((Icon, i) => (
                <a
                  key={i}
                  href="#"
                  className="w-10 h-10 bg-secondary/50 rounded-lg flex items-center justify-center text-muted-foreground hover:text-accent-cyan hover:bg-accent-cyan/10 transition-all"
                >
                  <Icon className="w-5 h-5" />
                </a>
              ))}
            </div>
          </div>

          {/* Links */}
          {[
            {
              title: 'Produit',
              links: ['Agents IA', 'Fonctionnalités', 'Tarifs', 'Intégrations', 'API'],
            },
            {
              title: 'Entreprise',
              links: ['À Propos', 'Blog', 'Carrières', 'Partenaires', 'Presse'],
            },
            {
              title: 'Support',
              links: ['Documentation', 'FAQ', 'Contact', 'Status', 'Communauté'],
            },
          ].map((section, index) => (
            <div key={index}>
              <h4 className="font-orbitron font-semibold text-foreground mb-4">
                {section.title}
              </h4>
              <ul className="space-y-3">
                {section.links.map((link, i) => (
                  <li key={i}>
                    <a
                      href="#"
                      className="text-muted-foreground hover:text-accent-cyan transition-colors text-sm"
                    >
                      {link}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Bottom */}
        <div className="pt-8 border-t border-accent-cyan/10 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-muted-foreground text-sm">
            © 2024 AI Agents. Tous droits réservés.
          </p>
          <div className="flex gap-6">
            {['Confidentialité', 'CGU', 'Cookies'].map((item, i) => (
              <a
                key={i}
                href="#"
                className="text-muted-foreground hover:text-accent-cyan text-sm transition-colors"
              >
                {item}
              </a>
            ))}
          </div>
        </div>
      </div>
    </footer>
  )
}
