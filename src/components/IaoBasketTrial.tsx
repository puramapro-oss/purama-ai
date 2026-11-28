import { useMemo, useRef, useState } from 'react';
import {
  BASKET_TRIAL_LIMITS, solveBasketTrial, type BasketOffer, type BasketTrialResult,
} from '@/lib/iao-basket-trial';

type StockMode = 'known' | 'unknown' | 'unlimited';
type OfferDraft = {
  id: string; label: string; units: string; price: string; stockMode: StockMode; stock: string;
};

const example: OfferDraft[] = [
  { id: 'a', label: 'A', units: '3', price: '4', stockMode: 'unlimited', stock: '' },
  { id: 'b', label: 'B', units: '5', price: '6', stockMode: 'unlimited', stock: '' },
  { id: 'c', label: 'C', units: '8', price: '9', stockMode: 'unlimited', stock: '' },
];
const euros = new Intl.NumberFormat('fr-FR', {
  style: 'currency', currency: 'EUR', minimumFractionDigits: 0, maximumFractionDigits: 2,
});
const money = (cents: number) => euros.format(cents / 100);
const inputClass = 'mt-1 block w-full min-w-0 rounded-md border border-input bg-background px-2 py-2 text-sm text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary';
const actionClass = 'rounded-md border border-input px-3 py-2 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary';
const summaryClass = 'cursor-pointer rounded text-sm font-medium underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary';

function natural(value: string): number | null {
  const clean = value.trim();
  if (!/^\d+$/.test(clean)) return null;
  const number = Number(clean);
  return Number.isSafeInteger(number) ? number : null;
}

function cents(value: string): number | null {
  const clean = value.trim().replace(',', '.');
  if (!/^(?:\d+|\d*\.\d{1,2})$/.test(clean)) return null;
  const [whole, fraction = ''] = clean.split('.');
  return natural(whole + fraction.padEnd(2, '0'));
}

function readOffers(drafts: OfferDraft[]): { offers: BasketOffer[]; error?: never } | { error: string; offers?: never } {
  const offers: BasketOffer[] = [];
  for (const [index, draft] of drafts.entries()) {
    const label = draft.label.trim();
    const unitsPerLot = natural(draft.units);
    const priceCents = cents(draft.price);
    const stockLots = draft.stockMode === 'known' ? natural(draft.stock) : draft.stockMode === 'unlimited' ? 'unlimited' : null;
    if (!label) return { error: `Donnez un nom au lot n° ${index + 1}.` };
    if (unitsPerLot === null || unitsPerLot < 1) return { error: `Lot ${label} : indiquez un nombre entier de pièces supérieur à zéro.` };
    if (priceCents === null || priceCents > BASKET_TRIAL_LIMITS.maxPriceCents) {
      return { error: `Lot ${label} : saisissez un prix de 0 à ${money(BASKET_TRIAL_LIMITS.maxPriceCents)}, avec deux décimales au maximum.` };
    }
    if (draft.stockMode === 'known' && stockLots === null) {
      return { error: `Lot ${label} : indiquez un stock entier, ou choisissez « Inconnu ».` };
    }
    offers.push({ id: draft.id, label, unitsPerLot, priceCents, stockLots });
  }
  return { offers };
}

function BasketReceipt({ result }: { result: BasketTrialResult }) {
  return <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3 text-sm">
    <p role="status" className="font-medium">{result.message}</p>
    {result.status !== 'feasible' && result.totalCostCents !== null && result.allocation.length > 0 &&
      <p>Panier de référence hors budget : <strong>{money(result.totalCostCents)}</strong>.</p>}
    {result.allocation.length > 0 && <ul className="space-y-1">{result.allocation.map(line =>
      <li key={line.offerId} className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="break-all">{line.lots} × {line.label} · {line.units} pièces</span>
        <span className="tabular-nums">{money(line.costCents)}</span>
      </li>,
    )}</ul>}
    {result.budgetGapCents !== null && result.budgetGapCents > 0 && result.minimumCostCents !== null &&
      <p>Avec le stock indiqué, il manque <strong>{money(result.budgetGapCents)}</strong> au budget.</p>}
    {result.status === 'unknown' ? <p>{result.certificate}</p> : <details>
      <summary className={summaryClass}>Voir la preuve du calcul</summary>
      <p className="mt-2 text-xs text-muted-foreground">{result.certificate}</p>
    </details>}
  </div>;
}

