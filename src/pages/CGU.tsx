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
        <p className="text-sm text-muted-foreground mb-8">Dernière mise à jour : 11 novembre 2026</p>

        <h2>1. Objet</h2>
        <p>Les présentes CGU définissent les conditions d'accès et d'utilisation de la plateforme Purama AI. En créant un compte, vous acceptez l'intégralité des présentes conditions.</p>

        <h2>2. Description du service</h2>
        <p>Purama AI est une plateforme proposant des agents d'intelligence artificielle spécialisés (Email, Comptabilité, Juridique, Partenariats, Créateur d'agents, et plus) ainsi que des agents personnalisés pour l'automatisation des tâches professionnelles : marketing, ventes, service client, ressources humaines, finance.</p>

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
        <p>Les éléments de la plateforme peuvent être protégés par des droits de propriété intellectuelle détenus par leurs titulaires respectifs. Les composants, modèles, médias et logiciels tiers restent soumis à leurs licences et conditions applicables. Les présentes conditions ne retirent pas les droits que ces licences accordent aux utilisateurs.</p>
        <p>L'utilisateur conserve les droits qu'il détient sur les contenus qu'il fournit. La protection éventuelle d'un résultat généré avec l'aide d'une IA dépend notamment des conditions légales de protection et de la contribution créative humaine. Aucun droit exclusif, aucune originalité et aucune absence d'atteinte aux droits de tiers ne sont garantis du seul fait de la génération.</p>
        <p>Les droits d'utilisation que l'exploitant peut effectivement concéder sur un résultat doivent respecter les droits de tiers et les licences applicables. Les présentes conditions n'accordent aucune autorisation sur l'image, la voix, la marque ou l'œuvre d'un tiers sans titre valable.</p>

        <h2>6. Responsabilité</h2>
        <p>Les résultats des systèmes d'intelligence artificielle peuvent comporter des erreurs ou des informations incomplètes. Leur utilisation doit tenir compte de la finalité du service et des limites qui ont été expliquées avant la commande. Les décisions nécessitant une appréciation professionnelle, notamment en matière juridique, médicale ou financière, appellent une vérification adaptée.</p>
        <p>Ces précautions d'utilisation n'excluent ni les engagements contractuels du professionnel ni sa responsabilité dans les conditions du droit applicable. Aucune stipulation des présentes conditions ne supprime ou ne réduit les droits à réparation et les garanties légales dont bénéficie le consommateur.</p>

        <h2>7. Modification des CGU</h2>
        <p>Les modifications des présentes conditions ne produisent pas d'effet rétroactif et ne retirent pas les droits déjà acquis. Toute modification d'un contrat en cours doit respecter les règles légales et les conditions contractuelles applicables ; la seule poursuite de l'utilisation ne vaut pas acceptation lorsque la loi exige un accord ou une information particulière.</p>
        <p>Pour les mises à jour d'un contenu ou service numérique qui ne sont pas nécessaires au maintien de sa conformité, les conditions de l'article L224-25-26 du Code de la consommation s'appliquent lorsqu'elles sont pertinentes : raison valable prévue au contrat, information préalable claire sur support durable, absence de coût supplémentaire et respect des droits du consommateur en cas d'incidence négative sur l'accès ou l'utilisation.</p>

        <h2>8. Résiliation</h2>
        <p>L'utilisateur peut supprimer son compte à tout moment. Purama AI se réserve le droit de suspendre ou supprimer un compte en cas de violation des présentes CGU, après notification préalable sauf urgence.</p>

        <h2>9. Loi applicable</h2>
        <p>Les présentes conditions sont régies par le droit français, sans priver le consommateur des dispositions impératives protectrices qui lui sont applicables.</p>
      </main>
      <Footer />
    </div>
  );
}
