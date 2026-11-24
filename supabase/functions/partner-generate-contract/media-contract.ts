/** Media terms are an explicit commercial annex, never values invented by a model. */
export const mediaContractTermFields = [
  ["parties_identity", "Identité et capacité des parties"],
  ["products_and_countries", "Produits et territoires admissibles"],
  ["attribution", "Attribution des ventes"],
  ["recurrence", "Échéances récurrentes admissibles"],
  ["payment", "Relevés, facturation, devise et règlement"],
  ["refunds", "Retours, annulations et remboursements"],
  ["duration_termination", "Durée et résiliation"],
  ["content_rights", "Contenus et droits d’utilisation"],
  ["costs", "Répartition des coûts"],
  ["disputes", "Réclamations et règlement des différends"],
] as const;

type Reason = "media_contract_terms_incomplete" | "media_contract_terms_invalid"
  | "media_contract_offer_invalid" | "media_contract_rate_mismatch"
  | "media_contract_version_invalid" | "media_contract_identity_invalid"
  | "editorial_contract_not_applicable" | "contract_profile_invalid";

export class MediaPartnerContractError extends Error {
  constructor(readonly reason: Reason) {
    super(reason);
    this.name = "MediaPartnerContractError";
  }
}

const row = (value: unknown): Record<string, unknown> | null => value !== null
  && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const unsafeControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function identity(value: unknown, email = false): string {
  if (typeof value !== "string" || !value.trim() || value.length > (email ? 254 : 200)
    || /[\r\n]/.test(value) || unsafeControls.test(value)
    || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) {
    throw new MediaPartnerContractError("media_contract_identity_invalid");
  }
  return value;
}

/** A deterministic draft; exact-PDF approval and dispatch stay in the existing handler. */
export function buildMediaPartnerContractText(snapshot: Record<string, unknown>, date: string): string {
  if (snapshot.outreach_profile === "editorial") {
    throw new MediaPartnerContractError("editorial_contract_not_applicable");
  }
  if (snapshot.outreach_profile !== "media_affiliate") {
    throw new MediaPartnerContractError("contract_profile_invalid");
  }
  if (snapshot.media_terms_version !== "20261124" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new MediaPartnerContractError("media_contract_version_invalid");
  }
  if (snapshot.commission_first_payment !== 30 || snapshot.commission_recurring !== 30) {
    throw new MediaPartnerContractError("media_contract_rate_mismatch");
  }
  const company = identity(snapshot.company_name);
  const sender = identity(snapshot.sender_name);
  const senderEmail = identity(snapshot.sender_email, true);
  const recipient = identity(snapshot.recipient_name);
  const recipientEmail = identity(snapshot.recipient_email, true);
  const offer = row(snapshot.eligible_offer);
  if (!offer || typeof offer.name !== "string" || !offer.name.trim() || offer.name.length > 200
    || /[\r\n]/.test(offer.name) || unsafeControls.test(offer.name)
    || typeof offer.url !== "string" || offer.url.length > 2048 || /[\s\u0000-\u001f]/.test(offer.url)) {
    throw new MediaPartnerContractError("media_contract_offer_invalid");
  }
  try {
    const url = new URL(offer.url);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("invalid_offer_url");
  } catch { throw new MediaPartnerContractError("media_contract_offer_invalid"); }
  const terms = row(snapshot.media_contract_terms);
  if (!terms || mediaContractTermFields.some(([key]) => typeof terms[key] !== "string"
    || String(terms[key]).trim().length < 10)) {
    throw new MediaPartnerContractError("media_contract_terms_incomplete");
  }
  const keys = new Set<string>(mediaContractTermFields.map(([key]) => key));
  if (Object.keys(terms).some(key => !keys.has(key)) || mediaContractTermFields.some(([key]) =>
    String(terms[key]).length > 2000 || unsafeControls.test(String(terms[key])))) {
    throw new MediaPartnerContractError("media_contract_terms_invalid");
  }
  const clauses = mediaContractTermFields.map(([key, title], index) =>
    `${index + 1}. ${title}\n${terms[key]}`).join("\n\n");
  const text = `PROJET DE CONVENTION DE PARTENARIAT MÉDIAS
Version des conditions : 20261124. Date de préparation : ${date}.
Ce projet doit être relu et approuvé dans sa version PDF exacte avant toute demande de signature. Sa préparation ne vaut ni accord ni signature.

PARTIES ET OFFRE
Annonceur : ${company}.
Représentant renseigné : ${sender} (${senderEmail}).
Partenaire : ${recipient} (${recipientEmail}).
Offre concernée : ${offer.name}.
Page de référence : ${offer.url}.

RÈGLE DE COMMISSION
Le partenaire reçoit 30 % des ventes admissibles qui lui sont attribuées. L’assiette correspond au montant hors taxes effectivement encaissé pour les produits admissibles, après remises et remboursements, avant déduction des frais du prestataire de paiement. Les taxes et les sommes étrangères aux produits admissibles ne deviennent pas commissionnables par leur présence dans un paiement.
Le taux du premier paiement admissible est de 30 %. Le taux des échéances récurrentes admissibles de l’abonnement apporté est également de 30 %, dans la portée et la durée précisées ci-dessous. Ce projet ne crée aucun droit automatique sur tous les achats futurs du client. Il ne cumule pas deux commissions d’apport pour la même vente et ne rémunère pas le seul recrutement d’un partenaire.
La TVA éventuellement applicable à la prestation du partenaire est traitée selon sa situation et les modalités de facturation convenues. La commission n’est pas calculée sur le bénéfice et aucun revenu minimum n’est garanti.

NATURE DE LA COLLABORATION
La collaboration commerciale doit être identifiée comme telle dans les contenus et selon les règles applicables au support et au pays. Elle ne rémunère pas une couverture rédactionnelle indépendante et n’impose pas une appréciation positive fictive. Aucune exclusivité, aucun stock obligatoire ni droit publicitaire illimité n’est présumé par le présent modèle.

CONDITIONS PARTICULIÈRES PROPOSÉES
${clauses}

APPROBATION ET SIGNATURES
Les parties vérifient notamment les produits, territoires, règles d’attribution, échéances, coûts et droits de contenu ci-dessus. Toute modification des conditions exige une nouvelle version soumise à l’approbation avant son envoi pour signature. La signature du partenaire reste distincte de l’approbation de l’annonceur.`;
  if (text.length > 40_000) throw new MediaPartnerContractError("media_contract_terms_invalid");
  return text;
}
