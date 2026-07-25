import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Footer } from '@/components/Footer';

export default function CGV() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-background/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <Link to="/"><Button variant="ghost"><ArrowLeft className="w-4 h-4 mr-2" />Retour</Button></Link>
        </div>
      </header>
      <main className="container mx-auto px-4 py-16 max-w-3xl prose prose-invert">
        <h1 className="text-3xl font-bold mb-8 gradient-text-cyan-purple">Conditions Générales de Vente</h1>
        <p className="text-sm text-muted-foreground mb-8">Dernière mise à jour : février 2025</p>

        <h2>1. Objet</h2>
        <p>Les présentes CGV régissent les conditions de vente des services proposés par Purama AI, accessible à l'adresse purama-ai.purama.dev.</p>

        <h2>2. Services proposés</h2>
        <p>Purama AI propose des agents d'intelligence artificielle accessibles via abonnement :</p>
        <ul>
          <li><strong>Plan Starter</strong> : 29,99€ TTC/mois ou 241,08€ TTC/an — Accès à 5 agents IA au choix</li>
          <li><strong>Plan Pro</strong> : 69€ TTC/mois ou 554,76€ TTC/an — Accès à tous les agents IA</li>
          <li><strong>Plan Ultime</strong> : 99,99€ TTC/mois ou 803,88€ TTC/an — Tous les agents + 100 agents personnalisés + API + white-label</li>
        </ul>
        <p>Tous les prix sont indiqués en euros, toutes taxes comprises (TTC).</p>

        <h2>3. Abonnement et paiement</h2>
        <p>L'abonnement est mensuel ou annuel, sans engagement de durée minimale. Le paiement est effectué par carte bancaire via la plateforme sécurisée Stripe. L'abonnement se renouvelle automatiquement à chaque échéance sauf résiliation.</p>

        <h2>4. Essai gratuit</h2>
        <p>Un essai gratuit de 14 jours est proposé pour tout nouvel abonnement. À l'issue de la période d'essai, l'abonnement sera automatiquement facturé sauf annulation préalable.</p>

        <h2>5. Droit de rétractation</h2>
        <p>Conformément à l'article L221-28 du Code de la consommation, le droit de rétractation ne peut être exercé pour les contrats de fourniture de contenu numérique non fourni sur un support matériel dont l'exécution a commencé avec votre accord préalable et renoncement exprès à votre droit de rétractation. En acceptant les présentes CGV et en commençant à utiliser nos services, vous reconnaissez renoncer à votre droit de rétractation.</p>

        <h2>6. Résiliation</h2>
        <p>Vous pouvez résilier votre abonnement à tout moment depuis votre espace de gestion. La résiliation prend effet à la fin de la période en cours. Vous conservez l'accès aux services jusqu'à la fin de la période facturée. Aucun remboursement au prorata ne sera effectué.</p>

        <h2>7. Limitation de responsabilité</h2>
        <p>Les agents IA fournissent des résultats générés automatiquement à titre indicatif. Purama AI ne saurait être tenu responsable des décisions prises sur la base des résultats fournis par les agents. Notre responsabilité est limitée au montant total payé par le client au cours des 12 derniers mois.</p>

        <h2>8. Garantie légale de conformité</h2>
        <p>Conformément aux articles L217-3 et suivants du Code de la consommation, le consommateur bénéficie de la garantie légale de conformité pour les contenus et services numériques.</p>

        <h2>9. Médiation</h2>
        <p>En cas de litige, vous pouvez recourir gratuitement au service de médiation de la consommation. Le médiateur compétent est : <strong>[À COMPLÉTER - Nom et coordonnées du médiateur]</strong>. Vous pouvez également déposer votre réclamation sur la plateforme européenne de résolution des litiges en ligne : <a href="https://ec.europa.eu/consumers/odr" target="_blank" rel="noopener noreferrer" className="text-primary">https://ec.europa.eu/consumers/odr</a></p>

        <h2>10. Loi applicable et juridiction</h2>
        <p>Les présentes CGV sont soumises au droit français. Tout litige sera soumis aux tribunaux compétents du ressort de <strong>[À COMPLÉTER - Ville du tribunal]</strong>.</p>
      </main>
      <Footer />
    </div>
  );
}
