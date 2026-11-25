import { describe, expect, it } from 'vitest';
import { BASKET_TRIAL_LIMITS, solveBasketTrial, type BasketOffer, type BasketTrialInput } from './iao-basket-trial';

const offers: BasketOffer[] = [
  { id: 'a', label: 'A', unitsPerLot: 3, priceCents: 400, stockLots: 'unlimited' },
  { id: 'b', label: 'B', unitsPerLot: 5, priceCents: 600, stockLots: 'unlimited' },
  { id: 'c', label: 'C', unitsPerLot: 8, priceCents: 900, stockLots: 'unlimited' },
];
function basket(stockB: BasketOffer['stockLots'], stockA: BasketOffer['stockLots'] = 'unlimited'): BasketTrialInput {
  return { requiredUnits: 23, budgetCents: 2800, offers: [{ ...offers[0], stockLots: stockA }, { ...offers[1], stockLots: stockB }, offers[2]] };
}

/** Independent enumeration, used only on small generated trials. */
function brute(input: BasketTrialInput, assumeAvailable: boolean): number {
  function visit(index: number, remaining: number): number {
    if (index === input.offers.length) return remaining === 0 ? 0 : Infinity;
    const offer = input.offers[index];
    let max = Math.floor(remaining / offer.unitsPerLot);
    if (typeof offer.stockLots === 'number') max = Math.min(max, offer.stockLots);
    else if (offer.stockLots == null && !assumeAvailable) max = 0;
    let best = Infinity;
    for (let n = 0; n <= max; n++) best = Math.min(best, n * offer.priceCents + visit(index + 1, remaining - n * offer.unitsPerLot));
    return best;
  }
  return visit(0, input.requiredUnits);
}

describe('solveBasketTrial', () => {
  it('reproduces the 23-piece example and returns a purchasable certificate', () => {
    const result = solveBasketTrial(basket('unlimited'));
    expect(result).toMatchObject({ status: 'feasible', minimumCostCents: 2700, totalUnits: 23, totalCostCents: 2700, budgetGapCents: 0 });
    expect(result.allocation.map(({ label, lots }) => [label, lots])).toEqual([['B', 3], ['C', 1]]);
  });
  it('proves the exact gap outside the budget and verifies a possible stock change', () => {
    const result = solveBasketTrial(basket(2));
    expect(result).toMatchObject({ status: 'impossible', minimumCostCents: 2900, totalUnits: 23, budgetGapCents: 100 });
    expect(result.certificate).toContain('supplémentaire de « B »');
    expect(solveBasketTrial(basket(2, 0))).toMatchObject({ status: 'impossible', minimumCostCents: null, allocation: [], budgetGapCents: null });
  });
  it('computes the least stock that changes budget feasibility', () => {
    for (const stock of [null, undefined]) {
      const result = solveBasketTrial(basket(stock));
      expect(result).toMatchObject({ status: 'unknown', lowerBoundCents: 2700, minimumCostCents: null, budgetGapCents: null });
      expect(result.certificate).toContain('au moins 3 lot');
    }
  });
  it('can certify feasibility or impossibility even with unknown stocks', () => {
    const base = basket(null);
    expect(solveBasketTrial({ ...base, budgetCents: 2900 })).toMatchObject({ status: 'feasible', minimumCostCents: null, totalCostCents: 2900, lowerBoundCents: 2700 });
    expect(solveBasketTrial({ ...base, budgetCents: 2600 })).toMatchObject({ status: 'impossible', minimumCostCents: null, lowerBoundCents: 2700 });
    expect(solveBasketTrial({ ...base, offers: [...offers, { ...offers[1], id: 'extra', stockLots: null }] })).toMatchObject({ status: 'feasible', minimumCostCents: 2700 });
    expect(solveBasketTrial(basket(null, null)).certificate).toContain('confirmés ensemble');
  });
  it('handles free lots, zero requirements and empty or exhausted inventories', () => {
    expect(solveBasketTrial({ requiredUnits: 0, budgetCents: 0, offers: [] })).toMatchObject({ status: 'feasible', totalCostCents: 0, allocation: [] });
    const offer = { ...offers[0], priceCents: 0, stockLots: 1 };
    expect(solveBasketTrial({ requiredUnits: 3, budgetCents: 0, offers: [offer] })).toMatchObject({ status: 'feasible', totalCostCents: 0 });
    expect(solveBasketTrial({ requiredUnits: 6, budgetCents: 0, offers: [offer] }).status).toBe('impossible');
    expect(solveBasketTrial({ requiredUnits: 1, budgetCents: 0, offers: [] }).status).toBe('impossible');
  });
  it('reports invalid or out-of-range inputs as unknown', () => {
    for (const input of [
      { ...basket(2), requiredUnits: BASKET_TRIAL_LIMITS.maxUnits + 1 },
      { ...basket(2), budgetCents: 0.5 },
      { ...basket(-1) },
      { ...basket(2), offers: [offers[0], offers[0]] },
      { ...basket(2), offers: [{ ...offers[0], priceCents: NaN }] },
    ]) expect(solveBasketTrial(input)).toMatchObject({ status: 'unknown', minimumCostCents: null, totalUnits: null });
  });
  it('agrees with independent enumeration and reconstructs the exact allocation across 320 generated cases', () => {
    for (let seed = 0; seed < 320; seed++) {
      const input: BasketTrialInput = {
        requiredUnits: seed % 25, budgetCents: seed % 41,
        offers: Array.from({ length: 4 }, (_, i) => ({ id: String(i), label: `Lot ${i}`, unitsPerLot: 1 + ((i + 1) * seed + i) % 8,
          priceCents: (i * 13 + seed * 5) % 17, stockLots: ([undefined, 'unlimited', 0, 1, 2, 3] as const)[(seed + i * 2) % 6] })),
      };
      const low = brute(input, true), high = brute(input, false);
      const result = solveBasketTrial(input);
      expect(result.status).toBe(high <= input.budgetCents ? 'feasible' : low > input.budgetCents ? 'impossible' : 'unknown');
      expect(result.minimumCostCents).toBe(Number.isFinite(high) && high === low ? high : null);
      if (!Number.isFinite(high)) { expect(result.allocation).toEqual([]); continue; }
      expect(result.allocation.reduce((sum, row) => sum + row.units, 0)).toBe(input.requiredUnits);
      expect(result.allocation.reduce((sum, row) => sum + row.costCents, 0)).toBe(high);
      for (const row of result.allocation) {
        const source = input.offers.find(o => o.id === row.offerId)!;
        expect(row.lots <= (typeof source.stockLots === 'number' ? source.stockLots : source.stockLots === 'unlimited' ? Infinity : 0)).toBe(true);
        expect(row.units).toBe(row.lots * source.unitsPerLot);
        expect(row.costCents).toBe(row.lots * source.priceCents);
      }
    }
  });
});