function budgetInput(cents: number) {
  if (!Number.isSafeInteger(cents) || cents < 0) return '';
  const digits = String(cents).padStart(3, '0');
  const fraction = digits.slice(-2);
  return digits.slice(0, -2) + (fraction === '00' ? '' : ',' + fraction);
}

export function IaoBasketTrial({ initialUnits = 23, initialBudgetCents = 2800 }: {
  initialUnits?: number; initialBudgetCents?: number;
} = {}) {
  const [drafts, setDrafts] = useState(example);
  const [quantity, setQuantity] = useState(() => String(initialUnits));
  const [budget, setBudget] = useState(() => budgetInput(initialBudgetCents));
  const [compare, setCompare] = useState(false);
  const [scenarioId, setScenarioId] = useState('b');
  const [scenarioStock, setScenarioStock] = useState('2');
  const [scenarioBudget, setScenarioBudget] = useState(() => budgetInput(initialBudgetCents));
  const nextId = useRef(1);
  const parsed = useMemo(() => readOffers(drafts), [drafts]);
  const requiredUnits = natural(quantity);
  const budgetCents = cents(budget);
  const quantityValid = requiredUnits !== null && requiredUnits <= BASKET_TRIAL_LIMITS.maxUnits;
  const problem = !quantityValid ? `Indiquez une quantité entière entre 0 et ${BASKET_TRIAL_LIMITS.maxUnits} pièces.`
    : budgetCents === null ? 'Saisissez un budget positif ou nul en euros, avec deux décimales au maximum.' : parsed.error;
  const reference = useMemo(() => {
    if (!quantityValid || requiredUnits === null || budgetCents === null || !parsed.offers) return null;
    return solveBasketTrial({ requiredUnits, budgetCents, offers: parsed.offers });
  }, [quantityValid, requiredUnits, budgetCents, parsed]);
  const selected = drafts.find(draft => draft.id === scenarioId) ?? drafts[0];
  const stock = natural(scenarioStock);
  const revisedBudget = cents(scenarioBudget);
  const revised = useMemo(() => {
    if (!compare || !reference || !selected || !parsed.offers || requiredUnits === null || stock === null || revisedBudget === null) return null;
    const evaluateStock = (stockLots: number) => solveBasketTrial({
      requiredUnits, budgetCents: revisedBudget,
      offers: parsed.offers.map(offer => offer.id === selected.id ? { ...offer, stockLots } : offer),
    });
    const result = evaluateStock(stock);
    const extra = result.status === 'impossible' && stock < Number.MAX_SAFE_INTEGER ? evaluateStock(stock + 1) : null;
    return { result, extra };
  }, [compare, reference, selected, parsed, requiredUnits, stock, revisedBudget]);

  function change(id: string, patch: Partial<OfferDraft>) {
    setDrafts(current => current.map(row => row.id === id ? { ...row, ...patch } : row));
  }

  function addOffer() {
    const id = `user-${nextId.current++}`;
    setDrafts(current => [...current, { id, label: '', units: '', price: '', stockMode: 'unknown', stock: '' }]);
  }

  return <section aria-label="Essai de panier exact" className="space-y-3 text-sm">
    <p className="text-muted-foreground">Cherchez le panier le moins cher pour une quantité exacte. Les trois lots de départ sont un exemple modifiable.</p>
    <div className="grid grid-cols-2 gap-3">
      <label>Pièces souhaitées
        <input className={inputClass} inputMode="numeric" value={quantity} aria-invalid={!quantityValid}
          onChange={event => setQuantity(event.target.value)} />
      </label>
      <label>Budget maximal (€)
        <input className={inputClass} inputMode="decimal" value={budget} aria-invalid={budgetCents === null}
          onChange={event => setBudget(event.target.value)} />
      </label>
    </div>
    <details className="rounded-lg border border-border p-3">
      <summary className={summaryClass}>Modifier les lots et les stocks</summary>
      <div className="mt-3 space-y-3">{drafts.map((row, index) => <fieldset key={row.id} className="rounded-md border border-border p-2">
        <legend className="px-1 text-xs font-medium">Lot {row.label.trim() || index + 1}</legend>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <label>Nom du lot
            <input className={inputClass} value={row.label} maxLength={80} onChange={event => change(row.id, { label: event.target.value })} />
          </label>
          <label>Pièces par lot
            <input className={inputClass} inputMode="numeric" value={row.units} onChange={event => change(row.id, { units: event.target.value })} />
          </label>
          <label>Prix du lot (€)
            <input className={inputClass} inputMode="decimal" value={row.price} onChange={event => change(row.id, { price: event.target.value })} />
          </label>
          <label>État du stock
            <select className={inputClass} value={row.stockMode}
              onChange={event => change(row.id, { stockMode: event.target.value as StockMode })}>
              <option value="known">Quantité connue</option>
              <option value="unknown">Inconnu</option>
              <option value="unlimited">Illimité</option>
            </select>
          </label>
          {row.stockMode === 'known' && <label>Lots disponibles
            <input className={inputClass} inputMode="numeric" value={row.stock} onChange={event => change(row.id, { stock: event.target.value })} />
          </label>}
        </div>
        <button type="button" className="mt-2 py-1 text-xs text-muted-foreground underline"
          aria-label={`Retirer le lot ${row.label || index + 1}`} onClick={() => setDrafts(current => current.filter(item => item.id !== row.id))}>
          Retirer ce lot
        </button>
      </fieldset>)}</div>
      <button type="button" className={`mt-3 ${actionClass}`} onClick={addOffer} disabled={drafts.length >= BASKET_TRIAL_LIMITS.maxOffers}>
        Ajouter un lot
      </button>
    </details>
    {problem && <p role="alert" className="text-sm text-destructive">{problem}</p>}
    {reference && <BasketReceipt result={reference} />}
    {drafts.length > 0 && <button type="button" aria-expanded={compare} className={actionClass} onClick={() => setCompare(current => !current)}>
      Et si ça change ?
    </button>}
    {compare && selected && <fieldset className="space-y-3 rounded-lg border border-border p-3">
      <legend className="px-1 font-medium">Comparer une autre hypothèse</legend>
      <label className="block">Lot à vérifier
        <select className={inputClass} value={selected.id} onChange={event => setScenarioId(event.target.value)}>
          {drafts.map((row, index) => <option key={row.id} value={row.id}>{row.label || `Lot n° ${index + 1}`}</option>)}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label>Stock supposé (lots)
          <input className={inputClass} inputMode="numeric" value={scenarioStock} aria-invalid={stock === null}
            onChange={event => setScenarioStock(event.target.value)} />
        </label>
        <label>Budget supposé (€)
          <input className={inputClass} inputMode="decimal" value={scenarioBudget} aria-invalid={revisedBudget === null}
            onChange={event => setScenarioBudget(event.target.value)} />
        </label>
      </div>
      {stock === null && <p role="alert">Indiquez un stock entier positif ou nul.</p>}
      {revisedBudget === null && <p role="alert">Indiquez un budget en euros avec deux décimales au maximum.</p>}
      {revised && <BasketReceipt result={revised.result} />}
      {revised?.extra?.status === 'feasible' && revised.extra.totalCostCents !== null &&
        <p className="text-sm">Si un lot {selected.label} supplémentaire est disponible, un panier à <strong>{money(revised.extra.totalCostCents)}</strong> respecte ce budget.</p>}
    </fieldset>}
  </section>;
}
