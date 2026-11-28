import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Footer } from '@/components/Footer';

export default function PolitiqueConfidentialite() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-background/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <Link to="/"><Button variant="ghost"><ArrowLeft className="w-4 h-4 mr-2" />Retour</Button></Link>
        </div>
      </header>
      <main className="container mx-auto px-4 py-16 max-w-3xl prose prose-invert">
        <h1 className="text-3xl font-bold mb-8 gradient-text-cyan-purple">Politique de Confidentialité</h1>
        <p className="text-sm text-muted-foreground mb-8">Dernière mise à jour : 11 novembre 2026</p>

        <h2>1. Responsable de traitement</h2>
        <p><strong>[À COMPLÉTER - Raison sociale]</strong>, dont le siège social est situé au <strong>[À COMPLÉTER - Adresse]</strong>, est responsable du traitement de vos données personnelles.</p>
        <p>Contact : <strong>[À COMPLÉTER - Email DPO ou contact]</strong></p>

        <h2>2. Données collectées</h2>
        <p>Nous collectons les données suivantes :</p>
        <ul>
          <li><strong>Données d'identification</strong> : nom, prénom, adresse email</li>
          <li><strong>Données de connexion</strong> : adresse IP, logs de connexion</li>
          <li><strong>Données de paiement</strong> : traitées exclusivement par Stripe (nous ne stockons aucune donnée bancaire)</li>
          <li><strong>Données d'usage</strong> : interactions avec les agents IA, historique d'utilisation</li>
        </ul>

        <h2>3. Finalités et base légale</h2>
        <table className="w-full text-sm">
          <thead><tr><th className="text-left p-2">Finalité</th><th className="text-left p-2">Base légale</th></tr></thead>
          <tbody>
            <tr><td className="p-2">Gestion de votre compte</td><td className="p-2">Exécution du contrat</td></tr>
            <tr><td className="p-2">Fourniture des services IA</td><td className="p-2">Exécution du contrat</td></tr>
            <tr><td className="p-2">Gestion des paiements</td><td className="p-2">Exécution du contrat</td></tr>
            <tr><td className="p-2">Amélioration des services</td><td className="p-2">Intérêt légitime</td></tr>
            <tr><td className="p-2">Communication marketing</td><td className="p-2">Consentement</td></tr>
            <tr><td className="p-2">Respect des obligations légales</td><td className="p-2">Obligation légale</td></tr>
          </tbody>
        </table>

        <h2>4. Durée de conservation</h2>
        <ul>
          <li>Données de compte : durée de la relation contractuelle + 3 ans</li>
          <li>Données de paiement : 10 ans (obligations comptables)</li>
          <li>Données de connexion : 12 mois</li>
          <li>Cookies et autres traceurs : la durée dépend du traceur et de sa finalité. Consultez notre <Link to="/politique-cookies" className="text-primary hover:underline">Politique de Cookies</Link> pour les informations disponibles.</li>
        </ul>

        <h2>5. Destinataires des données</h2>
        <p>Vos données peuvent être transmises aux sous-traitants suivants :</p>
        <ul>
          <li><strong>Supabase Inc.</strong> (hébergement et base de données) — Singapour/USA</li>
          <li><strong>Stripe Inc.</strong> (paiement) — USA</li>
          <li><strong>Vercel Inc.</strong> (hébergement web) — USA</li>
        </ul>

        <h2>6. Transferts hors UE</h2>
        <p>Un transfert de données personnelles vers un pays situé hors de l'Espace économique européen doit reposer sur un mécanisme autorisé par le chapitre V du RGPD. Une décision d'adéquation et des clauses contractuelles types constituent des mécanismes distincts.</p>
        <p>Lorsqu'un transfert repose sur des clauses contractuelles types, leur champ, les parties concernées et les circonstances du transfert doivent être examinés ; des mesures supplémentaires peuvent être nécessaires. L'utilisation de ces clauses ne constitue pas, à elle seule, une garantie automatique d'adéquation du pays de destination.</p>
        <p><strong>[À COMPLÉTER - Transferts réellement effectués : destinataires, pays, garanties applicables et modalités pour en obtenir une copie]</strong></p>

        <h2>7. Vos droits</h2>
        <p>Conformément au RGPD (articles 15 à 22), vous disposez des droits suivants :</p>
        <ul>
          <li><strong>Droit d'accès</strong> : obtenir une copie de vos données</li>
          <li><strong>Droit de rectification</strong> : corriger vos données inexactes</li>
          <li><strong>Droit à l'effacement</strong> : supprimer vos données</li>
          <li><strong>Droit à la portabilité</strong> : recevoir vos données dans un format structuré</li>
          <li><strong>Droit d'opposition</strong> : vous opposer au traitement</li>
          <li><strong>Droit à la limitation</strong> : limiter le traitement</li>
        </ul>
        <p>Pour exercer ces droits, contactez-nous à : <strong>[À COMPLÉTER - Email DPO]</strong></p>

        <h2>8. Réclamation</h2>
        <p>Si vous estimez que le traitement de vos données n'est pas conforme, vous pouvez introduire une réclamation auprès de la CNIL : <a href="https://www.cnil.fr" target="_blank" rel="noopener noreferrer" className="text-primary">www.cnil.fr</a></p>

        <h2>9. Violation de données</h2>
        <p>En cas de violation de données susceptible d'engendrer un risque élevé pour vos droits et libertés, nous vous en informerons dans les meilleurs délais, conformément à l'article 34 du RGPD.</p>
      </main>
      <Footer />
    </div>
  );
}
