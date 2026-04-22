// ─── Purama ADN · 12 moods canoniques (PURAMA_MASTER_UPGRADE V1) ─────────
// Chaque app Purama choisit UN mood dans son BRIEF.md via la directive
// `palette_seed`. Les paramètres ci-dessous guident la génération
// déterministe de la palette (4 couleurs) + du shader de fond.

export type PuramaMood =
  | 'trading-gold'
  | 'wellness-calm'
  | 'tech-cyber'
  | 'spiritual-divine'
  | 'finance-premium'
  | 'nature-earth'
  | 'energy-fire'
  | 'water-ocean'
  | 'cosmic-aether'
  | 'warmth-community'
  | 'light-clarity'
  | 'shadow-depth';

export type ShaderType = 'mesh' | 'rays' | 'liquid' | 'water' | 'voronoi' | 'orbit';
export type ShaderVariant = 'hero' | 'ambient' | 'celebrate' | 'focus';

export interface MoodDefinition {
  name: string;
  description: string;
  hueRanges: Array<[number, number]>;
  saturation: [number, number];
  lightness: [number, number];
  colorBackHSL: [number, number, number];
  shader: ShaderType;
  distortion: [number, number];
  swirl: [number, number];
  speed: [number, number];
  modifiers: Record<string, Partial<MoodDefinition>>;
}

