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
        <p className="text-sm text-muted-foreground mb-8">Dernière mise à jour : 11 novembre 2026</p>

        <h2>1. Objet</h2>
        <p>Les présentes CGV régissent les conditions de vente des services proposés par Purama AI, accessible à l'adresse purama-ai.purama.dev.</p>

        <h2>2. Services proposés</h2>
        <p>Les services, les formules et leurs caractéristiques sont présentés sur la page <Link to="/pricing" className="text-primary hover:underline">Tarifs</Link>. Les conditions de l'offre acceptée lors de la souscription s'appliquent à votre abonnement.</p>
        <p>Avant tout engagement de paiement, le prix total à payer, les taxes applicables et la périodicité de facturation doivent vous être communiqués clairement.</p>

        <h2>3. Abonnement et paiement</h2>
        <p>L'abonnement est mensuel ou annuel, sans engagement de durée minimale. Le paiement est effectué par carte bancaire via la plateforme sécurisée Stripe. L'abonnement se renouvelle automatiquement à chaque échéance sauf résiliation.</p>

        <h2>4. Essai gratuit</h2>
        <p>Un essai gratuit de 14 jours, sans carte bancaire, est proposé aux comptes éligibles. Le démarrage de cet essai ne déclenche pas, à lui seul, de facturation. La souscription à un abonnement payant nécessite une démarche explicite de votre part et l'acceptation des conditions de paiement de l'offre choisie.</p>

        <h2>5. Droit de rétractation</h2>
        <p>Le consommateur dispose en principe d'un délai de quatorze jours à compter de la conclusion du contrat pour exercer son droit de rétractation, sans avoir à justifier sa décision, sous réserve des exceptions légales applicables. L'acceptation des présentes CGV et la simple utilisation du service ne valent pas, à elles seules, renonciation à ce droit.</p>
        <p>Lorsqu'il demande expressément que l'exécution d'une prestation de services payante commence avant l'expiration de ce délai, le consommateur conserve son droit de rétractation tant que les conditions légales de sa perte ne sont pas réunies. En cas de rétractation après un commencement d'exécution demandé expressément, seule la somme proportionnée au service fourni peut être due dans les conditions de l'article L221-25 du Code de la consommation. Aucune somme n'est due à ce titre si la demande expresse ou l'information légale exigée fait défaut.</p>
        <p>Pour un contenu numérique sans support matériel, une perte du droit de rétractation ne peut être opposée que si les conditions de l'article L221-28, 13°, sont réunies, notamment le consentement exprès préalable au commencement anticipé, la reconnaissance de la perte de ce droit et la confirmation requise sur support durable. Cette exception ne s'applique pas indistinctement à tout abonnement comportant des fonctionnalités numériques.</p>
        <p>Vous pouvez exercer votre droit de rétractation avant l'expiration du délai en adressant au professionnel le formulaire type de rétractation ou toute déclaration dénuée d'ambiguïté exprimant votre décision de vous rétracter.</p>

        <h2>6. Résiliation</h2>
        <p>Vous pouvez résilier votre abonnement à tout moment depuis votre espace de gestion. La résiliation prend effet à la fin de la période en cours. Vous conservez l'accès aux services jusqu'à la fin de la période facturée. Ces conditions de résiliation ordinaire ne limitent pas vos droits en matière de rétractation, de garantie légale, d'inexécution du contrat ou de modification du service. Elles ne font pas obstacle aux remboursements ou réductions de prix prévus par la loi.</p>

        <h2>7. Limitation de responsabilité</h2>
        <p>Les résultats des systèmes d'intelligence artificielle peuvent comporter des erreurs ou des informations incomplètes. Leur utilisation doit tenir compte de la finalité du service et des limites qui ont été expliquées avant la commande. Les décisions nécessitant une appréciation professionnelle, notamment en matière juridique, médicale ou financière, appellent une vérification adaptée.</p>
        <p>Ces précautions d'utilisation n'excluent ni les engagements contractuels du professionnel ni sa responsabilité dans les conditions du droit applicable. Aucune stipulation des présentes conditions ne supprime ou ne réduit les droits à réparation et les garanties légales dont bénéficie le consommateur.</p>

        <h2>8. Garantie légale de conformité</h2>
        <p>Les contenus et services numériques fournis au consommateur bénéficient de la garantie légale de conformité prévue aux articles L224-25-12 et suivants du Code de la consommation. Pour une fourniture continue, le professionnel répond des défauts de conformité qui apparaissent pendant la période contractuelle de fourniture. Pour une fourniture ponctuelle ou une série de fournitures distinctes, il répond des défauts existant lors de la fourniture et apparaissant dans les deux ans qui la suivent, selon les conditions légales.</p>
        <p>Cette garantie comprend les mises à jour nécessaires au maintien de la conformité. Le consommateur peut demander la mise en conformité et, dans les situations prévues par la loi, une réduction de prix ou la résolution du contrat.</p>

        <h2>9. Médiation</h2>
        <p>En cas de litige, vous pouvez recourir gratuitement au service de médiation de la consommation. Le médiateur compétent est : <strong>[À COMPLÉTER - Nom et coordonnées du médiateur]</strong>.</p>

        <h2>10. Loi applicable et juridiction</h2>
        <p>Les présentes conditions sont régies par le droit français, sans priver le consommateur des dispositions impératives protectrices qui lui sont applicables.</p>
        <p>Les litiges relèvent des juridictions compétentes selon les règles légales applicables. En France, le consommateur peut notamment saisir les juridictions prévues par le Code de procédure civile ou celle du lieu où il demeurait lors de la conclusion du contrat ou de la survenance du fait dommageable, conformément à l'article R631-3 du Code de la consommation. Les règles internationales de compétence éventuellement applicables demeurent réservées.</p>
      </main>
      <Footer />
    </div>
  );
}
