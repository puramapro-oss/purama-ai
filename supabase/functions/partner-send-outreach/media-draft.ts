/** Verified product facts and commercial terms are rendered, never invented by a model. */
type Row = Record<string, unknown>;
type Copy = {
  greeting: string; assistant: string; introduction: string; followup: string;
  commercial: string; editorial: string; question: string; stop: string;
};
const copies: Record<string, Copy> = {
  fr: {
    greeting: 'Bonjour', assistant: 'Je suis IAO, l’assistant IA chargé des partenariats de',
    introduction: 'Je vous propose de découvrir cette offre :', followup: 'Je reviens sur notre proposition avec la fiche de référence :',
    commercial: 'Le partenariat proposé prévoit 30 % sur les ventes éligibles qui vous sont attribuées, sur une base hors taxes après remises et remboursements, avant frais de paiement. Les produits, l’attribution, les échéances récurrentes éventuelles et le règlement sont définis dans la convention. Aucun revenu minimum n’est garanti.',
    editorial: 'Il s’agit d’une proposition de sujet indépendante. Vous gardez votre appréciation du produit et votre liberté de traitement.',
    question: 'Souhaitez-vous recevoir une présentation adaptée à votre public ?',
    stop: 'Pour ne plus recevoir ces propositions, répondez simplement à ce message.',
  },
  en: {
    greeting: 'Hello', assistant: 'I am IAO, the AI partnerships assistant for',
    introduction: 'I would like to introduce this offer:', followup: 'I am following up with the reference page for our proposal:',
    commercial: 'The proposed partnership pays 30% of eligible sales attributed to you, excluding tax and after discounts and refunds, before payment processing fees. Eligible products, attribution, any recurring payments and settlement are defined in the agreement. No minimum income is guaranteed.',
    editorial: 'This is an independent editorial suggestion. You retain your own assessment of the product and editorial freedom.',
    question: 'Would you like a presentation tailored to your audience?',
    stop: 'To stop receiving these proposals, simply reply to this message.',
  },
  de: {
    greeting: 'Guten Tag', assistant: 'Ich bin IAO, der KI-Assistent für Partnerschaften von',
    introduction: 'Ich möchte Ihnen folgendes Angebot vorstellen:', followup: 'Ich komme auf unseren Vorschlag zurück und sende Ihnen die Referenzseite:',
    commercial: 'Die vorgeschlagene Partnerschaft sieht 30 % der Ihnen zugeordneten, berechtigten Verkäufe vor: ohne Steuern, nach Rabatten und Erstattungen, vor Zahlungsgebühren. Produkte, Zuordnung, gegebenenfalls wiederkehrende Zahlungen und Abrechnung werden im Vertrag festgelegt. Ein Mindesteinkommen wird nicht garantiert.',
    editorial: 'Dies ist ein unabhängiger Themenvorschlag. Ihre Bewertung des Produkts und Ihre redaktionelle Freiheit bleiben erhalten.',
    question: 'Möchten Sie eine auf Ihr Publikum abgestimmte Präsentation erhalten?',
    stop: 'Wenn Sie keine weiteren Vorschläge erhalten möchten, antworten Sie bitte auf diese Nachricht.',
  },
  es: {
    greeting: 'Hola', assistant: 'Soy IAO, el asistente de IA para colaboraciones de',
    introduction: 'Me gustaría presentarles esta oferta:', followup: 'Retomo nuestra propuesta con la página de referencia:',
    commercial: 'La colaboración propuesta ofrece un 30 % de las ventas elegibles atribuidas a ustedes, sin impuestos, después de descuentos y reembolsos y antes de las comisiones de pago. El contrato define los productos, la atribución, los posibles pagos recurrentes y la liquidación. No se garantiza un ingreso mínimo.',
    editorial: 'Es una propuesta editorial independiente. Conservan su valoración del producto y su libertad editorial.',
    question: '¿Les gustaría recibir una presentación adaptada a su público?',
    stop: 'Para dejar de recibir estas propuestas, basta con responder a este mensaje.',
  },
  it: {
    greeting: 'Buongiorno', assistant: 'Sono IAO, l’assistente IA per le collaborazioni di',
    introduction: 'Vorrei presentarvi questa offerta:', followup: 'Riprendo la nostra proposta con la pagina di riferimento:',
    commercial: 'La collaborazione proposta prevede il 30% delle vendite ammissibili attribuite a voi, al netto delle imposte, dopo sconti e rimborsi e prima delle commissioni di pagamento. Prodotti, attribuzione, eventuali pagamenti ricorrenti e liquidazione sono definiti nel contratto. Non è garantito un reddito minimo.',
    editorial: 'Si tratta di una proposta editoriale indipendente. Restano libere la vostra valutazione del prodotto e le vostre scelte editoriali.',
    question: 'Desiderate ricevere una presentazione adatta al vostro pubblico?',
    stop: 'Per non ricevere più queste proposte, rispondete a questo messaggio.',
  },
  pt: {
    greeting: 'Olá', assistant: 'Sou IAO, o assistente de IA para parcerias da',
    introduction: 'Gostaria de apresentar esta oferta:', followup: 'Retomo a nossa proposta com a página de referência:',
    commercial: 'A parceria proposta oferece 30% das vendas elegíveis atribuídas a vocês, sem impostos, após descontos e reembolsos e antes das taxas de pagamento. Os produtos, a atribuição, os eventuais pagamentos recorrentes e a liquidação são definidos no contrato. Não há garantia de rendimento mínimo.',
    editorial: 'Trata-se de uma sugestão editorial independente. A avaliação do produto e a liberdade editorial permanecem com vocês.',
    question: 'Gostariam de receber uma apresentação adaptada ao seu público?',
    stop: 'Para deixar de receber estas propostas, basta responder a esta mensagem.',
  },
};
export const mediaDraftLanguages = Object.freeze(Object.keys(copies));
export class MediaDraftError extends Error {
  constructor(readonly reason: string) { super(reason); }
}
function object(value: unknown): Row | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
}
function hasUnsafeControls(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13)) return true;
  }
  return false;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max
    || hasUnsafeControls(value)) throw new MediaDraftError('offer_required');
  return value.trim();
}
function escape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
export function buildMediaOutreachDraft(prospect: Row, cfg: Row, step: string): { subject: string; body_html: string } | null {
  const profile = prospect.outreach_profile ?? 'legacy';
  if (profile === 'legacy') return null;
  if (profile !== 'media_affiliate' && profile !== 'editorial') throw new MediaDraftError('campaign_role_mismatch');
  if (!['editorial', 'commercial', 'creator', 'venue'].includes(String(prospect.contact_role))) throw new MediaDraftError('contact_role_required');
  if ((profile === 'editorial') !== (prospect.contact_role === 'editorial')) throw new MediaDraftError('campaign_role_mismatch');
  if (!['outreach', 'relance_1', 'relance_2'].includes(step)) throw new MediaDraftError('media_followup_limit');
  const qualification = object(prospect.contact_qualification);
  const language = typeof qualification?.language === 'string' ? qualification.language.split('-')[0] : '';
  const copy = copies[language];
  if (!copy) throw new MediaDraftError('outreach_language_unsupported');
  const offer = object(prospect.outreach_offer);
  if (!offer) throw new MediaDraftError('offer_required');
  const name = text(offer.name, 200);
  const summary = text(offer.summary, 1500);
  if (/[\r\n\t]/.test(name) || summary.length < 10) throw new MediaDraftError('offer_required');
  const urlText = text(offer.url, 2048);
  let url: URL;
  try { url = new URL(urlText); } catch { throw new MediaDraftError('offer_required'); }
  if (url.protocol !== 'https:' || url.username || url.password || /[\\\s<>"]/.test(urlText)) throw new MediaDraftError('offer_required');
  const company = text(cfg.company_name, 200);
  const recipient = text(prospect.name, 200);
  if (/[\r\n]/.test(company)) throw new MediaDraftError('invalid_sender');
  if (/[\r\n]/.test(recipient)) throw new MediaDraftError('invalid_recipient');
  const human = cfg.outreach_identity_mode === 'human_reviewed';
  if (human && cfg.require_approval_outreach !== true) throw new MediaDraftError('human_review_required');
  const parts = [`${copy.greeting} ${recipient},`,
    ...(!human ? [`${copy.assistant} ${company}.`] : []),
    step === 'outreach' ? copy.introduction : copy.followup, summary];
  const html = parts.map(value => `<p>${escape(value)}</p>`).join('')
    + `<p><a href="${escape(url.href)}">${escape(name)}</a></p>`
    + `<p>${escape(profile === 'media_affiliate' ? copy.commercial : copy.editorial)}</p>`
    + `<p>${escape(copy.question)}</p>`
    + `<p>${escape(human ? text(cfg.sender_name, 200) : `IAO — ${company}`)}</p>`
    + `<p>${escape(copy.stop)}</p>`;
  return { subject: `${company} · ${name}`.replace(/[\r\n]/g, ' ').slice(0, 200), body_html: html };
}
