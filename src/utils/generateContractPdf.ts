import jsPDF from 'jspdf';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';

interface ContractData {
  beneficiaryName: string;
  promoCode: string;
  commissionRate: number;
  contractSignedAt: string | null;
  createdAt: string;
}

export function generateContractPdf(data: ContractData): void {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 20;
  const contentWidth = pageWidth - margin * 2;
  let y = 20;

  // Header
  doc.setFillColor(124, 58, 237); // Primary purple
  doc.rect(0, 0, pageWidth, 40, 'F');
  
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(24);
  doc.text('AGENTIA', margin, 28);
  
  doc.setFontSize(12);
  doc.setFont('helvetica', 'normal');
  doc.text('Programme d\'Affiliation', pageWidth - margin - 60, 28);

  y = 60;

  // Title
  doc.setTextColor(0, 0, 0);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text('CONTRAT D\'AFFILIATION', pageWidth / 2, y, { align: 'center' });
  
  y += 20;

  // Parties
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('ENTRE LES SOUSSIGNÉS :', margin, y);
  y += 10;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  
  const parties = [
    'Agentia SAS, société par actions simplifiée, dont le siège social est situé à Paris,',
    'représentée par ses représentants légaux,',
    'ci-après dénommée « l\'Annonceur »,',
    '',
    'ET',
    '',
    `${data.beneficiaryName},`,
    'ci-après dénommé(e) « l\'Affilié ».',
  ];

  parties.forEach(line => {
    doc.text(line, margin, y);
    y += 6;
  });

  y += 10;

  // Article 1
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('Article 1 - Objet du contrat', margin, y);
  y += 8;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  const article1 = doc.splitTextToSize(
    'Le présent contrat a pour objet de définir les conditions dans lesquelles l\'Affilié participera au programme d\'affiliation d\'Agentia. L\'Affilié s\'engage à promouvoir les services d\'Agentia auprès de son audience en contrepartie d\'une commission sur les ventes générées.',
    contentWidth
  );
  doc.text(article1, margin, y);
  y += article1.length * 5 + 10;

  // Article 2
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('Article 2 - Commission', margin, y);
  y += 8;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  const article2 = doc.splitTextToSize(
    `L'Affilié percevra une commission de ${data.commissionRate}% sur le montant HT de chaque vente réalisée grâce à son lien d'affiliation unique ou son code promo. Les commissions sont calculées sur la valeur annuelle des abonnements souscrits.`,
    contentWidth
  );
  doc.text(article2, margin, y);
  y += article2.length * 5 + 10;

  // Article 3
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('Article 3 - Code promo et lien d\'affiliation', margin, y);
  y += 8;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  
  doc.text(`Code promo attribué : `, margin, y);
  doc.setFont('helvetica', 'bold');
  doc.text(data.promoCode, margin + 45, y);
  y += 8;
  
  doc.setFont('helvetica', 'normal');
  const article3 = doc.splitTextToSize(
    'Ce code offre une réduction de 50% sur la première année d\'abonnement aux nouveaux clients. Le lien d\'affiliation est valide pour une durée de 1 mois renouvelable depuis le tableau de bord.',
    contentWidth
  );
  doc.text(article3, margin, y);
  y += article3.length * 5 + 10;

  // Article 4
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('Article 4 - Conditions de paiement', margin, y);
  y += 8;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  const article4 = doc.splitTextToSize(
    '• Paiement mensuel des commissions validées\n• Seuil minimum de paiement : 50€\n• Paiement par virement bancaire SEPA uniquement\n• Les coordonnées bancaires doivent être renseignées dans le tableau de bord',
    contentWidth
  );
  doc.text(article4, margin, y);
  y += article4.length * 5 + 10;

  // Article 5
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('Article 5 - Obligations de l\'Affilié', margin, y);
  y += 8;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  const article5 = doc.splitTextToSize(
    '• Promouvoir Agentia de manière éthique et loyale\n• Ne pas utiliser de pratiques trompeuses ou mensongères\n• Ne pas acheter de publicités sur des mots-clés de marque Agentia\n• Respecter le droit applicable en matière de publicité et de protection des données',
    contentWidth
  );
  doc.text(article5, margin, y);
  y += article5.length * 5 + 10;

  // Article 6
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('Article 6 - Durée et résiliation', margin, y);
  y += 8;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  const article6 = doc.splitTextToSize(
    'Le présent contrat est conclu pour une durée indéterminée. Chaque partie peut y mettre fin à tout moment avec un préavis de 30 jours. Les commissions dues pour les ventes réalisées avant la résiliation restent acquises à l\'Affilié.',
    contentWidth
  );
  doc.text(article6, margin, y);
  y += article6.length * 5 + 15;

  // Signatures section
  if (y > 240) {
    doc.addPage();
    y = 20;
  }

  doc.setDrawColor(200, 200, 200);
  doc.line(margin, y, pageWidth - margin, y);
  y += 15;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('SIGNATURES', pageWidth / 2, y, { align: 'center' });
  y += 15;

  // Date and signature boxes
  const boxWidth = (contentWidth - 20) / 2;
  
  // Annonceur
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Pour l\'Annonceur', margin, y);
  doc.text('Pour l\'Affilié', margin + boxWidth + 20, y);
  y += 8;

  doc.setFont('helvetica', 'normal');
  doc.text('Agentia SAS', margin, y);
  doc.text(data.beneficiaryName, margin + boxWidth + 20, y);
  y += 15;

  // Signature status
  if (data.contractSignedAt) {
    const signedDate = format(new Date(data.contractSignedAt), 'dd MMMM yyyy à HH:mm', { locale: fr });
    
    doc.setFillColor(34, 197, 94); // Green
    doc.roundedRect(margin + boxWidth + 20, y - 5, boxWidth, 25, 3, 3, 'F');
    
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.text('✓ SIGNÉ ÉLECTRONIQUEMENT', margin + boxWidth + 25, y + 5);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text(`Le ${signedDate}`, margin + boxWidth + 25, y + 13);
  } else {
    doc.setTextColor(150, 150, 150);
    doc.text('[En attente de signature]', margin + boxWidth + 20, y + 5);
  }

  y += 35;

  // Footer
  doc.setTextColor(100, 100, 100);
  doc.setFontSize(8);
  const footerText = `Document généré le ${format(new Date(), 'dd MMMM yyyy à HH:mm', { locale: fr })} - Contrat créé le ${format(new Date(data.createdAt), 'dd MMMM yyyy', { locale: fr })}`;
  doc.text(footerText, pageWidth / 2, 285, { align: 'center' });

  // Save
  const filename = `contrat-affiliation-agentia-${data.promoCode.toLowerCase()}.pdf`;
  doc.save(filename);
}
