import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Footer } from '@/components/Footer';

export default function PolitiqueCookies() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-background/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <Link to="/"><Button variant="ghost"><ArrowLeft className="w-4 h-4 mr-2" />Retour</Button></Link>
        </div>
      </header>
      <main className="container mx-auto px-4 py-16 max-w-3xl prose prose-invert">
        <h1 className="text-3xl font-bold mb-8 gradient-text-cyan-purple">Politique de Cookies</h1>
        <p className="text-sm text-muted-foreground mb-8">Dernière mise à jour : février 2025</p>

        <h2>1. Qu'est-ce qu'un cookie ?</h2>
        <p>Un cookie est un petit fichier texte déposé sur votre appareil lors de votre visite sur notre site. Il permet de stocker des informations relatives à votre navigation.</p>

        <h2>2. Cookies utilisés</h2>

        <h3>Cookies strictement nécessaires</h3>
        <p>Ces cookies sont indispensables au fonctionnement du site et ne peuvent pas être désactivés.</p>
        <table className="w-full text-sm">
          <thead><tr><th className="text-left p-2">Cookie</th><th className="text-left p-2">Finalité</th><th className="text-left p-2">Durée</th></tr></thead>
          <tbody>
            <tr><td className="p-2">sb-*-auth-token</td><td className="p-2">Authentification utilisateur</td><td className="p-2">Session</td></tr>
            <tr><td className="p-2">cookie_consent</td><td className="p-2">Mémorisation de votre choix cookies</td><td className="p-2">13 mois</td></tr>
          </tbody>
        </table>

        <h3>Cookies analytiques</h3>
        <p>Ces cookies nous permettent de comprendre comment les visiteurs utilisent notre site, afin d'en améliorer le fonctionnement.</p>
        <table className="w-full text-sm">
          <thead><tr><th className="text-left p-2">Cookie</th><th className="text-left p-2">Finalité</th><th className="text-left p-2">Durée</th></tr></thead>
          <tbody>
            <tr><td className="p-2">_ga, _gid</td><td className="p-2">Google Analytics — mesure d'audience</td><td className="p-2">13 mois</td></tr>
          </tbody>
        </table>

        <h3>Cookies tiers</h3>
        <table className="w-full text-sm">
          <thead><tr><th className="text-left p-2">Cookie</th><th className="text-left p-2">Finalité</th><th className="text-left p-2">Durée</th></tr></thead>
          <tbody>
            <tr><td className="p-2">__stripe_*</td><td className="p-2">Stripe — sécurisation des paiements</td><td className="p-2">Session</td></tr>
          </tbody>
        </table>

        <h2>3. Gérer vos cookies</h2>
        <p>Lors de votre première visite, un bandeau vous permet d'accepter, refuser ou personnaliser les cookies. Vous pouvez modifier votre choix à tout moment en cliquant sur « Gérer les cookies » dans le pied de page du site.</p>
        <p>Vous pouvez également paramétrer votre navigateur pour refuser les cookies :</p>
        <ul>
          <li><a href="https://support.google.com/chrome/answer/95647" target="_blank" rel="noopener noreferrer" className="text-primary">Google Chrome</a></li>
          <li><a href="https://support.mozilla.org/fr/kb/activer-desactiver-cookies" target="_blank" rel="noopener noreferrer" className="text-primary">Mozilla Firefox</a></li>
          <li><a href="https://support.apple.com/fr-fr/guide/safari/sfri11471/mac" target="_blank" rel="noopener noreferrer" className="text-primary">Safari</a></li>
          <li><a href="https://support.microsoft.com/fr-fr/microsoft-edge/supprimer-les-cookies-dans-microsoft-edge-63947406-40ac-c3b8-57b9-2a946a29ae09" target="_blank" rel="noopener noreferrer" className="text-primary">Microsoft Edge</a></li>
        </ul>

        <h2>4. Durée de validité du consentement</h2>
        <p>Conformément aux recommandations de la CNIL, votre consentement concernant les cookies est valable pour une durée maximale de 13 mois.</p>
      </main>
      <Footer />
    </div>
  );
}
