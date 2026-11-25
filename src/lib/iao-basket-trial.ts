/** Integer quantities and prices apply to the offers entered for this trial. */
export const BASKET_TRIAL_LIMITS = { maxUnits: 4096, maxOffers: 64, maxPriceCents: 100_000_000 } as const;

export interface BasketOffer {
  id: string;
  label: string;
  unitsPerLot: number;
  priceCents: number;
  stockLots?: number | null | 'unlimited';
}

export interface BasketTrialInput {
  requiredUnits: number;
  budgetCents: number;
  offers: readonly BasketOffer[];
}

export interface BasketAllocation {
  offerId: string;
  label: string;
  lots: number;
  units: number;
  costCents: number;
}

export interface BasketTrialResult {
  status: 'feasible' | 'impossible' | 'unknown';
  message: string;
  certificate: string;
  allocation: BasketAllocation[];
  totalUnits: number | null;
  totalCostCents: number | null;
  /** Exact minimum when it is independent of any missing stock declaration. */
  minimumCostCents: number | null;
  /** Optimistic minimum if all unknown stocks were sufficient. */
  lowerBoundCents: number | null;
  /** Extra budget needed above the stated ceiling, if the exact minimum is known. */
  budgetGapCents: number | null;
}

const currency = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const euros = (cents: number) => currency.format(cents / 100);
const integer = (v: number, low: number, high = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= low && v <= high;

function validate(input: BasketTrialInput): string | null {
  if (!input || !integer(input.requiredUnits, 0, BASKET_TRIAL_LIMITS.maxUnits)) return 'La quantité exacte doit être un entier entre 0 et 4 096.';
  if (!integer(input.budgetCents, 0)) return 'Le budget doit être un entier positif ou nul, en centimes.';
  if (!Array.isArray(input.offers) || input.offers.length > BASKET_TRIAL_LIMITS.maxOffers) return 'Le calcul accepte au plus 64 offres.';
  const ids = new Set<string>();
  for (const offer of input.offers) {
    if (!offer || typeof offer.id !== 'string' || !offer.id.trim() || ids.has(offer.id) || typeof offer.label !== 'string' || !offer.label.trim()) return 'Chaque offre doit avoir un nom et un identifiant unique.';
    if (!integer(offer.unitsPerLot, 1) || !integer(offer.priceCents, 0, BASKET_TRIAL_LIMITS.maxPriceCents)) return 'Vérifiez les unités par lot et le prix entier en centimes (100 000 000 au maximum).';
    if (offer.stockLots != null && offer.stockLots !== 'unlimited' && !integer(offer.stockLots, 0)) return 'Le stock doit être un nombre entier de lots, inconnu ou explicitement illimité.';
    ids.add(offer.id);
  }
  return null;
}

/** Bounded knapsack for every exact quantity. Descending traversal uses each binary bundle once. */
function exactPrices({ requiredUnits, offers }: BasketTrialInput, allowUnknown: boolean) {
  const costs = new Float64Array(requiredUnits + 1).fill(Infinity);
  costs[0] = 0;
  const choices = offers.map(offer => {
    const selected = new Uint16Array(requiredUnits + 1);
    const useful = Math.floor(requiredUnits / offer.unitsPerLot);
    let available = useful;
    if (typeof offer.stockLots === 'number') available = Math.min(useful, offer.stockLots);
    else if (offer.stockLots == null && !allowUnknown) available = 0;
    for (let bundle = 1; available > 0; bundle *= 2) {
      const lots = Math.min(available, bundle);
      const units = lots * offer.unitsPerLot;
      const price = lots * offer.priceCents;
      for (let quantity = requiredUnits; quantity >= units; quantity--) {
        const candidate = costs[quantity - units] + price;
        if (candidate < costs[quantity]) {
          costs[quantity] = candidate;
          selected[quantity] = selected[quantity - units] + lots;
        }
      }
      available -= lots;
    }
    return selected;
  });
  return { costs, choices };
}

function readAllocation({ requiredUnits, offers }: BasketTrialInput, choices: Uint16Array[]): BasketAllocation[] {
  const allocation: BasketAllocation[] = [];
  let remaining = requiredUnits;
  for (let i = offers.length - 1; i >= 0; i--) {
    const lots = choices[i][remaining];
    if (lots === 0) continue;
    const offer = offers[i];
    const units = lots * offer.unitsPerLot;
    allocation.push({ offerId: offer.id, label: offer.label, lots, units, costCents: lots * offer.priceCents });
    remaining -= units;
  }
  return allocation.reverse();
}

const emptyAmounts = {
  totalUnits: null, totalCostCents: null, minimumCostCents: null, lowerBoundCents: null, budgetGapCents: null,
};

export function solveBasketTrial(input: BasketTrialInput): BasketTrialResult {
  const invalid = validate(input);
  if (invalid) return { status: 'unknown', message: 'Calcul indisponible pour ces données.', certificate: invalid, allocation: [], ...emptyAmounts };

  const { requiredUnits, budgetCents, offers } = input;
  const missing = offers.filter(offer => offer.stockLots == null && offer.unitsPerLot <= requiredUnits);
  const confirmed = exactPrices(input, false);
  const optimistic = missing.length ? exactPrices(input, true) : confirmed;
  const knownPrice = confirmed.costs[requiredUnits];
  const lower = optimistic.costs[requiredUnits];
  if (!Number.isFinite(lower)) return {
    status: 'impossible', message: 'Aucune combinaison ne donne la quantité exacte.',
    certificate: `Le calcul a couvert toutes les quantités entières de 0 à ${requiredUnits}. Même avec tous les lots de stock inconnu disponibles, la quantité demandée est inaccessible. Augmenter le budget seul ne la rendrait pas possible.`,
    allocation: [], ...emptyAmounts,
  };

  const fixedMinimum = lower === knownPrice;
  const hasPlan = Number.isFinite(knownPrice);
  const amounts = {
    allocation: hasPlan ? readAllocation(input, confirmed.choices) : [],
    totalUnits: hasPlan ? requiredUnits : null,
    totalCostCents: hasPlan ? knownPrice : null,
    minimumCostCents: fixedMinimum ? knownPrice : null,
    lowerBoundCents: lower,
    budgetGapCents: fixedMinimum ? Math.max(0, knownPrice - budgetCents) : null,
  };
  if (knownPrice <= budgetCents) return {
    status: 'feasible', message: `Panier confirmé pour exactement ${requiredUnits} pièces à ${euros(knownPrice)}.`,
    certificate: fixedMinimum ? `Prix minimal démontré pour les offres saisies : ${euros(knownPrice)}. Le calcul compare toutes les combinaisons admissibles de lots entiers.` : `Le stock déclaré suffit à ce prix. Selon les disponibilités encore inconnues, le minimum peut descendre jusqu’à ${euros(lower)}.`, ...amounts,
  };

  if (lower > budgetCents) {
    let explanation = fixedMinimum
      ? `Minimum démontré : ${euros(knownPrice)}. Il manque ${euros(knownPrice - budgetCents)} au budget.`
      : `Même en supposant les stocks inconnus suffisants, le prix atteint au moins ${euros(lower)}. Le budget est inférieur d’au moins ${euros(lower - budgetCents)}.`;
    if (fixedMinimum) {
      const oneMore = offers.find(offer => typeof offer.stockLots === 'number' && offer.unitsPerLot <= requiredUnits && confirmed.costs[requiredUnits - offer.unitsPerLot] + offer.priceCents <= budgetCents);
      if (oneMore) explanation += ` Un lot supplémentaire de « ${oneMore.label} » permettrait de respecter le budget à ${euros(confirmed.costs[requiredUnits - oneMore.unitsPerLot] + oneMore.priceCents)}.`;
    }
    return { status: 'impossible', message: 'Aucun panier exact ne respecte le budget.', certificate: explanation, ...amounts };
  }

  let check: string;
  if (missing.length === 1) {
    // With just one unknown, the first stock level admitting ANY affordable basket is decisive.
    const offer = missing[0];
    let lots = 1;
    while (confirmed.costs[requiredUnits - lots * offer.unitsPerLot] + lots * offer.priceCents > budgetCents) lots++;
    check = `Vérifier si « ${offer.label} » a au moins ${lots} lot(s) en stock. Ce seuil suffit pour obtenir exactement ${requiredUnits} pièces dans le budget ; en dessous, c’est impossible.`;
  } else {
    const witness = readAllocation(input, optimistic.choices).filter(row => missing.some(offer => offer.id === row.offerId));
    check = `Une combinaison à ${euros(lower)} devient possible si ces stocks sont confirmés ensemble : ${witness.map(row => `${row.label} (${row.lots} lot(s))`).join(', ')}. D’autres combinaisons peuvent convenir.`;
  }
  return { status: 'unknown', message: 'La réponse dépend du stock disponible.', certificate: check, ...amounts };
}
