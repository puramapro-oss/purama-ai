type ModelInput = 'lengthMeters' | 'angleDegrees' | 'bobMassGrams' | 'seed' | 'samples';
export type PendulumInputs = Partial<Record<ModelInput, number>>;
export type ScienceEntry =
  | { kind: 'pendule'; inputs: PendulumInputs; answer: string }
  | { kind: 'unsupported' | 'correlation'; answer: string };
export type ScienceHandoff = 'projet' | 'correlation';

const units = {
  lengthMeters: { min: 0.1, max: 1.5, label: 'longueur (m)' },
  angleDegrees: { min: 1, max: 30, label: 'angle (°)' },
  bobMassGrams: { min: 1, max: 100, label: 'masse (g)' },
  seed: { min: 0, max: 4294967295, label: 'graine' },
  samples: { min: 1, max: 20000, label: 'tirages' },
} as const;

const unavailable = 'Aucun calcul lancé pour cette demande. L’atelier de mécanique couvre un pendule simple, entre 10 et 150 cm, avec un angle de 1 à 30° et une masse de 1 à 100 g.';
const unclear = 'Je ne peux pas reprendre tous ces réglages dans le modèle du pendule simple. Précisez une seule longueur, un angle et une masse, avec leurs unités, ou ouvrez l’essai pour les saisir. Aucun calcul lancé.';
const number = '([+-]?\\d+(?:[.,]\\d+)?)';
const quantity = new RegExp('(?:(longueur|angle|amplitude|masse)(?:\\s+initiale?)?\\s*(?:(?:de|d[’\'])\\s*|[=:]\\s*)?)?' + number + '\\s*(millimetres?|centimetres?|metres?|milligrammes?|kilogrammes?|grammes?|degres?|mm|cm|kg|mg|m|g|rad(?:ians?)?|°)(?![a-z])', 'g');
const seed = new RegExp('\\bgraine\\s*(?:de\\s+|[=:]\\s*)?' + number, 'g');
const samples = new RegExp(number + '\\s*(?:tirages?|echantillons?)\\b', 'g');

function valid(key: ModelInput, value: number) {
  const { min, max } = units[key];
  return Number.isFinite(value) && value >= min && value <= max &&
    ((key !== 'samples' && key !== 'seed') || Number.isInteger(value));
}

