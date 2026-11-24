import { hasReplyControls } from './reply-message.ts';
type Row = Record<string, unknown>;
export type ReplyIntent = 'request_details' | 'share_offer';
type Copy = { greeting: string; identity: string; thanks: string; details: string; offer: string;
  commercial: string; editorial: string; next: string; stop: string };
const copies: Record<string, Copy> = {
  fr: { greeting: 'Bonjour', identity: 'Je suis IAO, l’assistant IA chargé des partenariats de',
    thanks: 'Merci pour votre réponse.', details: 'Pour préparer une présentation utile, pouvez-vous préciser le public concerné, les formats qui vous intéressent et les informations dont vous avez besoin ?',
    offer: 'Voici la fiche de référence de l’offre :', commercial: 'La proposition prévoit 30 % des ventes éligibles qui vous sont attribuées, sur une base hors taxes après remises et remboursements, avant frais de paiement. Les produits, l’attribution, les échéances récurrentes éventuelles et le règlement restent définis par la convention. Aucun revenu minimum n’est garanti.',
    editorial: 'Vous conservez votre liberté de traitement et d’appréciation. Cette proposition éditoriale ne prévoit pas de commission.',
    next: 'Vous pouvez nous préciser les points que vous souhaitez examiner. Ce message ne vaut ni signature ni activation du partenariat.',
    stop: 'Pour ne plus recevoir ces propositions, répondez simplement à ce message.' },
  en: { greeting: 'Hello', identity: 'I am IAO, the AI partnerships assistant for',
    thanks: 'Thank you for your reply.', details: 'To prepare a useful presentation, could you tell us about the audience, the formats that interest you and the information you need?',
    offer: 'Here is the reference page for the offer:', commercial: 'The proposal provides 30% of eligible sales attributed to you, excluding tax and after discounts and refunds, before payment processing fees. Eligible products, attribution, any recurring payments and settlement remain defined by the agreement. No minimum income is guaranteed.',
    editorial: 'You retain your editorial freedom and your own assessment. This editorial suggestion does not include a commission.',
    next: 'Please tell us which points you would like to review. This message does not sign or activate a partnership.',
    stop: 'To stop receiving these proposals, simply reply to this message.' },
  de: { greeting: 'Guten Tag', identity: 'Ich bin IAO, der KI-Assistent für Partnerschaften von',
    thanks: 'Vielen Dank für Ihre Antwort.', details: 'Für eine hilfreiche Präsentation: Welche Zielgruppe, Formate und Informationen sind für Sie interessant?',
    offer: 'Hier finden Sie die Referenzseite des Angebots:', commercial: 'Der Vorschlag sieht 30 % der Ihnen zugeordneten, berechtigten Verkäufe vor: ohne Steuern, nach Rabatten und Erstattungen, vor Zahlungsgebühren. Produkte, Zuordnung, gegebenenfalls wiederkehrende Zahlungen und Abrechnung werden im Vertrag festgelegt. Ein Mindesteinkommen wird nicht garantiert.',
    editorial: 'Ihre redaktionelle Freiheit und Ihre eigene Bewertung bleiben erhalten. Dieser redaktionelle Vorschlag enthält keine Provision.',
    next: 'Teilen Sie uns bitte mit, welche Punkte Sie prüfen möchten. Diese Nachricht unterzeichnet oder aktiviert keine Partnerschaft.',
    stop: 'Wenn Sie keine weiteren Vorschläge erhalten möchten, antworten Sie bitte auf diese Nachricht.' },
  es: { greeting: 'Hola', identity: 'Soy IAO, el asistente de IA para colaboraciones de',
    thanks: 'Gracias por su respuesta.', details: 'Para preparar una presentación útil, ¿podrían indicar el público, los formatos que les interesan y la información que necesitan?',
    offer: 'Esta es la página de referencia de la oferta:', commercial: 'La propuesta ofrece un 30 % de las ventas elegibles atribuidas a ustedes, sin impuestos, después de descuentos y reembolsos y antes de las comisiones de pago. El contrato define los productos, la atribución, los posibles pagos recurrentes y la liquidación. No se garantiza un ingreso mínimo.',
    editorial: 'Conservan su libertad editorial y su propia valoración. Esta propuesta editorial no incluye una comisión.',
    next: 'Indiquen los puntos que desean examinar. Este mensaje no firma ni activa una colaboración.',
    stop: 'Para dejar de recibir estas propuestas, basta con responder a este mensaje.' },
  it: { greeting: 'Buongiorno', identity: 'Sono IAO, l’assistente IA per le collaborazioni di',
    thanks: 'Grazie per la vostra risposta.', details: 'Per preparare una presentazione utile, potete indicare il pubblico, i formati di interesse e le informazioni necessarie?',
    offer: 'Ecco la pagina di riferimento dell’offerta:', commercial: 'La proposta prevede il 30% delle vendite ammissibili attribuite a voi, al netto delle imposte, dopo sconti e rimborsi e prima delle commissioni di pagamento. Prodotti, attribuzione, eventuali pagamenti ricorrenti e liquidazione sono definiti nel contratto. Non è garantito un reddito minimo.',
    editorial: 'Conservate la libertà editoriale e la vostra valutazione. Questa proposta editoriale non include una commissione.',
    next: 'Indicate i punti che desiderate esaminare. Questo messaggio non firma né attiva una collaborazione.',
    stop: 'Per non ricevere più queste proposte, rispondete a questo messaggio.' },
  pt: { greeting: 'Olá', identity: 'Sou IAO, o assistente de IA para parcerias da',
    thanks: 'Obrigado pela resposta.', details: 'Para preparar uma apresentação útil, podem indicar o público, os formatos que interessam e as informações necessárias?',
    offer: 'Esta é a página de referência da oferta:', commercial: 'A proposta oferece 30% das vendas elegíveis atribuídas a vocês, sem impostos, após descontos e reembolsos e antes das taxas de pagamento. Os produtos, a atribuição, os eventuais pagamentos recorrentes e a liquidação são definidos no contrato. Não há garantia de rendimento mínimo.',
    editorial: 'Mantêm a liberdade editorial e a própria avaliação. Esta proposta editorial não inclui comissão.',
    next: 'Indiquem os pontos que desejam examinar. Esta mensagem não assina nem ativa uma parceria.',
    stop: 'Para deixar de receber estas propostas, basta responder a esta mensagem.' },
};
const record = (value: unknown): Row | null => value !== null && typeof value === 'object'
  && !Array.isArray(value) ? value as Row : null;
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || hasReplyControls(value, true)) throw new Error('reply_context_unverified');
  return value.trim();
}
export function buildPartnerReplyDraft(prospect: Row, config: Row, intent: ReplyIntent): string {
  if (!['request_details', 'share_offer'].includes(intent)) throw new Error('invalid_reply_intent');
  if (!['media_affiliate', 'editorial'].includes(String(prospect.outreach_profile))) throw new Error('media_profile_required');
  const language = String(record(prospect.contact_qualification)?.language ?? '').split('-')[0];
  const copy = copies[language];
  if (!copy) throw new Error('outreach_language_unsupported');
  const name = text(prospect.name, 200), company = text(config.company_name, 200);
  if (hasReplyControls(name) || hasReplyControls(company)) throw new Error('reply_context_unverified');
  const parts = [`${copy.greeting} ${name},`, `${copy.identity} ${company}.`, copy.thanks];
  if (intent === 'request_details') parts.push(copy.details);
  else {
    const offer = record(prospect.outreach_offer);
    const offerName = text(offer?.name, 200), summary = text(offer?.summary, 1500), link = text(offer?.url, 2048);
    const url = new URL(link);
    if (url.protocol !== 'https:' || url.username || url.password || /[\\\s<>"]/.test(link)
      || hasReplyControls(offerName) || summary.length < 10) throw new Error('offer_required');
    parts.push(copy.offer, `${offerName}\n${summary}\n${url.href}`,
      prospect.outreach_profile === 'editorial' ? copy.editorial : copy.commercial, copy.next);
  }
  parts.push(`IAO — ${company}`, copy.stop);
  return parts.join('\n\n');
}
