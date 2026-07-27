// Purama AI — plans, limits & Stripe price IDs (V3 — 2026-07-27, brief "PRICING & OFFRE IRRÉSISTIBLE")
// 1 SEULE source de vérité pour les plans — consommée par usage.ts (quotas), Pricing.tsx/PricingSection
// (affichage + checkout), useSubscription.ts (état réel Stripe), stripe-webhook (écriture DB).
// Jamais d'« illimité » (agents_included=-1 signifie "tous les agents du catalogue", pas illimité).

export type PlanId = 'free' | 'starter' | 'pro' | 'ultime';

export interface Plan {
  id: PlanId;
  name: string;
  tagline: string;
  monthly_price: number; // €
  yearly_price_per_month: number; // € (yearly total / 12)
  yearly_total: number; // € total billed yearly
  agents_included: number; // max preset agents the user can activate (-1 = all)
  custom_agents_max: number; // creator agents
  monthly_executions: number;
  features: string[];
  highlight?: boolean;
  // Stripe IDs
  monthly_price_id: string | null;
  yearly_price_id: string | null;
  product_id: string | null;
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Découverte',
    tagline: 'Goûte à Purama, sans engagement',
    monthly_price: 0,
    yearly_price_per_month: 0,
    yearly_total: 0,
    agents_included: 1,
    custom_agents_max: 1,
    monthly_executions: 100,
    features: [
      '1 employé IA au choix',
      '1 agent custom',
      '100 actions / mois',
      'Module compta inclus',
      'Notifications push & email',
      'Communauté Discord',
    ],
    monthly_price_id: null,
    yearly_price_id: null,
    product_id: null,
  },

  starter: {
    id: 'starter',
    name: 'Starter',
    tagline: 'Lance ton automatisation',
    monthly_price: 33,
    yearly_price_per_month: 27.5,
    yearly_total: 330,
    agents_included: 5,
    custom_agents_max: 5,
    monthly_executions: 1_500,
    features: [
      '5 employés IA au choix',
      '5 agents custom',
      '1 500 actions / mois',
      'Module compta inclus',
      'Notifications prioritaires',
      'Support email < 24h',
      '14 jours d\'essai Premium gratuit, sans carte',
    ],
    monthly_price_id: 'price_1TxuHo4Y1unNvKtXhx3LhtPW',
    yearly_price_id: 'price_1TxuHo4Y1unNvKtXX4yZ3BlN',
    product_id: 'prod_UHwPcnEEVEDf4K',
  },

  pro: {
    id: 'pro',
    name: 'Premium',
    tagline: 'Le choix des entrepreneurs sérieux',
    monthly_price: 99,
    yearly_price_per_month: 82.5,
    yearly_total: 990,
    agents_included: -1, // tous
    custom_agents_max: 20,
    monthly_executions: 6_000,
    features: [
      'TOUS les employés IA',
      '20 agents custom',
      '6 000 actions / mois',
      'Module compta complet',
      'Marketplace agents',
      'Support prioritaire',
      'API complète',
      '14 jours d\'essai gratuit, sans carte',
    ],
    highlight: true,
    monthly_price_id: 'price_1TxuHo4Y1unNvKtXJJRsMOIR',
    yearly_price_id: 'price_1TxuHp4Y1unNvKtX1x0UT3ri',
    product_id: 'prod_UHwPSU2o4DW6Ej',
  },

  ultime: {
    id: 'ultime',
    name: 'Ultime',
    tagline: 'Tout, en priorité, sans limite basse.',
    monthly_price: 199,
    yearly_price_per_month: 165.83,
    yearly_total: 1_990,
    agents_included: -1,
    custom_agents_max: 100,
    monthly_executions: 15_000,
    features: [
      'TOUS les employés IA',
      '100 agents custom',
      '15 000 actions / mois',
      'Module compta complet',
      'Traitement prioritaire (file d\'attente)',
      'Agent Créateur d\'Agents en illimité',
      'Support VIP prioritaire',
      'API complète + webhooks',
      '14 jours d\'essai gratuit, sans carte',
    ],
    monthly_price_id: 'price_1TxuHp4Y1unNvKtXU2bagDZs',
    yearly_price_id: 'price_1TxuHp4Y1unNvKtXcUIp2Qxb',
    product_id: 'prod_UHwPBOGTleT37J',
  },
};

/** Pack de dépassement — achat ponctuel, +2000 actions ajoutées au quota du mois en cours. */
export const OVERAGE_PACK = {
  actions: 2_000,
  price: 19,
  price_id: 'price_1TxuIO4Y1unNvKtXRito4dsU',
  product_id: 'prod_Uxpyoimsz3Nkbj',
} as const;

export const PLAN_LIST: Plan[] = ['free', 'starter', 'pro', 'ultime'].map(id => PLANS[id as PlanId]);

export function getPlan(planType: string | null | undefined): Plan {
  if (!planType) return PLANS.free;
  const normalized = planType.toLowerCase();
  if (normalized === 'enterprise') return PLANS.ultime; // legacy alias
  if (normalized in PLANS) return PLANS[normalized as PlanId];
  return PLANS.free;
}

export function isUnlimitedAgents(plan: Plan): boolean {
  return plan.agents_included === -1;
}
