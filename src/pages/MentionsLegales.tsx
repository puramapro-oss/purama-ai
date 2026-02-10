import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Footer } from '@/components/Footer';

export default function MentionsLegales() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-background/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <Link to="/">
            <Button variant="ghost"><ArrowLeft className="w-4 h-4 mr-2" />Retour</Button>
          </Link>
        </div>
      </header>
      <main className="container mx-auto px-4 py-16 max-w-3xl prose prose-invert">
        <h1 className="text-3xl font-bold mb-8 gradient-text-cyan-purple">Mentions Légales</h1>
        <p className="text-sm text-muted-foreground mb-8">Dernière mise à jour : février 2025</p>

        <h2>1. Éditeur du site</h2>
        <ul>
          <li>Raison sociale : <strong>[À COMPLÉTER - Raison sociale]</strong></li>
          <li>Forme juridique : <strong>[À COMPLÉTER - Forme juridique]</strong></li>
          <li>Capital social : <strong>[À COMPLÉTER - Capital social]</strong></li>
          <li>Siège social : <strong>[À COMPLÉTER - Adresse du siège social]</strong></li>
          <li>SIRET : <strong>[À COMPLÉTER - Numéro SIRET]</strong></li>
          <li>RCS : <strong>[À COMPLÉTER - Numéro RCS]</strong></li>
          <li>TVA intracommunautaire : <strong>[À COMPLÉTER - Numéro TVA]</strong></li>
          <li>Directeur de publication : <strong>[À COMPLÉTER - Nom du directeur]</strong></li>
          <li>Email : <strong>[À COMPLÉTER - Email de contact]</strong></li>
          <li>Téléphone : <strong>[À COMPLÉTER - Numéro de téléphone]</strong></li>
        </ul>

        <h2>2. Hébergement</h2>
        <ul>
          <li>Hébergeur : Vercel Inc.</li>
          <li>Adresse : 340 S Lemon Ave #4133, Walnut, CA 91789, États-Unis</li>
          <li>Site web : <a href="https://vercel.com" target="_blank" rel="noopener noreferrer" className="text-primary">vercel.com</a></li>
        </ul>
        <p>Les données sont hébergées par Supabase Inc., 970 Toa Payoh North #07-04, Singapore 318992.</p>

        <h2>3. Propriété intellectuelle</h2>
        <p>
          L'ensemble du contenu du site Purama AI (textes, images, logos, graphismes, logiciels, bases de données) est protégé par le droit de la propriété intellectuelle. Toute reproduction, représentation, modification ou exploitation, même partielle, sans autorisation préalable écrite est interdite.
        </p>

        <h2>4. Données personnelles</h2>
        <p>
          Les informations relatives au traitement de vos données personnelles sont détaillées dans notre{' '}
          <Link to="/politique-de-confidentialite" className="text-primary hover:underline">Politique de Confidentialité</Link>.
        </p>

        <h2>5. Cookies</h2>
        <p>
          Ce site utilise des cookies. Pour en savoir plus, consultez notre{' '}
          <Link to="/politique-cookies" className="text-primary hover:underline">Politique de Cookies</Link>.
        </p>

        <h2>6. Loi applicable</h2>
        <p>
          Les présentes mentions légales sont soumises au droit français. En cas de litige, les tribunaux français seront seuls compétents.
        </p>
      </main>
      <Footer />
    </div>
  );
}
