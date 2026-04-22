// ─── Purama · Palette Generator (déterministe par seed) ─────────────────
// Même seed → même palette à vie. Utilisé par <PuramaBackground />.
//
// Format seed : '<mood>[-<modifier>]-<slug>'
// Exemples :
//  · 'tech-cyber-purama-ai'
//  · 'trading-gold-premium-midas'
//  · 'wellness-calm-soft-vida'

import {
  PURAMA_MOODS, SHADER_VARIANTS,
  type PuramaMood, type MoodDefinition, type ShaderType, type ShaderVariant,
} from './purama-adn';

export interface GeneratedPalette {
  seed: string;
  mood: PuramaMood;
  modifier: string | null;
  keyword: string;
  colors: [string, string, string, string];
  colorBack: string;
  shader: ShaderType;
  distortion: number;
  swirl: number;
  speed: number;
}

// xmur3 hash → produces a seeded PRNG
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function hslToHex(h: number, s: number, l: number): string {
  l /= 100;
  const a = (s * Math.min(l, 1 - l)) / 100;
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function pickInRange(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

function pickHue(rng: () => number, range: [number, number]): number {
  const [min, max] = range;
  if (min > max) {
    const total = (360 - min) + max;
    return (min + rng() * total) % 360;
  }
  return pickInRange(rng, min, max);
}

function parseSeed(seed: string): { mood: PuramaMood; modifier: string | null; keyword: string } {
  const parts = seed.toLowerCase().trim().split('-');
  if (parts.length < 3) return { mood: 'tech-cyber', modifier: null, keyword: seed };
  const moodKeys = Object.keys(PURAMA_MOODS) as PuramaMood[];
  const twoTokens = `${parts[0]}-${parts[1]}`;
  let foundMood: PuramaMood = 'tech-cyber';
  let remaining = parts;
  if (moodKeys.includes(twoTokens as PuramaMood)) {
    foundMood = twoTokens as PuramaMood;
    remaining = parts.slice(2);
  } else if (moodKeys.includes(parts[0] as PuramaMood)) {
    foundMood = parts[0] as PuramaMood;
    remaining = parts.slice(1);
  }
  const moodDef = PURAMA_MOODS[foundMood];
  const mods = Object.keys(moodDef.modifiers);
  let modifier: string | null = null;
  if (remaining.length > 1 && mods.includes(remaining[0])) {
    modifier = remaining[0];
    remaining = remaining.slice(1);
  }
  return { mood: foundMood, modifier, keyword: remaining.join('-') || 'default' };
}

function mergeDefs(base: MoodDefinition, over?: Partial<MoodDefinition>): MoodDefinition {
  if (!over) return base;
  return { ...base, ...over, modifiers: base.modifiers };
}

export function generatePalette(seed: string, variant: ShaderVariant = 'hero'): GeneratedPalette {
  const parsed = parseSeed(seed);
  const baseMood = PURAMA_MOODS[parsed.mood];
  const modOver = parsed.modifier ? baseMood.modifiers[parsed.modifier] : undefined;
  const def = mergeDefs(baseMood, modOver);
  const rng = xmur3(seed);

  const colors = def.hueRanges.map((r) => {
    const h = pickHue(rng, r);
    const s = pickInRange(rng, def.saturation[0], def.saturation[1]);
    const l = pickInRange(rng, def.lightness[0], def.lightness[1]);
    return hslToHex(h, s, l);
  }) as [string, string, string, string];

  const [bh, bs, bl] = def.colorBackHSL;
  const colorBack = hslToHex(bh, bs, bl);

  const vm = SHADER_VARIANTS[variant];
  return {
    seed, mood: parsed.mood, modifier: parsed.modifier, keyword: parsed.keyword,
    colors, colorBack, shader: def.shader,
    distortion: clamp(pickInRange(rng, def.distortion[0], def.distortion[1]) * vm.distortionMult, 0, 2),
    swirl: clamp(pickInRange(rng, def.swirl[0], def.swirl[1]) * vm.swirlMult, 0, 2),
    speed: clamp(pickInRange(rng, def.speed[0], def.speed[1]) * vm.speedMult, 0, 1),
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// Cache (même seed+variant = même palette, évite les recalculs)
const cache = new Map<string, GeneratedPalette>();
export function getPalette(seed: string, variant: ShaderVariant = 'hero'): GeneratedPalette {
  const k = `${seed}::${variant}`;
  const cached = cache.get(k);
  if (cached) return cached;
  const palette = generatePalette(seed, variant);
  cache.set(k, palette);
  return palette;
}
