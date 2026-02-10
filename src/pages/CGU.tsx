import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Footer } from '@/components/Footer';

export default function CGU() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-background/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <Link to="/"><Button variant="ghost"><ArrowLeft className="w-4 h-4 mr-2" />Retour</Button></Link>
        </div>
      </header>
      <main className="container mx-auto px-4 py-16 max-w-3xl prose prose-invert">
        <h1 className="text-3xl font-bold mb-8 gradient-text-cyan-purple">Conditions Générales d'Utilisation</h1>
        <p className="text-sm text-muted-foreground mb-8">Dernière mise à jour : février 2025</p>

        <h2>1. Objet</h2>
        <p>Les présentes CGU définissent les conditions d'accès et d'utilisation de la plateforme Purama AI. En créant un compte, vous acceptez l'intégralité des présentes conditions.</p>

        <h2>2. Description du service</h2>
        <p>Purama AI est une plateforme proposant 45 agents d'intelligence artificielle spécialisés dans l'automatisation des tâches professionnelles : marketing, ventes, service client, ressources humaines, finance, et plus encore.</p>

        <h2>3. Accès et inscription</h2>
        <p>L'inscription est ouverte à toute personne physique ou morale. Vous devez fournir des informations exactes et à jour. Vous êtes responsable de la confidentialité de vos identifiants de connexion.</p>

        <h2>4. Obligations de l'utilisateur</h2>
        <p>L'utilisateur s'engage à :</p>
        <ul>
          <li>Utiliser les services conformément à leur destination</li>
          <li>Ne pas tenter de contourner les mesures de sécurité</li>
          <li>Ne pas utiliser les agents IA à des fins illicites, frauduleuses ou nuisibles</li>
          <li>Ne pas surcharger intentionnellement les serveurs</li>
          <li>Respecter les droits de propriété intellectuelle</li>
        </ul>

        <h2>5. Propriété intellectuelle</h2>
        <p>L'ensemble des éléments de la plateforme (code source, design, algorithmes, marques, logos) est la propriété exclusive de Purama AI. Les résultats générés par les agents IA sont la propriété de l'utilisateur, sous réserve du respect des présentes CGU.</p>

        <h2>6. Responsabilité</h2>
        <p>Purama AI fournit ses services « en l'état ». Nous nous efforçons de maintenir un service disponible 24h/24, mais ne garantissons pas une disponibilité ininterrompue. Les résultats des agents IA sont fournis à titre indicatif et ne constituent pas des conseils professionnels.</p>

        <h2>7. Modification des CGU</h2>
        <p>Purama AI se réserve le droit de modifier les présentes CGU à tout moment. Les utilisateurs seront informés par email de toute modification substantielle. La poursuite de l'utilisation du service après modification vaut acceptation.</p>

        <h2>8. Résiliation</h2>
        <p>L'utilisateur peut supprimer son compte à tout moment. Purama AI se réserve le droit de suspendre ou supprimer un compte en cas de violation des présentes CGU, après notification préalable sauf urgence.</p>

        <h2>9. Loi applicable</h2>
        <p>Les présentes CGU sont régies par le droit français.</p>
      </main>
      <Footer />
    </div>
  );
}
