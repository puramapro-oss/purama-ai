import { useState } from 'react';

const euros = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const money = (cents: number) => euros.format(cents / 100);
const places = (count: number) => `${count} place${count === 1 ? '' : 's'}`;
const paidPlaces = (count: number) => `${places(count)} payante${count === 1 ? '' : 's'}`;

// Bound both amounts and counts so every multiplication fits in a safe integer.
function readCents(text: string) {
  const match = /^(\d{1,7})(?:[.,](\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

function readCount(text: string) {
  const value = text.trim();
  return /^\d{1,6}$/.test(value) ? Number(value) : null;
}

const initial = { fixed: '120', price: '30', variable: '10', capacity: '12', confirmed: '' };
type Field = keyof typeof initial;
const fields: ReadonlyArray<{ key: Field; label: string; money?: boolean }> = [
  { key: 'fixed', label: 'Coûts fixes (€)', money: true },
  { key: 'price', label: 'Recette nette par place payante (€)', money: true },
  { key: 'variable', label: 'Coût par personne présente (€)', money: true },
  { key: 'capacity', label: 'Places disponibles' },
  { key: 'confirmed', label: 'Confirmations uniques déclarées (facultatif)' },
];

function assessWorkshop(fixed: number, price: number, variable: number, capacity: number, confirmed: number | null) {
  const margin = price - variable;
  let conclusion: string;
  let detail: string;
  if (margin < 0) {
    conclusion = 'Chaque présence payante augmente le déficit.';
    detail = `La recette par place est inférieure de ${money(-margin)} au coût par personne.`;
  } else if (fixed === 0) {
    conclusion = 'Seuil de couverture : 0 place payante, car les coûts fixes sont nuls.';
    detail = margin === 0
      ? 'Les coûts fixes sont nuls et chaque place payante couvre exactement son coût.'
      : `Les coûts fixes sont nuls. Chaque place payante apporte ${money(margin)} après son coût.`;
    if (!capacity) conclusion = 'Aucun coût fixe et aucune place disponible.';
  } else if (margin === 0) {
    conclusion = 'Le tarif actuel ne couvre aucun coût fixe.';
    detail = `Même à pleine capacité, il manque ${money(fixed)}.`;
  } else {
    const threshold = Math.ceil(fixed / margin);
    if (threshold > capacity) {
      conclusion = 'La capacité actuelle est insuffisante.';
      detail = `${paidPlaces(threshold)} nécessaires. Il manque ${places(threshold - capacity)} à ce tarif.`;
    } else {
      conclusion = `Seuil de couverture : ${paidPlaces(threshold)}.`;
      detail = confirmed === null
        ? 'Renseignez les confirmations déjà reçues pour estimer les places restant à remplir.'
        : confirmed >= threshold
          ? 'Le seuil serait atteint si chaque personne confirmée venait et payait.'
          : `Il faudrait encore ${paidPlaces(threshold - confirmed)} si toutes les confirmations devenaient des présences payantes.`;
    }
  }

  const projected = confirmed === null ? null : confirmed * margin - fixed;
  const draft = [
    'Préinscription à un atelier',
    'Date et lieu proposés : [à compléter].',
    `Nombre de places : ${capacity}.`,
    'Tarif public par personne : [à compléter].',
    'Souhaitez-vous participer ? Merci de confirmer une seule fois avant le [date].',
    'Cette préinscription exprime votre intention de venir. Le règlement sera proposé séparément.',
  ].join('\n');
  return { conclusion, detail, projected, draft, minPrice: capacity ? variable + Math.ceil(fixed / capacity) : null };
}

export function IaoWorkshopTrial() {
  const [values, setValues] = useState(initial);
  const fixed = readCents(values.fixed);
  const price = readCents(values.price);
  const variable = readCents(values.variable);
  const capacity = readCount(values.capacity);
  const confirmed = readCount(values.confirmed);
  const parsed = { fixed, price, variable, capacity, confirmed };
  const invalid = (key: Field) => key === 'confirmed'
    ? (values.confirmed.trim() !== '' && confirmed === null) ||
      (confirmed !== null && capacity !== null && confirmed > capacity)
    : parsed[key] === null;

  const ready = fixed !== null && price !== null && variable !== null && capacity !== null && !invalid('confirmed');
  const result = ready ? assessWorkshop(fixed, price, variable, capacity, confirmed) : null;
  const tooMany = capacity !== null && confirmed !== null && confirmed > capacity;
  return <div className="min-w-0 space-y-4 text-sm">
    <p className="text-muted-foreground">Ajustez les chiffres de cet exemple. Chaque personne présente occupe une place et paie une fois dans cette projection.</p>
    <div className="grid gap-3">
      {fields.map(field => <label key={field.key} className="grid gap-1 text-sm font-medium">
        {field.label}
        <input type="text" inputMode={field.money ? 'decimal' : 'numeric'} autoComplete="off"
          value={values[field.key]} aria-invalid={invalid(field.key)}
          onChange={event => setValues({ ...values, [field.key]: event.target.value })}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-base text-foreground focus-visible:outline focus-visible:outline-primary" />
      </label>)}
    </div>
    <div role="status" aria-live="polite" aria-atomic="true" className="space-y-2">
      {result ? <>
        <p className="font-semibold">{result.conclusion}</p>
        <p>{result.detail}</p>
        {result.projected !== null && <p>Avec {places(confirmed!)} honorées et payées, le solde après coûts serait de <strong>{money(result.projected)}</strong>.</p>}
        {result.minPrice !== null && <p>À salle pleine, la recette nette minimale par place est de <strong>{money(result.minPrice)}</strong>.</p>}
        <p className="text-xs text-muted-foreground">Les confirmations sont déclarées par l’organisateur. Les présences et encaissements restent à constater.</p>
      </> : <p>{tooMany ? 'Les confirmations dépassent la capacité. Comptez uniquement les places confirmées, hors liste d’attente.'
        : 'Vérifiez les champs signalés. Les montants acceptent de 0 à 9 999 999,99 € et deux décimales au maximum. Les effectifs sont des entiers de 0 à 999 999.'}</p>}
    </div>
    {result && capacity > 0 && <details>
      <summary className="cursor-pointer font-medium text-primary">Préparer la préinscription</summary>
      <p className="mt-2 whitespace-pre-line rounded-md bg-muted p-3">{result.draft}</p>
      <a className="mt-3 inline-block text-primary underline" href={`data:text/plain;charset=utf-8,${encodeURIComponent(result.draft)}`}
        download="preinscription-atelier.txt">Télécharger le brouillon (.txt)</a>
    </details>}
  </div>;
}
