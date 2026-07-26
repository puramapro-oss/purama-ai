import Stripe from "stripe";
import { config } from "../config.js";
import type { ToolDefinition } from "../engine/types.js";

let stripeClient: Stripe | null = null;
function getStripe(): Stripe {
  if (!config.stripeSecretKey) throw new Error("STRIPE_SECRET_KEY non configurée côté KARTA");
  if (!stripeClient) stripeClient = new Stripe(config.stripeSecretKey);
  return stripeClient;
}

/** Utilisé par l'agent Comptable pour lister les factures impayées à relancer (lecture seule, non sensible). */
export const stripeListUnpaidInvoicesTool: ToolDefinition<{ customerEmail?: string }, { invoices: Array<{ id: string; amountDue: number; dueDate: number | null }> }> = {
  name: "stripe_list_unpaid_invoices",
  description: "Liste les factures Stripe impayées (optionnellement filtrées par email client).",
  sensitive: false,
  async execute(params) {
    const stripe = getStripe();
    const invoices = await stripe.invoices.list({
      status: "open",
      limit: 20,
      ...(params.customerEmail ? { customer: undefined } : {}),
    });

    const filtered = params.customerEmail
      ? invoices.data.filter((inv) => inv.customer_email === params.customerEmail)
      : invoices.data;

    return {
      invoices: filtered.map((inv) => ({ id: inv.id ?? "", amountDue: inv.amount_due, dueDate: inv.due_date })),
    };
  },
};
