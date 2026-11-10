import jsPDF from 'jspdf';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';

interface ContractData {
  beneficiaryName: string;
  promoCode: string;
  commissionRate: number;
}

/** The account exposes current fields, not the original signed PDF or a terms
 * version. Keep the download informative; it must never attest an old signature.
 */
export function generateContractPdf(data: ContractData): void {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 20;
  const contentWidth = pageWidth - margin * 2;
  const generatedAt = format(new Date(), 'dd MMMM yyyy à HH:mm', { locale: fr });
  let y = 55;

  doc.setProperties({
    title: "Récapitulatif d'affiliation non signé",
    subject: 'Informations actuelles du compte, sans preuve de signature',
    creator: 'PURAMA',
  });
  doc.setFillColor(124, 58, 237);
  doc.rect(0, 0, pageWidth, 40, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text("Récapitulatif d'affiliation", margin, 22);
  doc.setFontSize(11);
  doc.text('DOCUMENT NON SIGNÉ', margin, 32);

  const paragraph = (text: string) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(40, 40, 40);
    const lines: string[] = doc.splitTextToSize(text, contentWidth);
    for (const line of lines) {
      if (y > pageHeight - 28) { doc.addPage(); y = margin; }
      doc.text(line, margin, y);
      y += 5;
    }
    y += 8;
  };

  const section = (title: string, text: string) => {
    if (y > pageHeight - 45) { doc.addPage(); y = margin; }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(40, 40, 40);
    doc.text(title, margin, y);
    y += 7;
    paragraph(text);
  };

  paragraph('Ce récapitulatif présente les informations actuelles du compte. Il ne constitue ni un contrat signé ni une preuve des conditions acceptées antérieurement.');
  section('Bénéficiaire', data.beneficiaryName);
  section("Code d'invitation", data.promoCode);
  section('Taux enregistré dans le compte', `${data.commissionRate} %. Les conditions de rémunération applicables doivent être vérifiées dans le contrat original.`);
  section('Prix et conditions', 'Consultez les prix et conditions applicables à cette invitation avant tout paiement. Aucun taux de remise ni aucune durée promotionnelle ne sont établis par ce récapitulatif.');
  section('Copie historique du contrat', 'Pour consulter les conditions signées et leur preuve de signature, le document original doit être récupéré. Ce téléchargement fournit uniquement un récapitulatif actuel non signé.');

  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    doc.setTextColor(100, 100, 100);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text(`NON SIGNÉ - Généré le ${generatedAt} - ${page}/${pages}`, pageWidth / 2, pageHeight - 12, { align: 'center' });
  }

  doc.save(`recapitulatif-affiliation-${data.promoCode.toLowerCase()}.pdf`);
}