export function scienceFromPrompt(prompt: string): ScienceEntry | null {
  const text = prompt.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\b(peux|pouvez)-(tu|vous)\b/g, '$1 $2').trim();
  const action = /\b(?:simule(?:r|z)?|simulation|modelise(?:r|z)?|teste(?:r|z)?|essai|essaie|experience|lance(?:r|z)?|ouvre|ouvrir|visualise(?:r|z)?)\b/;
  if (/\b(?:ne|pas|jamais|explique|signifie|definition)\b/.test(text)) return null;
  if (/\b(?:correle(?:r|z)?|compar(?:e[rz]?|aison)|calcul(?:e[rz]?)?|mesure[rz]?|analyse[rz]?|test(?:e[rz]?)?)\b/.test(text) &&
    /\b(?:correlation|deux series (?:numeriques|de (?:mesures|nombres|donnees)))\b/.test(text))
    return { kind: 'correlation', answer: 'L’atelier de corrélation compare deux séries numériques appariées. Ouvrez-le pour saisir vos valeurs et calculer leur association.' };
  if (!action.test(text)) return null;
  if (!/\bpendules?\b/.test(text)) {
    // Commercial and creative requests continue through the existing chat.
    return /\b(?:(?:simulations?|experiences?|modeles?|phenomenes?|essais?)\s+(?:scientifiques?|physiques?|chimiques?|mecaniques?|biologiques?)|reactions?\s+chimiques?|eclipses?|oscillat(?:eur|ion)s?|thermodynamique|gravitation|molecules?)\b/.test(text)
      ? { kind: 'unsupported', answer: unavailable } : null;
  }
  if (/\bpendule physique\b|\b(?:double|multiple|couple|conique|balistique|inversee?|frottements?|amorti[s]?|elastique|ressort|foucault|magnetique|compose|chaotique)\b/.test(text))
    return { kind: 'unsupported', answer: unavailable };

  const inputs: PendulumInputs = {};
  let invalid = false;
  function capture(key: ModelInput, raw: string, divisor = 1) {
    const value = Number(raw.replace(',', '.')) / divisor;
    if (!valid(key, value) || key in inputs) invalid = true;
    inputs[key] = value;
    return ' ';
  }
  const remaining = text.replace(seed, (_, raw: string) => capture('seed', raw))
    .replace(samples, (_, raw: string) => capture('samples', raw))
    .replace(quantity, (_, field: string | undefined, raw: string, unit: string) => {
      let key: ModelInput;
      let divisor = 1;
      if (unit === '°' || unit.startsWith('degre')) key = 'angleDegrees';
      else if (/^(?:mg|g|kg|(?:milli|kilo)?grammes?)$/.test(unit)) {
        key = 'bobMassGrams';
        divisor = /^(?:mg|milli)/.test(unit) ? 1000 : /^(?:kg|kilo)/.test(unit) ? 0.001 : 1;
      } else if (unit.startsWith('rad')) { invalid = true; return ' '; }
      else {
        key = 'lengthMeters';
        divisor = /^(?:mm|milli)/.test(unit) ? 1000 : /^(?:cm|centi)/.test(unit) ? 100 : 1;
      }
      const fieldKey = field === 'longueur' ? 'lengthMeters' : field === 'masse' ? 'bobMassGrams' : 'angleDegrees';
      if (field && fieldKey !== key) invalid = true;
      return capture(key, raw, divisor);
    });
  // Only a bounded vocabulary may launch the model. Unknown physics, named environments,
  // duplicate measurements and unparsed values must never silently select defaults.
  const extra = remaining.replace(/\b(?:simule(?:r|z)?|simulation|modelise(?:r|z)?|teste(?:r|z)?|essai|essaie|experience|scientifique|physique|lance(?:r|z)?|ouvre|ouvrir|visualise(?:r|z)?|pendule|simple|ideal|un|une|le|la|les|l|d|du|de|des|au|avec|et|a|en|pour|moi|mon|ma|son|sa|long|mouvement|oscillation|s|il|vous|te|plait|peux|tu|pouvez|lancer|modele|atelier|3d)\b/g, ' ').replace(/[\s,.:;?!'’=]/g, '');
  if (invalid || extra || /\b(?:ou|entre|environ)\b/.test(text)) return { kind: 'unsupported', answer: unclear };
  const values = (Object.keys(units) as ModelInput[]).filter(key => inputs[key] !== undefined)
    .map(key => units[key].label + ' ' + String(inputs[key]).replace('.', ','));
  return { kind: 'pendule', inputs,
    answer: 'Atelier du pendule simple. ' + (values.length ? 'Réglages transmis : ' + values.join(', ') + '.' : 'Les réglages de départ sont modifiables.')
      + ' Le rapport distingue la prévision du modèle et vos mesures réelles.' };
}

function oneUrl(configuredOrigin: string | undefined, path: 'pendule' | ScienceHandoff): URL | null {
  if (!configuredOrigin) return null;
  try {
    const url = new URL(configuredOrigin);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' ||
      url.search || url.hash || ![url.origin, url.origin + '/'].includes(configuredOrigin)) return null;
    url.pathname = '/atelier-spatial/' + path;
    return url;
  } catch { return null; }
}

export function scienceHandoffUrl(configuredOrigin: string | undefined, handoff: ScienceHandoff) {
  return oneUrl(configuredOrigin, handoff);
}

export function pendulumUrl(configuredOrigin: string | undefined, inputs: PendulumInputs): URL | null {
  const url = oneUrl(configuredOrigin, 'pendule');
  if (!url) return null;
  for (const key of Object.keys(units) as ModelInput[]) {
    const value = inputs[key];
    if (value !== undefined) {
      if (!valid(key, value)) return null;
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

export interface PendulumReceipt {
  modelId: string;
  periodSeconds: number;
  trials: number;
  measuredPeriodSeconds: number | null;
}

export function readPendulumReceipt(data: unknown): PendulumReceipt | null {
  if (!data || typeof data !== 'object' || !('type' in data) || data.type !== 'purama:pendulum:result:v1' ||
    !('report' in data) || !data.report || typeof data.report !== 'object') return null;
  const { modelId, periodSeconds, trials, measuredPeriodSeconds } = data.report as Record<string, unknown>;
  if (typeof modelId !== 'string' || !/^[A-Za-z0-9._/-]{1,80}$/.test(modelId) ||
    typeof periodSeconds !== 'number' || !Number.isFinite(periodSeconds) || periodSeconds <= 0 ||
    typeof trials !== 'number' || !valid('samples', trials)) return null;
  if (measuredPeriodSeconds != null && (typeof measuredPeriodSeconds !== 'number' ||
    !Number.isFinite(measuredPeriodSeconds) || measuredPeriodSeconds <= 0)) return null;
  return { modelId, periodSeconds, trials, measuredPeriodSeconds: typeof measuredPeriodSeconds === 'number' ? measuredPeriodSeconds : null };
}
