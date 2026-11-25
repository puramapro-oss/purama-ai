export type TrialKind = 'panier' | 'media' | 'atelier';

export interface TrialEntry {
  kind: TrialKind | null;
  initialUnits?: number;
  initialBudgetCents?: number;
}

export function sharedTrial(hash: string): TrialKind | null {
  const match = /^#essai\/(panier|media|atelier)$/.exec(hash);
  return match ? match[1] as TrialKind : null;
}

// Use only unambiguous, explicitly named fields. The user can edit every input.
export function trialFromPrompt(prompt: string): TrialEntry {
  const text = prompt.toLocaleLowerCase('fr').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const basket = /\b(?:panier|lots?|pieces?)\b/.test(text);
  const media = /\b(?:videos?|photos?|images?|compression)\b/.test(text);
  const workshop = /\b(?:ateliers?|inscriptions?|participants?|billetterie)\b/.test(text);
  if (Number(basket) + Number(media) + Number(workshop) !== 1) return { kind: null };
  if (!basket) return { kind: media ? 'media' : 'atelier' };
  const entry: TrialEntry = { kind: 'panier' };
  const quantities = [...text.matchAll(/\bexactement\s+(\d{1,5})\s+pieces?\b/g)];
  if (quantities.length === 1) entry.initialUnits = Number(quantities[0][1]);
  const budgets = [...text.matchAll(/\b(?:budget|plafond)\s+(?:(?:maximum|maximal|de)\s+)*(\d{1,7})(?:[,.](\d{1,2}))?\s*(?:€|euros?\b)/g)];
  const localBudget = budgets.length === 1 && !/^\s*(?:par\b|\/|(?:a|ou|minimum)\b|[-–—])/.test(text.slice(budgets[0].index! + budgets[0][0].length));
  if (localBudget) entry.initialBudgetCents = Number(budgets[0][1]) * 100 + Number((budgets[0][2] ?? '').padEnd(2, '0'));
  return entry;
}