export const PURAMA_MOODS: Record<PuramaMood, MoodDefinition> = {
  'trading-gold': {
    name: 'Trading Gold', description: 'Finance, trading, richesse',
    hueRanges: [[40, 55], [0, 15], [140, 170], [200, 220]],
    saturation: [60, 95], lightness: [8, 70], colorBackHSL: [0, 0, 4],
    shader: 'mesh', distortion: [0.9, 1.2], swirl: [0.6, 0.8], speed: [0.15, 0.22],
    modifiers: {
      premium: { saturation: [70, 90], speed: [0.12, 0.18] },
      intense: { distortion: [1.2, 1.5], speed: [0.22, 0.3] },
    },
  },
  'wellness-calm': {
    name: 'Wellness Calm', description: 'Santé naturelle, méditation',
    hueRanges: [[140, 170], [40, 60], [25, 40], [60, 90]],
    saturation: [35, 70], lightness: [50, 88], colorBackHSL: [150, 40, 20],
    shader: 'mesh', distortion: [0.4, 0.7], swirl: [0.3, 0.5], speed: [0.05, 0.10],
    modifiers: {
      soft: { saturation: [25, 50], speed: [0.03, 0.07] },
      natural: { hueRanges: [[80, 120], [40, 60], [20, 40], [340, 360]] },
    },
  },
  'tech-cyber': {
    name: 'Tech Cyber', description: 'IA, code, futurisme',
    hueRanges: [[220, 260], [180, 200], [280, 320], [0, 10]],
    saturation: [70, 100], lightness: [5, 65], colorBackHSL: [230, 60, 5],
    shader: 'mesh', distortion: [0.9, 1.3], swirl: [0.7, 1.0], speed: [0.18, 0.28],
    modifiers: {
      neon: { saturation: [85, 100], lightness: [40, 70] },
      dark: { lightness: [5, 35], colorBackHSL: [230, 80, 3] },
    },
  },
  'spiritual-divine': {
    name: 'Spiritual Divine', description: 'Sagesse, sacré, conscience',
    hueRanges: [[260, 285], [40, 55], [0, 10], [220, 240]],
    saturation: [50, 90], lightness: [20, 90], colorBackHSL: [250, 50, 12],
    shader: 'mesh', distortion: [0.8, 1.1], swirl: [0.6, 0.8], speed: [0.10, 0.18],
    modifiers: {
      divine: { saturation: [60, 90], lightness: [40, 85] },
      mystic: { shader: 'voronoi', distortion: [1.0, 1.4] },
    },
  },
  'finance-premium': {
    name: 'Finance Premium', description: 'Institutionnel, autorité',
    hueRanges: [[210, 230], [40, 55], [0, 10], [215, 230]],
    saturation: [30, 75], lightness: [15, 85], colorBackHSL: [220, 40, 10],
    shader: 'mesh', distortion: [0.5, 0.8], swirl: [0.4, 0.6], speed: [0.08, 0.14],
    modifiers: {
      premium: { saturation: [40, 70], speed: [0.06, 0.12] },
      luxury: { hueRanges: [[210, 225], [35, 50], [0, 10], [30, 45]] },
    },
  },
  'nature-earth': {
    name: 'Nature Earth', description: 'Écologie, terre, organique',
    hueRanges: [[90, 140], [20, 40], [40, 60], [15, 35]],
    saturation: [40, 75], lightness: [20, 75], colorBackHSL: [30, 20, 12],
    shader: 'mesh', distortion: [0.6, 0.9], swirl: [0.4, 0.6], speed: [0.07, 0.12],
    modifiers: {
      forest: { hueRanges: [[100, 140], [80, 100], [30, 50], [0, 20]] },
      desert: { hueRanges: [[25, 45], [10, 25], [40, 55], [350, 15]] },
    },
  },
  'energy-fire': {
    name: 'Energy Fire', description: 'Action, sport, RPG',
    hueRanges: [[0, 15], [30, 50], [0, 10], [15, 35]],
    saturation: [70, 100], lightness: [10, 65], colorBackHSL: [15, 30, 8],
    shader: 'liquid', distortion: [1.2, 1.6], swirl: [0.9, 1.3], speed: [0.20, 0.32],
    modifiers: {
      epic: { distortion: [1.4, 1.8], speed: [0.25, 0.35] },
      sport: { hueRanges: [[0, 15], [30, 45], [200, 220], [0, 10]] },
    },
  },
  'water-ocean': {
    name: 'Water Ocean', description: 'Fluidité, respiration',
    hueRanges: [[190, 220], [170, 185], [0, 10], [200, 230]],
    saturation: [40, 85], lightness: [30, 88], colorBackHSL: [205, 80, 12],
    shader: 'water', distortion: [0.4, 0.7], swirl: [0.3, 0.5], speed: [0.04, 0.09],
    modifiers: {
      deep: { lightness: [15, 55], colorBackHSL: [215, 85, 8] },
      tropical: { hueRanges: [[170, 195], [155, 175], [40, 60], [195, 215]] },
    },
  },
  'cosmic-aether': {
    name: 'Cosmic Aether', description: 'Mystique, espace, éther',
    hueRanges: [[260, 295], [0, 10], [275, 310], [220, 250]],
    saturation: [40, 85], lightness: [15, 85], colorBackHSL: [255, 60, 8],
    shader: 'voronoi', distortion: [1.0, 1.4], swirl: [0.8, 1.1], speed: [0.15, 0.22],
    modifiers: {
      stardust: { shader: 'orbit' },
      nebula: { saturation: [60, 95], distortion: [1.2, 1.6] },
    },
  },
  'warmth-community': {
    name: 'Warmth Community', description: 'Social, association, humain',
    hueRanges: [[20, 40], [40, 55], [330, 355], [30, 50]],
    saturation: [50, 85], lightness: [55, 92], colorBackHSL: [20, 55, 18],
    shader: 'mesh', distortion: [0.7, 1.0], swirl: [0.5, 0.7], speed: [0.10, 0.16],
    modifiers: { festive: { saturation: [65, 95], speed: [0.15, 0.22] } },
  },
  'light-clarity': {
    name: 'Light Clarity', description: 'Clarté, lumière, transparence',
    hueRanges: [[45, 60], [0, 10], [40, 55], [0, 5]],
    saturation: [15, 75], lightness: [65, 98], colorBackHSL: [50, 50, 92],
    shader: 'rays', distortion: [0.5, 0.8], swirl: [0.3, 0.5], speed: [0.08, 0.13],
    modifiers: { solar: { shader: 'rays', saturation: [70, 95] } },
  },
  'shadow-depth': {
    name: 'Shadow Depth', description: 'Nocturne, premium sombre',
    hueRanges: [[0, 5], [220, 240], [0, 10], [260, 280]],
    saturation: [20, 70], lightness: [3, 60], colorBackHSL: [230, 30, 4],
    shader: 'mesh', distortion: [0.7, 1.0], swirl: [0.5, 0.7], speed: [0.08, 0.14],
    modifiers: { midnight: { lightness: [2, 35], saturation: [30, 80] } },
  },
};

export const SHADER_VARIANTS: Record<ShaderVariant, { distortionMult: number; swirlMult: number; speedMult: number }> = {
  hero:       { distortionMult: 1.1, swirlMult: 1.1, speedMult: 1.2 },
  ambient:    { distortionMult: 0.5, swirlMult: 0.5, speedMult: 0.3 },
  celebrate:  { distortionMult: 1.3, swirlMult: 1.4, speedMult: 1.6 },
  focus:      { distortionMult: 0.3, swirlMult: 0.3, speedMult: 0.2 },
};
