// Purama AI — plans, limits & Stripe price IDs (V2 — 2026-04-07)
// All plans include the Compta module by default.

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
    name: 'Free',
    tagline: 'Découvre Purama sans engagement',
    monthly_price: 0,
    yearly_price_per_month: 0,
    yearly_total: 0,
    agents_included: 1,
    custom_agents_max: 1,
    monthly_executions: 500,
    features: [
      '1 agent IA Purama au choix',
      '1 agent custom',
      '500 exécutions / mois',
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
    monthly_price: 29.99,
    yearly_price_per_month: 20.09,
    yearly_total: 241.08,
    agents_included: 5,
    custom_agents_max: 5,
    monthly_executions: 5_000,
    features: [
      '5 agents IA Purama au choix',
      '5 agents custom',
      '5 000 exécutions / mois',
      'Module compta inclus',
      'Notifications prioritaires',
      'Support email < 24h',
      '14 jours d\'essai gratuit',
    ],
    monthly_price_id: 'price_1TJMWX4Y1unNvKtXJZdCt6hn',
    yearly_price_id: 'price_1TJMWY4Y1unNvKtX7nGABBzO',
    product_id: 'prod_UHwPcnEEVEDf4K',
  },

  pro: {
    id: 'pro',
    name: 'Pro',
    tagline: 'Le choix des entrepreneurs sérieux',
    monthly_price: 69,
    yearly_price_per_month: 46.23,
    yearly_total: 554.76,
    agents_included: -1, // tous
    custom_agents_max: 20,
    monthly_executions: 50_000,
    features: [
      'TOUS les agents IA Purama',
      '20 agents custom',
      '50 000 exécutions / mois',
      'Module compta complet',
      'Marketplace agents',
      'Support prioritaire',
      'API complète',
      '14 jours d\'essai gratuit',
    ],
    highlight: true,
    monthly_price_id: 'price_1TJMWZ4Y1unNvKtXba2s1RPh',
    yearly_price_id: 'price_1TJMWZ4Y1unNvKtXUSL85FyO',
    product_id: 'prod_UHwPSU2o4DW6Ej',
  },

  ultime: {
    id: 'ultime',
    name: 'Ultime',
    tagline: 'Zéro limite. Pour tout automatiser.',
    monthly_price: 99.99,
    yearly_price_per_month: 66.99,
    yearly_total: 803.88,
    agents_included: -1,
    custom_agents_max: 100,
    monthly_executions: 1_000_000,
    features: [
      'TOUS les agents IA Purama',
      '100 agents custom',
      '1 000 000 exécutions / mois',
      'Module compta complet',
      'Tous les modules à venir',
      'Support VIP 24/7',
      'API complète + webhooks',
      'White-label disponible',
      '14 jours d\'essai gratuit',
    ],
    monthly_price_id: 'price_1TJMWb4Y1unNvKtXCRJZkUSz',
    yearly_price_id: 'price_1TJMWb4Y1unNvKtX1I1Ib1tp',
    product_id: 'prod_UHwPBOGTleT37J',
  },
};

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
